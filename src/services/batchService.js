import { refreshAllFinanceQuotesForAllUsers } from "../controllers/financeController.js";
import { pool } from "../config/database.js";
import { rolloverIncompleteTasks } from "./taskRolloverService.js";
import { syncRecentInsiderTrades } from "./insiderTradeService.js";

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
  "insider-trades": {
    name: "Recent insider trade sync",
    description: "Import the latest NSE and BSE insider disclosures.",
    defaultCron: process.env.FIN_INSIDER_SYNC_CRON || "15 */6 * * *",
    defaultEnabled: () => process.env.FIN_INSIDER_SYNC_ENABLED !== "false",
    run: syncRecentInsiderTrades,
  },
};

export async function getBatches() {
  const schedules = await getBatchSchedules();
  return Object.entries(batches).map(([id, batch]) => ({
    id,
    name: batch.name,
    description: batch.description,
    schedule: schedules.get(id).cronExpression,
    cronExpression: schedules.get(id).cronExpression,
    schedulerEnabled: schedules.get(id).enabled,
    running: state.get(id)?.running === true,
    lastStartedAt: state.get(id)?.lastStartedAt || null,
    lastCompletedAt: state.get(id)?.lastCompletedAt || null,
    lastError: state.get(id)?.lastError || "",
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

export async function runBatch(id) {
  const batch = batches[id];
  if (!batch) return { found: false };
  if (state.get(id)?.running) return { found: true, accepted: false };

  const startedAt = new Date().toISOString();
  state.set(id, { ...state.get(id), running: true, lastStartedAt: startedAt, lastError: "", lastWarning: "" });
  try {
    const result = await batch.run();
    const lastWarning = Object.entries(result?.sourceErrors || {}).filter(([, message]) => message).map(([source, message]) => `${source.toUpperCase()}: ${message}`).join("; ");
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: "", lastWarning });
    return { found: true, accepted: true, result };
  } catch (error) {
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: error.message, lastWarning: "" });
    throw error;
  }
}
