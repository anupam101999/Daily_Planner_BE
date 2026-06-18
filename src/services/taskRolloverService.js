import { pool } from "../config/database.js";
import { publishPlannerEvent } from "./realtimeService.js";

const rolloverLockId = 24062026;

const rolloverTaskColumns = `
  id::text,
  subject,
  parent_subject as "parentSubject",
  task_date::text as date,
  estimated_minutes as "estimatedMinutes",
  actual_minutes as "actualMinutes",
  focused_seconds as "focusedSeconds",
  pomodoro_count as "pomodoroCount",
  start_time as "startTime",
  sort_time as "sortTime",
  priority,
  notes,
  lower(trim(status)) as status,
  created_at as "createdAt",
  completed_at as "completedAt",
  backlog_at as "backlogAt",
  user_id::text as "userId"
`;

export async function rolloverIncompleteTasks(userId = null) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [rolloverLockId]);

    const result = await client.query(
      `
        update daily_task
        set task_date = (now() at time zone 'Asia/Kolkata')::date
        where status = 'planned'
          and task_date < (now() at time zone 'Asia/Kolkata')::date
          and ($1::bigint is null or user_id = $1)
        returning ${rolloverTaskColumns}
      `,
      [userId],
    );

    const dateResult = await client.query(
      "select (now() at time zone 'Asia/Kolkata')::date::text as date",
    );

    await client.query("commit");

    for (const task of result.rows) {
      const { userId: taskUserId, ...publicTask } = task;
      publishPlannerEvent("task-updated", { userId: taskUserId, task: publicTask });
    }

    return {
      date: dateResult.rows[0].date,
      movedCount: result.rowCount,
      tasks: result.rows.map(({ userId: _userId, ...task }) => task),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
