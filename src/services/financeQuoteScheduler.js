import cron from "node-cron";
import { refreshAllFinanceQuotesForAllUsers } from "../controllers/financeController.js";

async function runFinanceQuoteSync() {
  try {
    const result = await refreshAllFinanceQuotesForAllUsers();
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
