import cron from "node-cron";
import { runBatch } from "./batchService.js";

async function runDailyTaskRollover() {
  try {
    const outcome = await runBatch("task-rollover");
    if (!outcome.accepted) return;
    console.log(`Daily task rollover completed: ${outcome.result.movedCount} task(s) moved to ${outcome.result.date}`);
  } catch (error) {
    console.error("Daily task rollover failed", error);
  }
}

export function startDailyTaskRolloverScheduler() {
  if (process.env.DAILY_TASK_ROLLOVER_ENABLED === "false") return null;

  const scheduledTask = cron.schedule(
    "0 0 * * *",
    runDailyTaskRollover,
    { timezone: "Asia/Kolkata" },
  );

  void runDailyTaskRollover();
  return scheduledTask;
}
