import { pool } from "../config/database.js";
import { publishPlannerEvent } from "../services/realtimeService.js";
import { rolloverIncompleteTasks } from "../services/taskRolloverService.js";
import { normalizeTimestamp, toSnakeTask } from "../utils/taskMapper.js";

const taskColumns = `
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
  backlog_at as "backlogAt"
`;

export async function getTasks(request, response, next) {
  try {
    const result = await pool.query(`
      select ${taskColumns}
      from daily_task
      where user_id = $1
      order by task_date desc, sort_time asc, created_at desc
    `, [request.dailyUserId]);
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
}

export async function rolloverTasks(_request, response, next) {
  try {
    const result = await rolloverIncompleteTasks();
    response.json(result);
  } catch (error) {
    next(error);
  }
}

export async function createTask(request, response, next) {
  try {
    const task = request.body;
    const parentSubject = String(task.parentSubject || "").trim();
    if (!parentSubject) {
      response.status(400).json({ error: "Parent subject is required" });
      return;
    }
    const status = normalizeStatus(task.status);
    const result = await pool.query(
      `
        insert into daily_task (
          subject, parent_subject, task_date, estimated_minutes, start_time, sort_time,
          priority, notes, status, completed_at, backlog_at, user_id, actual_minutes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        returning ${taskColumns}
      `,
      [
        task.subject,
        parentSubject,
        task.date,
        Number(task.estimatedMinutes || 0),
        task.startTime || null,
        task.sortTime || "99:99",
        task.priority || "low",
        task.notes || "",
        status,
        status === "completed" ? new Date() : null,
        status === "backlog" ? new Date() : null,
        request.dailyUserId,
        task.actualMinutes == null ? null : Number(task.actualMinutes),
      ],
    );
    const createdTask = result.rows[0];
    publishPlannerEvent("task-created", { userId: request.dailyUserId, task: createdTask });
    response.status(201).json(createdTask);
  } catch (error) {
    next(error);
  }
}

export async function updateTask(request, response, next) {
  try {
    const current = await pool.query("select * from daily_task where id = $1 and user_id = $2", [request.params.id, request.dailyUserId]);
    if (!current.rowCount) {
      response.status(404).json({ error: "Task not found" });
      return;
    }

    const task = { ...current.rows[0], ...toSnakeTask(request.body) };
    const parentSubject = String(task.parent_subject || "").trim();
    if (!parentSubject) {
      response.status(400).json({ error: "Parent subject is required" });
      return;
    }
    const result = await pool.query(
      `
        update daily_task
        set subject = $2, parent_subject = $3, task_date = $4, estimated_minutes = $5,
          start_time = $6, sort_time = $7, priority = $8, notes = $9,
          status = $10, completed_at = $11, backlog_at = $12,
          actual_minutes = $13
        where id = $1 and user_id = $14
        returning ${taskColumns}
      `,
      [
        request.params.id,
        task.subject,
        parentSubject,
        task.task_date,
        Number(task.estimated_minutes || 0),
        task.start_time || null,
        task.sort_time || "99:99",
        task.priority || "low",
        task.notes || "",
        normalizeStatus(task.status),
        normalizeTimestamp(task.completed_at),
        normalizeTimestamp(task.backlog_at),
        task.actual_minutes == null ? null : Number(task.actual_minutes),
        request.dailyUserId,
      ],
    );
    const updatedTask = result.rows[0];
    if (updatedTask.status !== "planned") {
      const cancelled = await pool.query(
        `
          update daily_pomodoro_session
          set status = 'cancelled', ends_at = null,
              remaining_seconds = case
                when status = 'running' then greatest(0, ceil(extract(epoch from (ends_at - now())))::int)
                else remaining_seconds
              end,
              elapsed_seconds = duration_seconds - case
                when status = 'running' then greatest(0, ceil(extract(epoch from (ends_at - now())))::int)
                else remaining_seconds
              end
          where task_id = $1 and user_id = $2 and status in ('running', 'paused')
          returning id
        `,
        [request.params.id, request.dailyUserId],
      );
      if (cancelled.rowCount) {
        publishPlannerEvent("pomodoro-updated", { userId: request.dailyUserId, session: null });
      }
    }
    publishPlannerEvent("task-updated", { userId: request.dailyUserId, task: updatedTask });
    response.json(updatedTask);
  } catch (error) {
    next(error);
  }
}

function normalizeStatus(status) {
  const value = String(status || "planned").trim().toLowerCase();
  return ["planned", "completed", "backlog"].includes(value) ? value : "planned";
}

export async function deleteTask(request, response, next) {
  try {
    const activePomodoro = await pool.query(
      `select 1 from daily_pomodoro_session where task_id = $1 and user_id = $2 and status in ('running', 'paused')`,
      [request.params.id, request.dailyUserId],
    );
    await pool.query("delete from daily_task where id = $1 and user_id = $2", [request.params.id, request.dailyUserId]);
    if (activePomodoro.rowCount) {
      publishPlannerEvent("pomodoro-updated", { userId: request.dailyUserId, session: null });
    }
    publishPlannerEvent("task-deleted", { userId: request.dailyUserId, id: request.params.id });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function deleteTasks(request, response, next) {
  try {
    const { status, date } = request.query;
    const activePomodoro = await pool.query(
      `
        select 1
        from daily_pomodoro_session p
        join daily_task task on task.id = p.task_id
        where p.user_id = $1
          and p.status in ('running', 'paused')
          and ($2::text is null or lower(trim(task.status)) = $2)
          and ($3::date is null or task.task_date = $3::date)
      `,
      [request.dailyUserId, status ? normalizeStatus(status) : null, date || null],
    );
    if (status && date) {
      await pool.query("delete from daily_task where lower(trim(status)) = $1 and task_date = $2 and user_id = $3", [normalizeStatus(status), date, request.dailyUserId]);
    } else if (status) {
      await pool.query("delete from daily_task where lower(trim(status)) = $1 and user_id = $2", [normalizeStatus(status), request.dailyUserId]);
    }
    if (activePomodoro.rowCount) {
      publishPlannerEvent("pomodoro-updated", { userId: request.dailyUserId, session: null });
    }
    publishPlannerEvent("tasks-deleted", { userId: request.dailyUserId, status: status || null, date: date || null });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
}
