import cron from "node-cron";
import { rolloverIncompleteTasks } from "./taskRolloverService.js";

async function runDailyTaskRollover() {
  try {
    const result = await rolloverIncompleteTasks();
    console.log(`Daily task rollover completed: ${result.movedCount} task(s) moved to ${result.date}`);
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
