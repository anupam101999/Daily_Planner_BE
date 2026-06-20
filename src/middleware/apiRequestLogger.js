import { writeAppLog } from "../services/appLogService.js";

export function apiRequestLogger(request, response, next) {
  const startedAt = Date.now();
  response.on("finish", () => {
    const statusCode = response.statusCode;
    writeAppLog(statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info", "api.request", {
      requestId: request.requestId,
      userId: request.dailyUserId,
      method: request.method,
      path: request.originalUrl,
      statusCode,
      durationMs: Date.now() - startedAt,
      query: request.query,
      ipAddress: request.ip,
    });
  });
  next();
}
