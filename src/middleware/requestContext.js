import { randomUUID } from "node:crypto";

export function requestContext(request, response, next) {
  request.requestId = String(request.headers["x-request-id"] || randomUUID());
  response.setHeader("X-Request-Id", request.requestId);
  const sendJson = response.json.bind(response);
  response.json = (body) => {
    if (response.statusCode >= 400 && body?.error) {
      return sendJson({ ...body, code: body.code || statusCodeName(response.statusCode), requestId: body.requestId || request.requestId });
    }
    return sendJson(body);
  };
  next();
}

function statusCodeName(status) {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED";
}
