import { pool } from "../config/database.js";
import { publishPlannerEvent } from "../services/realtimeService.js";

const sessionColumns = `
  p.id::text,
  p.task_id::text as "taskId",
  p.mode,
  p.status,
  p.duration_seconds as "durationSeconds",
  p.remaining_seconds as "remainingSeconds",
  p.elapsed_seconds as "elapsedSeconds",
  p.started_at as "startedAt",
  p.ends_at as "endsAt",
  p.completed_at as "completedAt",
  task.subject as "taskSubject",
  task.parent_subject as "parentSubject"
`;

export async function getPomodoroState(request, response, next) {
  try {
    await completeExpiredSession(request.dailyUserId);
    const [active, history] = await Promise.all([
      getActiveSession(request.dailyUserId),
      getHistory(request.dailyUserId, 12),
    ]);
    response.json({ active, history });
  } catch (error) {
    next(error);
  }
}

export async function startPomodoro(request, response, next) {
  const taskId = normalizeId(request.body?.taskId);
  const mode = normalizeMode(request.body?.mode);
  const durationMinutes = Number(request.body?.durationMinutes);

  if (!taskId) {
    response.status(400).json({ error: "Select an existing task before starting Pomodoro" });
    return;
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 180) {
    response.status(400).json({ error: "Pomodoro duration must be between 1 and 180 minutes" });
    return;
  }

  try {
    await completeExpiredSession(request.dailyUserId);
    const task = await pool.query(
      "select id, status from daily_task where id = $1 and user_id = $2",
      [taskId, request.dailyUserId],
    );
    if (!task.rowCount) {
      response.status(404).json({ error: "Task not found" });
      return;
    }
    if (String(task.rows[0].status).toLowerCase() !== "planned") {
      response.status(409).json({ error: "Use an active planned task for Pomodoro" });
      return;
    }

    const active = await getActiveSession(request.dailyUserId);
    if (active) {
      response.status(409).json({ error: "Finish or cancel the active Pomodoro first", active });
      return;
    }

    const durationSeconds = Math.round(durationMinutes * 60);
    const result = await pool.query(
      `
        insert into daily_pomodoro_session (
          user_id, task_id, mode, status, duration_seconds, remaining_seconds, ends_at
        )
        values ($1, $2, $3, 'running', $4::int, $4::int, now() + ($4::int * interval '1 second'))
        returning id::text
      `,
      [request.dailyUserId, taskId, mode, durationSeconds],
    );
    const session = await getSessionById(result.rows[0].id, request.dailyUserId);
    publishPlannerEvent("pomodoro-updated", { userId: request.dailyUserId, session });
    response.status(201).json(session);
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({ error: "A Pomodoro is already active" });
      return;
    }
    next(error);
  }
}

export async function pausePomodoro(request, response, next) {
  try {
    const session = await mutateSession(request, response, "pause");
    if (session) response.json(session);
  } catch (error) {
    next(error);
  }
}

export async function resumePomodoro(request, response, next) {
  try {
    const session = await mutateSession(request, response, "resume");
    if (session) response.json(session);
  } catch (error) {
    next(error);
  }
}

