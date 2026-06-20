import { pool } from "../config/database.js";

const sensitiveKey = /password|token|secret|authorization|cookie|api.?key/i;

function cleanMeta(meta = {}) {
  return Object.fromEntries(Object.entries(meta).filter(([key, value]) => value != null && !sensitiveKey.test(key)));
}

export function writeAppLog(level, event, meta = {}) {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) return;
  const safeLevel = ["info", "warn", "error"].includes(level) ? level : "info";
  const message = String(meta.message || `${meta.method || ""} ${meta.path || event}`.trim());
  setImmediate(() => pool.query(
    `insert into app_log (level,event,message,request_id,user_id,method,path,status_code,duration_ms,meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [safeLevel, event, message, meta.requestId || null, meta.userId || null, meta.method || null,
      meta.path || null, meta.statusCode || null, meta.durationMs || null, JSON.stringify(cleanMeta(meta))],
  ).catch(() => {}));
}

export const appLog = {
  info: (event, meta) => writeAppLog("info", event, meta),
  warn: (event, meta) => writeAppLog("warn", event, meta),
  error: (event, meta) => writeAppLog("error", event, meta),
};
