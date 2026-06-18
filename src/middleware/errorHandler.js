export function errorHandler(error, _request, response, _next) {
  console.error(error);

  if (isDatabaseCapacityError(error)) {
    response.status(503).json({
      error: "Database is busy. Please retry shortly.",
      code: "DATABASE_BUSY",
    });
    return;
  }

  response.status(500).json({ error: "Server error" });
}

function isDatabaseCapacityError(error) {
  return error?.code === "53300"
    || error?.code === "57P03"
    || /timeout exceeded when trying to connect/i.test(String(error?.message || ""))
    || /remaining connection slots are reserved/i.test(String(error?.message || ""));
}
