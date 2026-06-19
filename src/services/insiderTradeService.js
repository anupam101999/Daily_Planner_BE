import { createHash } from "node:crypto";
import { pool } from "../config/database.js";
import { fetchIndianInsiderTradeFilings } from "./insiderTradeSourceService.js";

const syncLockId = 724061923;
const earliestBackfillYear = 2015;
let activeBackfillAbortController = null;
let activeBackfillPid = null;

export async function syncRecentInsiderTrades() {
  return withSyncLock(async (client) => {
    const today = isoToday();
    const defaultFrom = addDays(today, -6);
    const state = await client.query("select last_to_date::text as date from fin_insider_sync_state where id = 'recent'");
    const previousTo = state.rows[0]?.date;
    const fromDate = previousTo && previousTo < defaultFrom ? addDays(previousTo, -1) : defaultFrom;
    return syncRange(client, fromDate, today, "recent");
  });
}

export async function syncInsiderTradesRange({ fromDate, toDate }) {
  return withSyncLock((client) => syncRange(client, fromDate, toDate, "manual"));
}

export async function queueInsiderTradeBackfill({ fromYear, fromMonth = 1, toYear, toMonth = 12 }) {
  const result = await pool.query(
    `insert into fin_insider_sync_state
       (id, status, current_label, from_year, to_year, total_windows, completed_windows, failed_windows,
        progress_received, progress_inserted, progress_updated, progress_ignored, last_error, started_at, completed_at, updated_at, from_month, to_month)
     values ('backfill', 'queued', 'Waiting to start', $1, $2, 0, 0, 0, 0, 0, 0, 0, '', now(), null, now(), $3, $4)
     on conflict (id) do update set status = 'queued', current_label = 'Waiting to start', from_year = excluded.from_year,
       to_year = excluded.to_year, from_month = excluded.from_month, to_month = excluded.to_month, total_windows = 0, completed_windows = 0, failed_windows = 0,
       progress_received = 0, progress_inserted = 0, progress_updated = 0, progress_ignored = 0,
       last_error = '', started_at = now(), completed_at = null, updated_at = now()
     where fin_insider_sync_state.status not in ('queued', 'running', 'cancelling')
     returning id`,
    [fromYear, toYear, fromMonth, toMonth],
  );
  if (!result.rowCount) return { accepted: false, status: await getInsiderTradeBackfillStatus() };
  setImmediate(async () => {
    try {
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        if (await isBackfillCancellationRequested()) {
          await markBackfillStopped("cancelled", "Terminated by admin");
          return;
        }
        const backfill = await backfillInsiderTrades({ fromYear, fromMonth, toYear, toMonth });
        if (!backfill.skipped) return;
        if (await isBackfillCancellationRequested()) {
          await markBackfillStopped("cancelled", "Terminated by admin");
          return;
        }
        await pool.query(
          "update fin_insider_sync_state set status = 'queued', current_label = $1, updated_at = now() where id = 'backfill'",
          [`Waiting for active sync (${attempt}/40)`],
        );
        await delay(15_000);
      }
      await markBackfillStopped("failed", "Timed out waiting for another insider sync to finish");
    } catch (error) {
      console.error(`[Insider backfill] Stopped: ${error.message}`);
      if (await isBackfillCancellationRequested()) await markBackfillStopped("cancelled", "Terminated by admin");
      else await markBackfillStopped("failed", error.message);
    }
  });
  return { accepted: true, status: "queued", fromYear, fromMonth, toYear, toMonth, statusEndpoint: "/api/finance/insider-trades/backfill/status" };
}

export async function getInsiderTradeBackfillStatus() {
  const result = await pool.query(
    `select status, current_label as "currentLabel", from_year as "fromYear", from_month as "fromMonth", to_year as "toYear", to_month as "toMonth",
       total_windows as "totalMonths", completed_windows as "completedMonths", failed_windows as "failedMonths",
       progress_received as received, progress_inserted as inserted, progress_updated as enriched,
       progress_ignored as duplicates, last_error as "lastError", started_at as "startedAt",
       completed_at as "completedAt", updated_at as "updatedAt"
     from fin_insider_sync_state where id = 'backfill'`,
  );
  const row = result.rows[0];
  if (!row) return { status: "not_started", progressPercent: 0 };
  return { ...row, progressPercent: row.totalMonths ? Math.round((row.completedMonths / row.totalMonths) * 10000) / 100 : 0 };
}

