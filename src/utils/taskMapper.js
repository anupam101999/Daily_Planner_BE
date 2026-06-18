export function toSnakeTask(updates) {
  const next = {};
  if ("subject" in updates) next.subject = updates.subject;
  if ("parentSubject" in updates) next.parent_subject = updates.parentSubject;
  if ("date" in updates) next.task_date = updates.date;
  if ("estimatedMinutes" in updates) next.estimated_minutes = updates.estimatedMinutes;
  if ("actualMinutes" in updates) next.actual_minutes = updates.actualMinutes;
  if ("startTime" in updates) next.start_time = updates.startTime;
  if ("sortTime" in updates) next.sort_time = updates.sortTime;
  if ("priority" in updates) next.priority = updates.priority;
  if ("notes" in updates) next.notes = updates.notes;
  if ("status" in updates) next.status = String(updates.status).trim().toLowerCase();
  if ("completedAt" in updates) next.completed_at = updates.completedAt === null ? null : new Date();
  if ("backlogAt" in updates) next.backlog_at = updates.backlogAt === null ? null : new Date();
  return next;
}

export function normalizeTimestamp(value) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
