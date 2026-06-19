import { createHash } from "node:crypto";
import { pool } from "../config/database.js";
import { fetchIndianInsiderTradeFilings } from "./marketIntelligenceService.js";

const syncLockId = 724061923;
const earliestBackfillYear = 2015;

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

export async function backfillInsiderTrades({ fromYear = earliestBackfillYear, toYear = new Date().getUTCFullYear() } = {}) {
  const currentYear = new Date().getUTCFullYear();
  const firstYear = Math.max(earliestBackfillYear, Number(fromYear) || earliestBackfillYear);
  const lastYear = Math.min(currentYear, Math.max(firstYear, Number(toYear) || currentYear));
  return withSyncLock(async (client) => {
    const years = [];
    const failures = [];
    let received = 0;
    let inserted = 0;
    let ignored = 0;
    let rejected = 0;
    for (let year = firstYear; year <= lastYear; year += 1) {
      const yearResult = { year, received: 0, inserted: 0, ignored: 0, rejected: 0, failedWindows: 0 };
      const yearEnd = year === currentYear ? isoToday() : `${year}-12-31`;
      for (const window of dateWindows(`${year}-01-01`, yearEnd, 31)) {
        try {
          const result = await syncRange(client, window.from, window.to, "backfill");
          yearResult.received += result.received;
          yearResult.inserted += result.inserted;
          yearResult.ignored += result.ignored;
          yearResult.rejected += result.rejected;
        } catch (error) {
          yearResult.failedWindows += 1;
          failures.push({ year, fromDate: window.from, toDate: window.to, error: error.message });
        }
      }
      years.push(yearResult);
      received += yearResult.received;
      inserted += yearResult.inserted;
      ignored += yearResult.ignored;
      rejected += yearResult.rejected;
    }
    return { ok: failures.length === 0, partial: failures.length > 0, fromYear: firstYear, toYear: lastYear, received, inserted, ignored, rejected, failures, years };
  });
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
    appendSearch(primaryParams, primaryConditions, tokens, "lower(concat_ws(' ', symbol, company))");
    const primaryWhere = `where ${primaryConditions.join(" and ")}`;
    const primaryCount = await pool.query(`select count(*)::int as total from fin_insider_trade ${primaryWhere}`, primaryParams);
    if ((primaryCount.rows[0]?.total || 0) > 0) {
      params = primaryParams;
      conditions.splice(0, conditions.length, ...primaryConditions);
    } else {
      appendSearch(params, conditions, tokens, "lower(concat_ws(' ', symbol, company, person, category, transaction_type, acquisition_mode))");
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
       disclosure_url as "disclosureUrl", source
     from fin_insider_trade
     ${where}
     order by activity_date desc, id desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  const yearsResult = await pool.query("select distinct extract(year from activity_date)::int as year from fin_insider_trade order by year desc");
  return {
    rows: rowsResult.rows.map((row) => ({ ...row, quantity: Number(row.quantity), value: Number(row.value) })),
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

async function syncRange(client, fromDate, toDate, stateId) {
  const fetched = await fetchIndianInsiderTradeFilings({ fromDate, toDate });
  let inserted = 0;
  for (let offset = 0; offset < fetched.rows.length; offset += 200) {
    inserted += await insertChunk(client, fetched.rows.slice(offset, offset + 200));
  }
  const ignored = fetched.rows.length - inserted;
  await client.query(
    `insert into fin_insider_sync_state (id, last_from_date, last_to_date, last_success_at, last_inserted, last_seen, last_error, updated_at)
     values ($1, $2, $3, now(), $4, $5, '', now())
     on conflict (id) do update set last_from_date = excluded.last_from_date, last_to_date = excluded.last_to_date,
       last_success_at = excluded.last_success_at, last_inserted = excluded.last_inserted,
       last_seen = excluded.last_seen, last_error = '', updated_at = now()`,
    [stateId, fromDate, toDate, inserted, fetched.rows.length],
  );
  return { ok: true, fromDate, toDate, received: fetched.rows.length, inserted, ignored, rejected: fetched.rejected, sources: fetched.sources };
}

async function insertChunk(client, rows) {
  if (!rows.length) return 0;
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const data = [fingerprint(row), row.source, row.sourceRecordId, row.symbol, row.company, row.person, row.category, row.transactionType, row.acquisitionMode, row.quantity, row.value, exchangeDate(row.date), exchangeDate(row.disclosureDate) || null, row.disclosureUrl];
    values.push(...data);
    const start = rowIndex * data.length;
    return `(${data.map((_, index) => `$${start + index + 1}`).join(", ")})`;
  });
  const result = await client.query(
    `insert into fin_insider_trade
       (dedupe_key, source, source_record_id, symbol, company, person, category, transaction_type,
        acquisition_mode, quantity, transaction_value, activity_date, disclosure_date, disclosure_url)
     values ${placeholders.join(", ")}
     on conflict (dedupe_key) do nothing`,
    values,
  );
  return result.rowCount;
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

function dateWindows(fromDate, toDate, maximumDays) {
  const windows = [];
  const end = Date.parse(`${toDate}T00:00:00Z`);
  let cursor = Date.parse(`${fromDate}T00:00:00Z`);
  while (cursor <= end) {
    const windowEnd = Math.min(end, cursor + (maximumDays - 1) * 86400000);
    windows.push({ from: new Date(cursor).toISOString().slice(0, 10), to: new Date(windowEnd).toISOString().slice(0, 10) });
    cursor = windowEnd + 86400000;
  }
  return windows;
}

export const insiderTradeTestUtils = { exchangeDate, fingerprint, normalizeName };