export async function cancelInsiderTradeBackfill() {
  const result = await pool.query(
    `update fin_insider_sync_state
     set status = 'cancelling', current_label = 'Stopping after the current month', updated_at = now()
     where id = 'backfill' and status in ('queued', 'running')
     returning id`,
  );
  if (!result.rowCount) return { accepted: false, status: await getInsiderTradeBackfillStatus() };
  activeBackfillAbortController?.abort(new Error("Insider backfill terminated by admin"));
  if (activeBackfillPid) await pool.query("select pg_cancel_backend($1)", [activeBackfillPid]).catch(() => {});

  const client = await pool.connect();
  try {
    const lock = await client.query("select pg_try_advisory_lock($1) as locked", [syncLockId]);
    if (lock.rows[0]?.locked === true) {
      await client.query("select pg_advisory_unlock($1)", [syncLockId]);
      await markBackfillStopped("cancelled", "Terminated by admin");
    }
  } finally {
    client.release();
  }
  return { accepted: true, status: await getInsiderTradeBackfillStatus() };
}

export async function backfillInsiderTrades({ fromYear = earliestBackfillYear, fromMonth = 1, toYear = new Date().getUTCFullYear(), toMonth = 12 } = {}) {
  const currentYear = new Date().getUTCFullYear();
  const firstYear = Math.max(earliestBackfillYear, Number(fromYear) || earliestBackfillYear);
  const lastYear = Math.min(currentYear, Math.max(firstYear, Number(toYear) || currentYear));
  const firstMonth = Math.max(1, Math.min(12, Number(fromMonth) || 1));
  const lastMonth = Math.max(1, Math.min(12, Number(toMonth) || 12));
  return withSyncLock(async (client) => {
    activeBackfillPid = client.processID;
    const windows = backfillMonthWindows({ fromYear: firstYear, fromMonth: firstMonth, toYear: lastYear, toMonth: lastMonth, today: isoToday() });
    console.log(`[Insider backfill] Starting ${firstMonth}/${firstYear} to ${lastMonth}/${lastYear}`);
    const totalWindows = windows.length;
    const started = await client.query(
      `update fin_insider_sync_state set status = 'running', current_label = 'Starting', from_year = $1, to_year = $2,
         total_windows = $3, completed_windows = 0, failed_windows = 0, progress_received = 0,
         progress_inserted = 0, progress_updated = 0, progress_ignored = 0, last_error = '',
         started_at = coalesce(started_at, now()), completed_at = null, updated_at = now()
       where id = 'backfill' and status = 'queued'
       returning id`,
      [firstYear, lastYear, totalWindows],
    );
    if (!started.rowCount) {
      await markBackfillStopped("cancelled", "Terminated by admin");
      return { ok: false, cancelled: true, fromYear: firstYear, toYear: lastYear };
    }
    activeBackfillAbortController = new AbortController();
    const years = [];
    const failures = [];
    let received = 0;
    let inserted = 0;
    let updated = 0;
    let ignored = 0;
    let rejected = 0;
    let completedWindows = 0;
    for (let year = firstYear; year <= lastYear; year += 1) {
      const yearResult = { year, received: 0, inserted: 0, updated: 0, ignored: 0, rejected: 0, failedWindows: 0 };
      const yearWindows = windows.filter((window) => Number(window.from.slice(0, 4)) === year);
      for (const window of yearWindows) {
        if (await isBackfillCancellationRequested(client)) {
          return finishCancelledBackfill(client, { fromYear: firstYear, toYear: lastYear, completedWindows, failures, received: received + yearResult.received, inserted: inserted + yearResult.inserted, updated: updated + yearResult.updated, ignored: ignored + yearResult.ignored });
        }
        const label = monthLabel(window.from);
        console.log(`[Insider backfill] Running ${label} (${window.from} to ${window.to})`);
        await updateBackfillProgress(client, { status: "running", currentLabel: `Running ${label}`, completed: completedWindows, failed: failures.length, received: received + yearResult.received, inserted: inserted + yearResult.inserted, updated: updated + yearResult.updated, ignored: ignored + yearResult.ignored });
        try {
          const result = await syncRange(client, window.from, window.to, "backfill", { signal: activeBackfillAbortController.signal });
          yearResult.received += result.received;
          yearResult.inserted += result.inserted;
          yearResult.updated += result.updated;
          yearResult.ignored += result.ignored;
          yearResult.rejected += result.rejected;
          console.log(`[Insider backfill] Completed ${label}: ${result.received} received, ${result.inserted} inserted, ${result.updated} enriched, ${result.ignored} duplicates, ${result.rejected} rejected`);
        } catch (error) {
          if (activeBackfillAbortController.signal.aborted || await isBackfillCancellationRequested(client)) {
            return finishCancelledBackfill(client, { fromYear: firstYear, fromMonth: firstMonth, toYear: lastYear, toMonth: lastMonth, completedWindows, failures, received: received + yearResult.received, inserted: inserted + yearResult.inserted, updated: updated + yearResult.updated, ignored: ignored + yearResult.ignored });
          }
          yearResult.failedWindows += 1;
          failures.push({ year, fromDate: window.from, toDate: window.to, error: error.message });
          console.error(`[Insider backfill] Failed ${label}: ${error.message}`);
        }
        completedWindows += 1;
        if (await isBackfillCancellationRequested(client)) {
          return finishCancelledBackfill(client, { fromYear: firstYear, toYear: lastYear, completedWindows, failures, received: received + yearResult.received, inserted: inserted + yearResult.inserted, updated: updated + yearResult.updated, ignored: ignored + yearResult.ignored });
        }
        await updateBackfillProgress(client, {
          status: "running",
          currentLabel: `Completed ${label}`,
          completed: completedWindows,
          failed: failures.length,
          received: received + yearResult.received,
          inserted: inserted + yearResult.inserted,
          updated: updated + yearResult.updated,
          ignored: ignored + yearResult.ignored,
          lastError: failures.at(-1)?.error || "",
        });
      }
      years.push(yearResult);
      received += yearResult.received;
      inserted += yearResult.inserted;
      updated += yearResult.updated;
      ignored += yearResult.ignored;
      rejected += yearResult.rejected;
      console.log(`[Insider backfill] Year ${year} complete: ${yearResult.received} received, ${yearResult.inserted} inserted, ${yearResult.updated} enriched, ${yearResult.failedWindows} failed month(s)`);
    }
    const summary = { ok: failures.length === 0, partial: failures.length > 0, fromYear: firstYear, fromMonth: firstMonth, toYear: lastYear, toMonth: lastMonth, received, inserted, updated, ignored, rejected, failures, years };
    await updateBackfillProgress(client, { status: failures.length ? "partial" : "completed", currentLabel: failures.length ? "Completed with failures" : "Completed", completed: totalWindows, failed: failures.length, received, inserted, updated, ignored, lastError: failures.at(-1)?.error || "", completedAt: true });
    console.log(`[Insider backfill] Finished ${firstYear}-${lastYear}: ${received} received, ${inserted} inserted, ${updated} enriched, ${ignored} duplicates, ${failures.length} failed month(s)`);
    return summary;
  }).finally(() => {
    activeBackfillAbortController = null;
    activeBackfillPid = null;
  });
}

