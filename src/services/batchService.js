import { refreshAllFinanceQuotesForAllUsers } from "../controllers/financeController.js";
import { pool } from "../config/database.js";
import { rolloverIncompleteTasks } from "./taskRolloverService.js";
import { capturePortfolioSnapshots } from "./portfolioSnapshotService.js";
import { appLog } from "./appLogService.js";

const state = new Map();
const batches = {
  "task-rollover": {
    name: "Daily task rollover",
    description: "Move incomplete planned tasks to today for every planner user.",
    defaultCron: "0 0 * * *",
    defaultEnabled: () => process.env.DAILY_TASK_ROLLOVER_ENABLED !== "false",
    run: rolloverIncompleteTasks,
  },
  "finance-quotes": {
    name: "Finance quote refresh",
    description: "Refresh tracked investment prices for every finance user.",
    defaultCron: "0 16 * * *",
    defaultEnabled: () => process.env.FIN_QUOTE_SYNC_ENABLED !== "false",
    run: refreshAllFinanceQuotesForAllUsers,
  },
  "portfolio-snapshot-daily": {
    name: "Daily portfolio snapshot",
    description: "Capture every portfolio at 6:00 AM each day.",
    defaultCron: "0 6 * * *",
    defaultEnabled: () => process.env.FIN_SNAPSHOT_ENABLED !== "false",
    run: () => capturePortfolioSnapshots("daily"),
  },
  "portfolio-snapshot-weekly": {
    name: "Weekly portfolio snapshot",
    description: "Capture every portfolio at 6:00 AM each Monday.",
    defaultCron: "0 6 * * 1",
    defaultEnabled: () => process.env.FIN_SNAPSHOT_ENABLED !== "false",
    run: () => capturePortfolioSnapshots("weekly"),
  },
  "portfolio-snapshot-monthly": {
    name: "Monthly portfolio snapshot",
    description: "Capture every portfolio at 6:00 AM on the first day of each month.",
    defaultCron: "0 6 1 * *",
    defaultEnabled: () => process.env.FIN_SNAPSHOT_ENABLED !== "false",
    run: () => capturePortfolioSnapshots("monthly"),
  },
  "portfolio-snapshot-fiscal-year": {
    name: "Fiscal-year portfolio snapshot",
    description: "Capture every portfolio at 6:00 AM on 1 April.",
    defaultCron: "0 6 1 4 *",
    defaultEnabled: () => process.env.FIN_SNAPSHOT_ENABLED !== "false",
    run: () => capturePortfolioSnapshots("fiscal_year"),
  },
  "log-retention": {
    name: "Three-day log retention",
    description: "Remove application logs and completed batch history older than three days.",
    defaultCron: "30 6 * * *",
    defaultEnabled: () => process.env.LOG_RETENTION_ENABLED !== "false",
    run: cleanupOperationalLogs,
  },
};

export async function getBatches() {
  const schedules = await getBatchSchedules();
  const latest = await pool.query(`select distinct on (batch_id) batch_id,run_status,started_at,finished_at,error_message,result
    from fin_batch_run order by batch_id,started_at desc`);
  const latestById = new Map(latest.rows.map((row) => [row.batch_id, row]));
  return Object.entries(batches).map(([id, batch]) => ({
    id,
    name: batch.name,
    description: batch.description,
    schedule: schedules.get(id).cronExpression,
    cronExpression: schedules.get(id).cronExpression,
    schedulerEnabled: schedules.get(id).enabled,
    running: state.get(id)?.running === true,
    lastStartedAt: state.get(id)?.lastStartedAt || latestById.get(id)?.started_at || null,
    lastCompletedAt: state.get(id)?.lastCompletedAt || latestById.get(id)?.finished_at || null,
    lastError: state.get(id)?.lastError || latestById.get(id)?.error_message || "",
    lastWarning: state.get(id)?.lastWarning || "",
  }));
}

export async function getBatchSchedules() {
  const result = await pool.query("select batch_id as id, cron_expression as \"cronExpression\", enabled from daily_batch_schedule");
  const stored = new Map(result.rows.map((row) => [row.id, row]));
  return new Map(Object.entries(batches).map(([id, batch]) => [id, stored.get(id) || { id, cronExpression: batch.defaultCron, enabled: batch.defaultEnabled() }]));
}

export async function saveBatchSchedule(id, { cronExpression, enabled }) {
  if (!batches[id]) return { found: false };
  await pool.query(
    `insert into daily_batch_schedule (batch_id, cron_expression, enabled, updated_at)
     values ($1, $2, $3, now())
     on conflict (batch_id) do update set cron_expression = excluded.cron_expression, enabled = excluded.enabled, updated_at = now()`,
    [id, cronExpression, enabled],
  );
  return { found: true };
}

export async function runBatch(id, { source = "manual" } = {}) {
  const batch = batches[id];
  if (!batch) return { found: false };
  if (state.get(id)?.running) return { found: true, accepted: false };

  const startedAt = new Date().toISOString();
  const runResult = await pool.query(`insert into fin_batch_run (batch_id,run_source) values ($1,$2) returning id`, [id, source]);
  const runId = runResult.rows[0].id;
  state.set(id, { ...state.get(id), running: true, lastStartedAt: startedAt, lastError: "", lastWarning: "" });
  try {
    const result = await batch.run();
    const lastWarning = Object.entries(result?.sourceErrors || {}).filter(([, message]) => message).map(([source, message]) => `${source.toUpperCase()}: ${message}`).join("; ");
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: "", lastWarning });
    await pool.query(`update fin_batch_run set run_status='success',finished_at=now(),duration_ms=$2,result=$3::jsonb where id=$1`,
      [runId, Date.now() - new Date(startedAt).getTime(), JSON.stringify(result || {})]);
    if (Number(result?.failed || 0) > 0) appLog.warn("batch.partial_failure", { message: `${batch.name} completed with failures`, batchId: id, failures: result.failures || [], result });
    return { found: true, accepted: true, result };
  } catch (error) {
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: error.message, lastWarning: "" });
    await pool.query(`update fin_batch_run set run_status='failed',finished_at=now(),duration_ms=$2,error_message=$3 where id=$1`,
      [runId, Date.now() - new Date(startedAt).getTime(), error.message]).catch(() => {});
    appLog.error("batch.failed", { message: error.message, batchId: id, source });
    throw error;
  }
}

async function cleanupOperationalLogs() {
  const [logs, runs] = await Promise.all([
    pool.query(`delete from app_log where created_at < now() - interval '3 days'`),
    pool.query(`delete from fin_batch_run where started_at < now() - interval '3 days' and run_status <> 'running'`),
  ]);
  return { deletedAppLogs: logs.rowCount, deletedBatchRuns: runs.rowCount, retentionDays: 3 };
}
