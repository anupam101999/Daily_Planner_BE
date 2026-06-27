import { pool } from "../config/database.js";
import { getBatches, runBatch, saveBatchSchedule } from "../services/batchService.js";
import { rescheduleBatch, validateCronExpression } from "../services/batchSchedulerService.js";
import { getFinanceSettings, saveFinanceSettings } from "../services/financeSettingsService.js";

export async function getAdminBatches(_request, response, next) {
  try {
    response.json({ batches: await getBatches() });
  } catch (error) {
    next(error);
  }
}

export async function getAdminSettings(_request, response, next) {
  try {
    response.json({ settings: await getFinanceSettings() });
  } catch (error) {
    next(error);
  }
}

export async function updateAdminSettings(request, response, next) {
  try {
    const provider = String(request.body?.financeQuoteProvider || "").trim().toLowerCase();
    if (!["nse", "screener"].includes(provider)) {
      response.status(400).json({ error: "Quote provider must be nse or screener", code: "INVALID_QUOTE_PROVIDER" });
      return;
    }
    response.json({ settings: await saveFinanceSettings({ financeQuoteProvider: provider }) });
  } catch (error) {
    next(error);
  }
}

export async function getAdminQuoteAssets(_request, response, next) {
  try {
    const result = await pool.query(
      `
        select
          a.id::text,
          a.user_id::text as "userId",
          u.name as "userName",
          a.name,
          a.symbol,
          a.exchange,
          a.sector,
          a.skip_quote_sync as "skipQuoteSync",
          a.last_price as "lastPrice",
          a.last_price_at as "lastPriceAt",
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity when t.transaction_type = 'sell' then -t.quantity else 0 end), 0) as quantity
        from fin_asset a
        join daily_user u on u.id = a.user_id
        left join fin_transaction t on t.asset_id = a.id and t.user_id = a.user_id
        group by a.id, u.name
        having coalesce(sum(case when t.transaction_type = 'buy' then t.quantity when t.transaction_type = 'sell' then -t.quantity else 0 end), 0) > 0
        order by a.skip_quote_sync desc, a.name asc
      `,
    );
    response.json({ assets: result.rows.map((row) => ({ ...row, quantity: Number(row.quantity || 0), lastPrice: row.lastPrice == null ? null : Number(row.lastPrice) })) });
  } catch (error) {
    next(error);
  }
}

