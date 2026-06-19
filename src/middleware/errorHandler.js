export function errorHandler(error, request, response, _next) {
  const requestId = request.requestId || "unknown";
  console.error({ requestId, method: request.method, path: request.originalUrl, code: error?.code, message: error?.message, stack: error?.stack });

  if (error?.type === "entity.parse.failed") {
    response.status(400).json({ error: "Request body must contain valid JSON", code: "INVALID_JSON", requestId });
    return;
  }

  if (isDatabaseCapacityError(error)) {
    response.status(503).json({
      error: "Database is busy. Please retry shortly.",
      code: "DATABASE_BUSY",
      requestId,
    });
    return;
  }

  const status = Number(error?.status || 500);
  const expose = status >= 400 && status < 500;
  response.status(status).json({
    error: expose ? error.message : "The server could not complete this request",
    code: error?.code || (expose ? "REQUEST_FAILED" : "INTERNAL_ERROR"),
    requestId,
    ...(expose && error?.details ? { details: error.details } : {}),
  });
}

function isDatabaseCapacityError(error) {
  return error?.code === "53300"
    || error?.code === "57P03"
    || /timeout exceeded when trying to connect/i.test(String(error?.message || ""))
    || /remaining connection slots are reserved/i.test(String(error?.message || ""));
}
