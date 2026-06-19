import { refreshAllFinanceQuotesForAllUsers } from "../controllers/financeController.js";
import { rolloverIncompleteTasks } from "./taskRolloverService.js";
import { syncRecentInsiderTrades } from "./insiderTradeService.js";

const state = new Map();
const batches = {
  "task-rollover": {
    name: "Daily task rollover",
    description: "Move incomplete planned tasks to today for every planner user.",
    schedule: "Daily at 12:00 AM IST",
    enabled: () => process.env.DAILY_TASK_ROLLOVER_ENABLED !== "false",
    run: rolloverIncompleteTasks,
  },
  "finance-quotes": {
    name: "Finance quote refresh",
    description: "Refresh tracked investment prices for every finance user.",
    schedule: "Daily at 4:00 PM IST",
    enabled: () => process.env.FIN_QUOTE_SYNC_ENABLED !== "false",
    run: refreshAllFinanceQuotesForAllUsers,
  },
  "insider-trades": {
    name: "Recent insider trade sync",
    description: "Import the latest NSE and BSE insider disclosures.",
    schedule: process.env.FIN_INSIDER_SYNC_CRON || "Every 6 hours at :15 IST",
    enabled: () => process.env.FIN_INSIDER_SYNC_ENABLED !== "false",
    run: syncRecentInsiderTrades,
  },
};

export function getBatches() {
  return Object.entries(batches).map(([id, batch]) => ({
    id,
    name: batch.name,
    description: batch.description,
    schedule: batch.schedule,
    schedulerEnabled: batch.enabled(),
    running: state.get(id)?.running === true,
    lastStartedAt: state.get(id)?.lastStartedAt || null,
    lastCompletedAt: state.get(id)?.lastCompletedAt || null,
    lastError: state.get(id)?.lastError || "",
  }));
}

export async function runBatch(id) {
  const batch = batches[id];
  if (!batch) return { found: false };
  if (state.get(id)?.running) return { found: true, accepted: false };

  const startedAt = new Date().toISOString();
  state.set(id, { ...state.get(id), running: true, lastStartedAt: startedAt, lastError: "" });
  try {
    const result = await batch.run();
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: "" });
    return { found: true, accepted: true, result };
  } catch (error) {
    state.set(id, { running: false, lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: error.message });
    throw error;
  }
}