export async function updateAdminQuoteAsset(request, response, next) {
  try {
    const result = await pool.query(
      `
        update fin_asset
           set skip_quote_sync = $2, updated_at = now()
         where id = $1
         returning id::text, user_id::text as "userId", name, symbol, exchange, sector, skip_quote_sync as "skipQuoteSync", last_price as "lastPrice", last_price_at as "lastPriceAt"
      `,
      [request.params.assetId, request.body?.skipQuoteSync === true],
    );
    if (!result.rowCount) {
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    const row = result.rows[0];
    response.json({ asset: { ...row, lastPrice: row.lastPrice == null ? null : Number(row.lastPrice) } });
  } catch (error) {
    next(error);
  }
}

export async function getAdminDatabaseTables(_request, response, next) {
  try {
    const tables = await listDatabaseTables();
    const counts = await Promise.all(tables.map(async (table) => {
      const result = await pool.query(`select count(*)::int as total from ${quoteTable(table)} ${tableWhere(table)}`);
      return { ...table, total: result.rows[0]?.total || 0 };
    }));
    response.json({ tables: counts });
  } catch (error) {
    next(error);
  }
}

export async function getAdminDatabaseTable(request, response, next) {
  try {
    const table = await requireKnownTable(request.params.table);
    const page = Math.max(1, Number(request.query.page || 1));
    const pageSize = Math.max(5, Math.min(100, Number(request.query.pageSize || 25)));
    const offset = (page - 1) * pageSize;
    const search = String(request.query.search || "").trim();
    const schema = await getTableSchema(table);
    const whereParts = [];
    const values = [];
    if (tableWhere(table)) whereParts.push(tableWhere(table).replace(/^where\s+/i, ""));
    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      whereParts.push(`lower(to_jsonb(t)::text) like $${values.length}`);
    }
    const where = whereParts.length ? `where ${whereParts.join(" and ")}` : "";
    const order = schema.primaryKey.length ? schema.primaryKey.map((column) => `t.${quoteIdent(column)} desc`).join(", ") : "t.ctid desc";
    values.push(pageSize, offset);
    const rowsResult = await pool.query(
      `select t.ctid::text as "__ctid", row_to_json(t) as row from ${quoteTable(table)} t ${where} order by ${order} limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    const countResult = await pool.query(`select count(*)::int as total from ${quoteTable(table)} t ${where}`, values.slice(0, -2));
    response.json({
      table,
      schema,
      rows: rowsResult.rows.map((item) => {
        const row = { ...item.row, __ctid: item.__ctid };
        return { ...row, __rowKey: buildRowKey(row, schema.primaryKey) };
      }),
      pagination: { page, pageSize, total: countResult.rows[0]?.total || 0, totalPages: Math.max(1, Math.ceil((countResult.rows[0]?.total || 0) / pageSize)) },
    });
  } catch (error) {
    handleAdminDatabaseError(error, response, next);
  }
}

export async function insertAdminDatabaseRow(request, response, next) {
  try {
    const table = await requireKnownTable(request.params.table);
    const schema = await getTableSchema(table);
    const writable = writablePayload(request.body?.row || {}, schema);
    if (!Object.keys(writable).length) throw badAdminRequest("Provide at least one writable column");
    const columns = Object.keys(writable);
    const values = Object.values(writable);
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const result = await pool.query(
      `insert into ${quoteTable(table)} (${columns.map(quoteIdent).join(", ")}) values (${placeholders.join(", ")}) returning *`,
      values,
    );
    response.status(201).json({ row: result.rows[0] });
  } catch (error) {
    handleAdminDatabaseError(error, response, next);
  }
}

export async function updateAdminDatabaseRow(request, response, next) {
  try {
    const table = await requireKnownTable(request.params.table);
    const schema = await getTableSchema(table);
    const writable = writablePayload(request.body?.row || {}, schema);
    if (!Object.keys(writable).length) throw badAdminRequest("Provide at least one writable column");
    const values = Object.values(writable);
    const assignments = Object.keys(writable).map((column, index) => `${quoteIdent(column)} = $${index + 1}`);
    const { where, params } = rowLocator(request.body?.key, schema, values.length + 1);
    const result = await pool.query(
      `update ${quoteTable(table)} set ${assignments.join(", ")} where ${where} returning *`,
      [...values, ...params],
    );
    if (!result.rowCount) throw notFoundAdminRequest("Row not found");
    response.json({ row: result.rows[0] });
  } catch (error) {
    handleAdminDatabaseError(error, response, next);
  }
}

export async function deleteAdminDatabaseRow(request, response, next) {
  try {
    const table = await requireKnownTable(request.params.table);
    const schema = await getTableSchema(table);
    const { where, params } = rowLocator(request.body?.key, schema, 1);
    const result = await pool.query(`delete from ${quoteTable(table)} where ${where}`, params);
    if (!result.rowCount) throw notFoundAdminRequest("Row not found");
    response.status(204).end();
  } catch (error) {
    handleAdminDatabaseError(error, response, next);
  }
}

export async function runAdminDatabaseQuery(request, response, next) {
  try {
    const sql = String(request.body?.sql || "").trim();
    if (!sql) throw badAdminRequest("Enter a SQL statement");
    if (sql.includes(";")) throw badAdminRequest("Run one SQL statement at a time");
    const result = await pool.query(sql);
    response.json({ rowCount: result.rowCount, rows: result.rows, fields: result.fields?.map((field) => field.name) || [] });
  } catch (error) {
    handleAdminDatabaseError(error, response, next);
  }
}

export async function runAdminBatch(request, response, next) {
  try {
    const outcome = await runBatch(request.params.batchId, { source: "manual" });
    if (!outcome.found) {
      response.status(404).json({ error: "Batch process not found" });
      return;
    }
    if (!outcome.accepted) {
      response.status(409).json({ error: "This batch process is already running" });
      return;
    }
    response.json({ batchId: request.params.batchId, completedAt: new Date().toISOString(), result: outcome.result, batches: await getBatches() });
  } catch (error) {
    next(error);
  }
}

export async function getAdminLogs(request, response, next) {
  try {
    const source = request.query.source === "batch" ? "batch" : "app";
    const page = Math.max(1, Number(request.query.page || 1));
    const limit = Math.max(5, Math.min(50, Number(request.query.limit || 10)));
    const offset = (page - 1) * limit;
    const filters = [];
    const values = [];
    const add = (sql, value) => { values.push(value); filters.push(sql.replace("?", `$${values.length}`)); };
    if (request.query.date) add(source === "batch" ? "started_at::date=?::date" : "created_at::date=?::date", request.query.date);
    if (source === "batch" && request.query.status && request.query.status !== "all") add("run_status=?", request.query.status);
    if (source === "app" && request.query.level && request.query.level !== "all") add("level=?", request.query.level);
    if (request.query.q) {
      values.push(`%${String(request.query.q).toLowerCase()}%`);
      const p = `$${values.length}`;
      filters.push(source === "batch" ? `(lower(batch_id) like ${p} or lower(coalesce(error_message,'')) like ${p} or lower(result::text) like ${p})`
        : `(lower(event) like ${p} or lower(message) like ${p} or lower(coalesce(path,'')) like ${p} or lower(meta::text) like ${p})`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const table = source === "batch" ? "fin_batch_run" : "app_log";
    const order = source === "batch" ? "started_at" : "created_at";
    const [rows, count] = await Promise.all([
      pool.query(`select * from ${table} ${where} order by ${order} desc limit ${limit} offset ${offset}`, values),
      pool.query(`select count(*)::int total from ${table} ${where}`, values),
    ]);
    response.json({ source, logs: rows.rows, pagination: { page, limit, total: count.rows[0].total, totalPages: Math.max(1, Math.ceil(count.rows[0].total / limit)) } });
  } catch (error) { next(error); }
}

export async function updateAdminBatchSchedule(request, response, next) {
  try {
    const cronExpression = String(request.body?.cronExpression || "").trim();
    const enabled = request.body?.enabled !== false;
    if (!validateCronExpression(cronExpression)) {
      response.status(400).json({ error: "Enter a valid batch schedule", code: "INVALID_BATCH_SCHEDULE" });
      return;
    }
    const result = await saveBatchSchedule(request.params.batchId, { cronExpression, enabled });
    if (!result.found) {
      response.status(404).json({ error: "Batch process not found" });
      return;
    }
    await rescheduleBatch(request.params.batchId);
    response.json({ batches: await getBatches() });
  } catch (error) {
    next(error);
  }
}

export async function getAdminInsights(_request, response, next) {
  try {
    const [summaryResult, usersResult, trendResult] = await Promise.all([
      pool.query(`
        select
          (select count(*)::int from daily_user) as "totalUsers",
          count(*)::int as "totalTasks",
          count(*) filter (where lower(trim(status)) = 'completed')::int as "completedTasks",
          count(*) filter (where lower(trim(status)) = 'planned')::int as "plannedTasks",
          count(*) filter (where lower(trim(status)) = 'backlog')::int as "backlogTasks",
          coalesce(sum(estimated_minutes), 0)::int as "plannedMinutes",
          coalesce(sum(actual_minutes) filter (where lower(trim(status)) = 'completed'), 0)::int as "actualMinutes",
          coalesce(sum(focused_seconds), 0)::bigint as "focusedSeconds",
          coalesce(sum(pomodoro_count), 0)::int as "pomodoroCount",
          count(distinct user_id) filter (where created_at >= now() - interval '30 days')::int as "activeUsers30d"
        from daily_task
      `),
      pool.query(`
        select
          u.id::text,
          u.name,
          u.is_admin as "isAdmin",
          count(t.id)::int as "totalTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'completed')::int as "completedTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'planned')::int as "plannedTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'backlog')::int as "backlogTasks",
          coalesce(sum(t.estimated_minutes), 0)::int as "plannedMinutes",
          coalesce(sum(t.actual_minutes) filter (where lower(trim(t.status)) = 'completed'), 0)::int as "actualMinutes",
          coalesce(sum(t.focused_seconds), 0)::bigint as "focusedSeconds",
          coalesce(sum(t.pomodoro_count), 0)::int as "pomodoroCount",
          max(greatest(t.created_at, t.completed_at, t.backlog_at)) as "lastActivityAt"
        from daily_user u
        left join daily_task t on t.user_id = u.id
        group by u.id, u.name, u.is_admin
        order by u.name
      `),
      pool.query(`
        with days as (
          select generate_series(
            (now() at time zone 'Asia/Kolkata')::date - 13,
            (now() at time zone 'Asia/Kolkata')::date,
            interval '1 day'
          )::date as day
        )
        select
          days.day::text as date,
          count(t.id)::int as "createdTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'completed')::int as "completedTasks"
        from days
        left join daily_task t on t.task_date = days.day
        group by days.day
        order by days.day
      `),
    ]);

    const users = usersResult.rows.map((user) => {
      const completionRate = percentage(user.completedTasks, user.totalTasks);
      const estimateAccuracy = user.actualMinutes
        ? Math.max(0, Math.round(100 - (Math.abs(user.actualMinutes - user.plannedMinutes) / Math.max(1, user.plannedMinutes)) * 100))
        : null;
      return { ...user, focusedSeconds: Number(user.focusedSeconds), completionRate, estimateAccuracy };
    });

    const summary = summaryResult.rows[0];
    summary.focusedSeconds = Number(summary.focusedSeconds);
    summary.completionRate = percentage(summary.completedTasks, summary.totalTasks);

    response.json({
      generatedAt: new Date().toISOString(),
      summary,
      users,
      trend: trendResult.rows,
      warnings: buildWarnings(users),
    });
  } catch (error) {
    next(error);
  }
}

function buildWarnings(users) {
  return users.flatMap((user) => {
    const warnings = [];
    if (user.backlogTasks >= 5) warnings.push({ type: "backlog", userId: user.id, userName: user.name, message: `${user.backlogTasks} tasks are in backlog` });
    if (user.totalTasks >= 5 && user.completionRate < 50) warnings.push({ type: "completion", userId: user.id, userName: user.name, message: `Completion rate is ${user.completionRate}%` });
    if (user.plannedTasks >= 8) warnings.push({ type: "workload", userId: user.id, userName: user.name, message: `${user.plannedTasks} planned tasks remain open` });
    return warnings;
  });
}

function percentage(value, total) {
  return total ? Math.round((Number(value) / Number(total)) * 100) : 0;
}

async function listDatabaseTables() {
  const result = await pool.query(
    `
      select table_schema as schema, table_name as name
        from information_schema.tables
       where table_schema = 'public'
         and table_type = 'BASE TABLE'
       order by table_name
    `,
  );
  return result.rows;
}

async function requireKnownTable(name) {
  const normalized = String(name || "").trim();
  const tables = await listDatabaseTables();
  const table = tables.find((item) => item.name === normalized);
  if (!table) throw notFoundAdminRequest("Database table not found");
  return table;
}

async function getTableSchema(table) {
  const [columnsResult, pkResult] = await Promise.all([
    pool.query(
      `
        select column_name as name, data_type as "dataType", is_nullable = 'YES' as nullable,
               column_default as "defaultValue", identity_generation as "identityGeneration"
          from information_schema.columns
         where table_schema = $1 and table_name = $2
         order by ordinal_position
      `,
      [table.schema, table.name],
    ),
    pool.query(
      `
        select kcu.column_name as name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_name = tc.constraint_name
           and kcu.table_schema = tc.table_schema
           and kcu.table_name = tc.table_name
         where tc.constraint_type = 'PRIMARY KEY'
           and tc.table_schema = $1
           and tc.table_name = $2
         order by kcu.ordinal_position
      `,
      [table.schema, table.name],
    ),
  ]);
  return {
    columns: columnsResult.rows,
    primaryKey: pkResult.rows.map((row) => row.name),
  };
}

function buildRowKey(row, primaryKey) {
  if (primaryKey.length) return Object.fromEntries(primaryKey.map((column) => [column, row[column]]));
  return { __ctid: row.__ctid };
}

function writablePayload(row, schema) {
  const columnMap = new Map(schema.columns.map((column) => [column.name, column]));
  return Object.fromEntries(Object.entries(row)
    .filter(([column]) => columnMap.has(column) && !column.startsWith("__"))
    .filter(([column, value]) => !(value === "" && columnMap.get(column)?.nullable))
    .map(([column, value]) => [column, value === "" && columnMap.get(column)?.nullable ? null : value]));
}

function rowLocator(key, schema, startIndex) {
  const rowKey = key || {};
  if (schema.primaryKey.length) {
    const params = schema.primaryKey.map((column) => rowKey[column]);
    if (params.some((value) => value == null || value === "")) throw badAdminRequest("Primary key is required");
    return {
      where: schema.primaryKey.map((column, index) => `${quoteIdent(column)} = $${startIndex + index}`).join(" and "),
      params,
    };
  }
  if (!rowKey.__ctid) throw badAdminRequest("Row locator is required");
  return { where: `ctid = $${startIndex}::tid`, params: [rowKey.__ctid] };
}

function tableWhere(table) {
  return table.schema === "public" ? "" : "";
}

function quoteTable(table) {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function badAdminRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFoundAdminRequest(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function handleAdminDatabaseError(error, response, next) {
  if (error.status) {
    response.status(error.status).json({ error: error.message, code: "ADMIN_DATABASE_ERROR" });
    return;
  }
  if (["23503", "23505", "23514", "22P02", "22003", "42703", "42601"].includes(error.code)) {
    response.status(400).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
}