function backfillMonthWindows({ fromYear, fromMonth, toYear, toMonth, today }) {
  const windows = [];
  const todayDate = new Date(`${today}T00:00:00Z`);
  let cursor = new Date(Date.UTC(fromYear, fromMonth - 1, 1));
  const requestedEnd = new Date(Date.UTC(toYear, toMonth, 0));
  const end = requestedEnd < todayDate ? requestedEnd : todayDate;
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    windows.push({ from: cursor.toISOString().slice(0, 10), to: new Date(Math.min(monthEnd.getTime(), end.getTime())).toISOString().slice(0, 10) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return windows;
}

async function isBackfillCancellationRequested(client = pool) {
  const result = await client.query("select status from fin_insider_sync_state where id = 'backfill'");
  return ["cancelling", "cancelled"].includes(result.rows[0]?.status);
}

async function finishCancelledBackfill(client, progress) {
  await updateBackfillProgress(client, {
    status: "cancelled",
    currentLabel: "Terminated by admin",
    completed: progress.completedWindows,
    failed: progress.failures.length,
    received: progress.received,
    inserted: progress.inserted,
    updated: progress.updated,
    ignored: progress.ignored,
    completedAt: true,
  });
  return { ok: false, cancelled: true, ...progress };
}

async function updateBackfillProgress(client, progress) {
  await client.query(
    `update fin_insider_sync_state set status = $1, current_label = $2, completed_windows = $3,
       failed_windows = $4, progress_received = $5, progress_inserted = $6, progress_updated = $7,
       progress_ignored = $8, last_error = $9, completed_at = case when $10 then now() else completed_at end,
       updated_at = now() where id = 'backfill'`,
    [progress.status, progress.currentLabel, progress.completed || 0, progress.failed || 0, progress.received || 0,
      progress.inserted || 0, progress.updated || 0, progress.ignored || 0, progress.lastError || "", progress.completedAt === true],
  );
}

async function markBackfillStopped(status, message) {
  await pool.query(
    "update fin_insider_sync_state set status = $1, current_label = $2, last_error = $2, completed_at = now(), updated_at = now() where id = 'backfill'",
    [status, message],
  );
}

export async function getStoredInsiderTrades({ year, symbols = [], companyNames = [], search = "", date = "", page = 1, pageSize = 50 } = {}) {
  const currentYear = new Date().getUTCFullYear();
  const selectedYear = Math.max(earliestBackfillYear, Math.min(currentYear, Number(year) || currentYear));
  let params = [`${selectedYear}-01-01`, selectedYear === currentYear ? isoToday() : `${selectedYear}-12-31`];
  const conditions = ["activity_date between $1::date and $2::date"];
  if (validIsoDate(date)) {
    params.push(date);
    conditions.push(`activity_date = $${params.length}::date`);
  }
  if (symbols.length || companyNames.length) {
    params.push(symbols.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean));
    const symbolParam = params.length;
    params.push(companyNames.map(companyPattern).filter(Boolean));
    const companyParam = params.length;
    conditions.push(`(upper(symbol) = any($${symbolParam}::text[]) or lower(company) like any($${companyParam}::text[]))`);
  }
  const tokens = searchTokens(search);
  if (tokens.length) {
    const primaryParams = [...params];
    const primaryConditions = [...conditions];
    appendSearch(primaryParams, primaryConditions, tokens, "lower(symbol || ' ' || company)");
    const primaryWhere = `where ${primaryConditions.join(" and ")}`;
    const primaryCount = await pool.query(`select count(*)::int as total from fin_insider_trade ${primaryWhere}`, primaryParams);
    if ((primaryCount.rows[0]?.total || 0) > 0) {
      params = primaryParams;
      conditions.splice(0, conditions.length, ...primaryConditions);
    } else {
      appendSearch(params, conditions, tokens, "lower(symbol || ' ' || company || ' ' || person || ' ' || category || ' ' || transaction_type || ' ' || acquisition_mode)");
    }
  }
  const where = `where ${conditions.join(" and ")}`;
  const countResult = await pool.query(`select count(*)::int as total from fin_insider_trade ${where}`, params);
  const total = countResult.rows[0]?.total || 0;
  const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 50));
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.max(1, Math.min(pageCount, Number(page) || 1));
  params.push(safePageSize, (safePage - 1) * safePageSize);
  const rowsResult = await pool.query(
    `select id::text, symbol, company, person, category, transaction_type as "transactionType",
       acquisition_mode as "acquisitionMode", quantity, transaction_value as value,
       to_char(activity_date, 'DD-Mon-YYYY') as date,
       case when disclosure_date is null then '' else to_char(disclosure_date, 'DD-Mon-YYYY') end as "disclosureDate",
       disclosure_url as "disclosureUrl", source,
       holding_before_percent as "holdingBeforePercent",
       holding_after_percent as "holdingAfterPercent",
       market_cap_impact_percent as "marketCapImpactPercent"
     from fin_insider_trade
     ${where}
     order by activity_date desc, id desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  const yearsResult = await pool.query("select distinct extract(year from activity_date)::int as year from fin_insider_trade order by year desc");
  return {
    rows: rowsResult.rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      value: Number(row.value),
      holdingBeforePercent: nullableDatabaseNumber(row.holdingBeforePercent),
      holdingAfterPercent: nullableDatabaseNumber(row.holdingAfterPercent),
      marketCapImpactPercent: nullableDatabaseNumber(row.marketCapImpactPercent),
    })),
    total,
    page: safePage,
    pageSize: safePageSize,
    pageCount,
    year: selectedYear,
    availableYears: yearsResult.rows.map((row) => row.year),
    source: "Database-backed NSE and BSE insider trading disclosures",
    sources: { database: true },
    refreshedAt: new Date().toISOString(),
  };
}

async function syncRange(client, fromDate, toDate, stateId, { signal } = {}) {
  const fetched = await fetchIndianInsiderTradeFilings({ fromDate, toDate, signal });
  const uniqueRows = [...fetched.rows.reduce((map, row) => {
    const key = fingerprint(row);
    const existing = map.get(key);
    if (!existing || (existing.marketCapImpactPercent == null && row.marketCapImpactPercent != null)) map.set(key, row);
    return map;
  }, new Map()).values()];
  let inserted = 0;
  let updated = 0;
  for (let offset = 0; offset < uniqueRows.length; offset += 200) {
    const result = await insertChunk(client, uniqueRows.slice(offset, offset + 200));
    inserted += result.inserted;
    updated += result.updated;
  }
  const ignored = fetched.rows.length - inserted - updated;
  await client.query(
    `insert into fin_insider_sync_state (id, last_from_date, last_to_date, last_success_at, last_inserted, last_seen, last_error, updated_at)
     values ($1, $2, $3, now(), $4, $5, '', now())
     on conflict (id) do update set last_from_date = excluded.last_from_date, last_to_date = excluded.last_to_date,
       last_success_at = excluded.last_success_at, last_inserted = excluded.last_inserted,
       last_seen = excluded.last_seen, last_error = '', updated_at = now()`,
    [stateId, fromDate, toDate, inserted, fetched.rows.length],
  );
  return { ok: true, fromDate, toDate, received: fetched.rows.length, inserted, updated, ignored, rejected: fetched.rejected, sources: fetched.sources, sourceErrors: fetched.sourceErrors };
}

async function insertChunk(client, rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const data = [fingerprint(row), row.source, row.sourceRecordId, row.symbol, row.company, row.person, row.category, row.transactionType, row.acquisitionMode, row.quantity, row.value, exchangeDate(row.date), exchangeDate(row.disclosureDate) || null, row.disclosureUrl, row.holdingBeforePercent, row.holdingAfterPercent, row.marketCapImpactPercent];
    values.push(...data);
    const start = rowIndex * data.length;
    return `(${data.map((_, index) => `$${start + index + 1}`).join(", ")})`;
  });
  const result = await client.query(
    `insert into fin_insider_trade
       (dedupe_key, source, source_record_id, symbol, company, person, category, transaction_type,
        acquisition_mode, quantity, transaction_value, activity_date, disclosure_date, disclosure_url,
        holding_before_percent, holding_after_percent, market_cap_impact_percent)
     values ${placeholders.join(", ")}
     on conflict (dedupe_key) do update set
       holding_before_percent = coalesce(fin_insider_trade.holding_before_percent, excluded.holding_before_percent),
       holding_after_percent = coalesce(fin_insider_trade.holding_after_percent, excluded.holding_after_percent),
       market_cap_impact_percent = coalesce(fin_insider_trade.market_cap_impact_percent, excluded.market_cap_impact_percent),
       updated_at = now()
     where fin_insider_trade.market_cap_impact_percent is null
       and excluded.market_cap_impact_percent is not null
     returning (xmax = 0) as inserted`,
    values,
  );
  return {
    inserted: result.rows.filter((row) => row.inserted).length,
    updated: result.rows.filter((row) => !row.inserted).length,
  };
}

async function withSyncLock(work) {
  const client = await pool.connect();
  let locked = false;
  try {
    const lockResult = await client.query("select pg_try_advisory_lock($1) as locked", [syncLockId]);
    locked = Boolean(lockResult.rows[0]?.locked);
    if (!locked) return { ok: true, skipped: true, reason: "Another insider sync is already running" };
    return await work(client);
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [syncLockId]).catch(() => {});
    client.release();
  }
}

function fingerprint(row) {
  const canonical = [normalizeName(row.company), normalizeName(row.person), exchangeDate(row.date), String(row.transactionType || "").toLowerCase(), String(Number(row.quantity || 0)), String(Number(row.value || 0)), normalizeName(row.acquisitionMode)].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function exchangeDate(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})/i);
  const month = match ? ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(match[2].toUpperCase()) : -1;
  return match && month >= 0 ? `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}` : "";
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/\b(limited|ltd|private|pvt|company|co)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function companyPattern(value) {
  const name = normalizeName(value);
  return name ? `%${name.split(" ").join("%")}%` : "";
}

function searchTokens(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function appendSearch(params, conditions, tokens, expression) {
  tokens.forEach((token) => {
    params.push(`%${token}%`);
    conditions.push(`${expression} like $${params.length}`);
  });
}

function validIsoDate(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nullableDatabaseNumber(value) {
  return value == null ? null : Number(value);
}

function monthWindows(year, toDate) {
  const windows = [];
  const finalDate = Date.parse(`${toDate}T00:00:00Z`);
  for (let month = 0; month < 12; month += 1) {
    const start = Date.UTC(year, month, 1);
    if (start > finalDate) break;
    const end = Math.min(finalDate, Date.UTC(year, month + 1, 0));
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
  }
  return windows;
}

function monthLabel(value) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export const insiderTradeTestUtils = { backfillMonthWindows, exchangeDate, fingerprint, normalizeName, monthWindows };
