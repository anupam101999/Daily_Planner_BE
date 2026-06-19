import cron from "node-cron";
import { runBatch } from "./batchService.js";

async function runFinanceQuoteSync() {
  try {
    const outcome = await runBatch("finance-quotes");
    if (!outcome.accepted) return;
    const result = outcome.result;
    console.log(`Finance quote sync completed: ${result.updated}/${result.checked} quote(s) updated, ${result.failed} failed`);
  } catch (error) {
    console.error("Finance quote sync failed", error);
  }
}

export function startFinanceQuoteScheduler() {
  if (process.env.FIN_QUOTE_SYNC_ENABLED === "false") return null;

  return cron.schedule(
    "0 16 * * *",
    runFinanceQuoteSync,
    { timezone: "Asia/Kolkata" },
  );
}
