import cron from "node-cron";
import { runBatch } from "./batchService.js";

async function runInsiderTradeSync() {
  try {
    const outcome = await runBatch("insider-trades");
    if (!outcome.accepted) return;
    const result = outcome.result;
    if (result.skipped) {
      console.log(`Insider disclosure sync skipped: ${result.reason}`);
      return;
    }
    console.log(`Insider disclosure sync completed: ${result.inserted}/${result.received} new, ${result.updated || 0} enriched, ${result.ignored} duplicate(s)`);
  } catch (error) {
    console.error("Insider disclosure sync failed", error);
  }
}

export function startInsiderTradeScheduler() {
  if (process.env.FIN_INSIDER_SYNC_ENABLED === "false") return null;
  const task = cron.schedule(
    process.env.FIN_INSIDER_SYNC_CRON || "15 */6 * * *",
    runInsiderTradeSync,
    { timezone: "Asia/Kolkata" },
  );
  void runInsiderTradeSync();
  return task;
}
