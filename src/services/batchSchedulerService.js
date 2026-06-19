import cron from "node-cron";
import { getBatchSchedules, runBatch } from "./batchService.js";

const timezone = "Asia/Kolkata";
const scheduledTasks = new Map();

export async function startBatchSchedulers() {
  const schedules = await getBatchSchedules();
  for (const id of schedules.keys()) await rescheduleBatch(id, schedules);

  for (const id of ["task-rollover"]) {
    if (schedules.get(id)?.enabled) void executeScheduledBatch(id);
  }
}

export async function rescheduleBatch(id, providedSchedules = null) {
  const existing = scheduledTasks.get(id);
  if (existing) {
    existing.stop();
    existing.destroy?.();
    scheduledTasks.delete(id);
  }

  const schedules = providedSchedules || await getBatchSchedules();
  const schedule = schedules.get(id);
  if (!schedule?.enabled) return;
  if (!cron.validate(schedule.cronExpression)) throw new Error("Invalid cron schedule");

  scheduledTasks.set(id, cron.schedule(schedule.cronExpression, () => executeScheduledBatch(id), { timezone }));
  console.log(`[Batch scheduler] ${id}: ${schedule.cronExpression} (${timezone})`);
}

export function validateCronExpression(value) {
  return cron.validate(String(value || "").trim());
}

async function executeScheduledBatch(id) {
  try {
    const outcome = await runBatch(id);
    if (outcome.accepted) console.log(`[Batch scheduler] ${id} completed`);
  } catch (error) {
    console.error(`[Batch scheduler] ${id} failed`, error);
  }
}
