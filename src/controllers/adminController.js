import { pool } from "../config/database.js";
import { getBatches, runBatch } from "../services/batchService.js";

export function getAdminBatches(_request, response) {
  response.json({ batches: getBatches() });
}

export async function runAdminBatch(request, response, next) {
  try {
    const outcome = await runBatch(request.params.batchId);
    if (!outcome.found) {
      response.status(404).json({ error: "Batch process not found" });
      return;
    }
    if (!outcome.accepted) {
      response.status(409).json({ error: "This batch process is already running" });
      return;
    }
    response.json({ batchId: request.params.batchId, completedAt: new Date().toISOString(), result: outcome.result, batches: getBatches() });
  } catch (error) {
    next(error);
  }
}

export async function getAdminInsights(_request, response, next) {
  try {
    const [summaryResult, usersResult, trendResult] = await Promise.all([
      pool.query(`
        select
          (select count(*)::int from daily_user) as "totalUsers",
          count(*)::int as "totalTasks",
          count(*) filter (where lower(trim(status)) = 'completed')::int as "completedTasks",
          count(*) filter (where lower(trim(status)) = 'planned')::int as "plannedTasks",
          count(*) filter (where lower(trim(status)) = 'backlog')::int as "backlogTasks",
          coalesce(sum(estimated_minutes), 0)::int as "plannedMinutes",
          coalesce(sum(actual_minutes) filter (where lower(trim(status)) = 'completed'), 0)::int as "actualMinutes",
          coalesce(sum(focused_seconds), 0)::bigint as "focusedSeconds",
          coalesce(sum(pomodoro_count), 0)::int as "pomodoroCount",
          count(distinct user_id) filter (where created_at >= now() - interval '30 days')::int as "activeUsers30d"
        from daily_task
      `),
      pool.query(`
        select
          u.id::text,
          u.name,
          u.is_admin as "isAdmin",
          count(t.id)::int as "totalTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'completed')::int as "completedTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'planned')::int as "plannedTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'backlog')::int as "backlogTasks",
          coalesce(sum(t.estimated_minutes), 0)::int as "plannedMinutes",
          coalesce(sum(t.actual_minutes) filter (where lower(trim(t.status)) = 'completed'), 0)::int as "actualMinutes",
          coalesce(sum(t.focused_seconds), 0)::bigint as "focusedSeconds",
          coalesce(sum(t.pomodoro_count), 0)::int as "pomodoroCount",
          max(greatest(t.created_at, t.completed_at, t.backlog_at)) as "lastActivityAt"
        from daily_user u
        left join daily_task t on t.user_id = u.id
        group by u.id, u.name, u.is_admin
        order by u.name
      `),
      pool.query(`
        with days as (
          select generate_series(
            (now() at time zone 'Asia/Kolkata')::date - 13,
            (now() at time zone 'Asia/Kolkata')::date,
            interval '1 day'
          )::date as day
        )
        select
          days.day::text as date,
          count(t.id)::int as "createdTasks",
          count(t.id) filter (where lower(trim(t.status)) = 'completed')::int as "completedTasks"
        from days
        left join daily_task t on t.task_date = days.day
        group by days.day
        order by days.day
      `),
    ]);

    const users = usersResult.rows.map((user) => {
      const completionRate = percentage(user.completedTasks, user.totalTasks);
      const estimateAccuracy = user.actualMinutes
        ? Math.max(0, Math.round(100 - (Math.abs(user.actualMinutes - user.plannedMinutes) / Math.max(1, user.plannedMinutes)) * 100))
        : null;
      return { ...user, focusedSeconds: Number(user.focusedSeconds), completionRate, estimateAccuracy };
    });

    const summary = summaryResult.rows[0];
    summary.focusedSeconds = Number(summary.focusedSeconds);
    summary.completionRate = percentage(summary.completedTasks, summary.totalTasks);

    response.json({
      generatedAt: new Date().toISOString(),
      summary,
      users,
      trend: trendResult.rows,
      warnings: buildWarnings(users),
    });
  } catch (error) {
    next(error);
  }
}

function buildWarnings(users) {
  return users.flatMap((user) => {
    const warnings = [];
    if (user.backlogTasks >= 5) warnings.push({ type: "backlog", userId: user.id, userName: user.name, message: `${user.backlogTasks} tasks are in backlog` });
    if (user.totalTasks >= 5 && user.completionRate < 50) warnings.push({ type: "completion", userId: user.id, userName: user.name, message: `Completion rate is ${user.completionRate}%` });
    if (user.plannedTasks >= 8) warnings.push({ type: "workload", userId: user.id, userName: user.name, message: `${user.plannedTasks} planned tasks remain open` });
    return warnings;
  });
}

function percentage(value, total) {
  return total ? Math.round((Number(value) / Number(total)) * 100) : 0;
}