export async function completePomodoro(request, response, next) {
  try {
    const result = await finalizeSession(request.params.id, request.dailyUserId, "completed");
    if (!result) {
      response.status(404).json({ error: "Active Pomodoro not found" });
      return;
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
}

export async function cancelPomodoro(request, response, next) {
  try {
    const result = await finalizeSession(request.params.id, request.dailyUserId, "cancelled");
    if (!result) {
      response.status(404).json({ error: "Active Pomodoro not found" });
      return;
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
}

async function mutateSession(request, response, action) {
  const id = normalizeId(request.params.id);
  await completeExpiredSession(request.dailyUserId);
  const current = await getSessionById(id, request.dailyUserId);
  if (!current || !["running", "paused"].includes(current.status)) {
    response.status(404).json({ error: "Active Pomodoro not found" });
    return null;
  }

  if (action === "pause" && current.status !== "running") {
    response.status(409).json({ error: "Pomodoro is already paused" });
    return null;
  }
  if (action === "resume" && current.status !== "paused") {
    response.status(409).json({ error: "Pomodoro is already running" });
    return null;
  }

  if (action === "pause") {
    await pool.query(
      `
        update daily_pomodoro_session
        set status = 'paused',
            remaining_seconds = greatest(0, ceil(extract(epoch from (ends_at - now())))::int),
            ends_at = null
        where id = $1 and user_id = $2 and status = 'running'
      `,
      [id, request.dailyUserId],
    );
  } else {
    await pool.query(
      `
        update daily_pomodoro_session
        set status = 'running', ends_at = now() + (remaining_seconds * interval '1 second')
        where id = $1 and user_id = $2 and status = 'paused'
      `,
      [id, request.dailyUserId],
    );
  }

  const session = await getSessionById(id, request.dailyUserId);
  publishPlannerEvent("pomodoro-updated", { userId: request.dailyUserId, session });
  return session;
}

async function completeExpiredSession(userId) {
  const result = await pool.query(
    `select id::text from daily_pomodoro_session where user_id = $1 and status = 'running' and ends_at <= now() limit 1`,
    [userId],
  );
  if (result.rowCount) await finalizeSession(result.rows[0].id, userId, "completed");
}

async function finalizeSession(id, userId, finalStatus) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const currentResult = await client.query(
      `select * from daily_pomodoro_session where id = $1 and user_id = $2 and status in ('running', 'paused') for update`,
      [id, userId],
    );
    if (!currentResult.rowCount) {
      await client.query("rollback");
      return null;
    }

    const current = currentResult.rows[0];
    const remaining = current.status === "running" && current.ends_at
      ? Math.max(0, Math.ceil((new Date(current.ends_at).getTime() - Date.now()) / 1000))
      : Number(current.remaining_seconds || 0);
    const completed = finalStatus === "completed";
    const elapsedSeconds = completed
      ? Number(current.duration_seconds)
      : Math.max(0, Number(current.duration_seconds) - remaining);

    await client.query(
      `
        update daily_pomodoro_session
        set status = $3, remaining_seconds = $4, ends_at = null,
            elapsed_seconds = $5,
            completed_at = case when $3 = 'completed' then now() else null end
        where id = $1 and user_id = $2
      `,
      [id, userId, finalStatus, completed ? 0 : remaining, elapsedSeconds],
    );

    let task = null;
    if (completed && current.mode === "focus" && elapsedSeconds > 0) {
      const taskResult = await client.query(
        `
          update daily_task
          set focused_seconds = focused_seconds + $3,
              pomodoro_count = pomodoro_count + 1
          where id = $1 and user_id = $2
          returning id::text, subject, parent_subject as "parentSubject",
            task_date::text as date, estimated_minutes as "estimatedMinutes",
            actual_minutes as "actualMinutes", focused_seconds as "focusedSeconds",
            pomodoro_count as "pomodoroCount", start_time as "startTime",
            sort_time as "sortTime", priority, notes, lower(trim(status)) as status,
            created_at as "createdAt", completed_at as "completedAt", backlog_at as "backlogAt"
        `,
        [current.task_id, userId, elapsedSeconds],
      );
      task = taskResult.rows[0] || null;
    }

    await client.query("commit");
    const session = await getSessionById(id, userId);
    publishPlannerEvent("pomodoro-updated", { userId, session: null, completedSession: session });
    if (task) publishPlannerEvent("task-updated", { userId, task });
    return { session, task };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function getActiveSession(userId) {
  const result = await pool.query(
    `
      select ${sessionColumns}
      from daily_pomodoro_session p
      join daily_task task on task.id = p.task_id
      where p.user_id = $1 and p.status in ('running', 'paused')
      order by p.created_at desc
      limit 1
    `,
    [userId],
  );
  return result.rows[0] || null;
}

async function getSessionById(id, userId) {
  if (!id) return null;
  const result = await pool.query(
    `
      select ${sessionColumns}
      from daily_pomodoro_session p
      join daily_task task on task.id = p.task_id
      where p.id = $1 and p.user_id = $2
    `,
    [id, userId],
  );
  return result.rows[0] || null;
}

async function getHistory(userId, limit) {
  const result = await pool.query(
    `
      select ${sessionColumns}
      from daily_pomodoro_session p
      join daily_task task on task.id = p.task_id
      where p.user_id = $1 and p.status in ('completed', 'cancelled')
      order by p.created_at desc
      limit $2
    `,
    [userId, limit],
  );
  return result.rows;
}

function normalizeId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

function normalizeMode(value) {
  return ["short_break", "long_break"].includes(value) ? value : "focus";
}
