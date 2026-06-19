import test from "node:test";
import assert from "node:assert/strict";
import { errorHandler } from "../src/middleware/errorHandler.js";

test("error handler returns structured client errors with request IDs", () => {
  const output = createResponse();
  errorHandler(Object.assign(new Error("Invalid quantity"), { status: 400, code: "INVALID_QUANTITY" }), createRequest(), output.response, () => {});
  assert.equal(output.status, 400);
  assert.deepEqual(output.body, { error: "Invalid quantity", code: "INVALID_QUANTITY", requestId: "request-1" });
});

test("error handler hides internal error details", () => {
  const output = createResponse();
  errorHandler(new Error("database password leaked"), createRequest(), output.response, () => {});
  assert.equal(output.status, 500);
  assert.deepEqual(output.body, { error: "The server could not complete this request", code: "INTERNAL_ERROR", requestId: "request-1" });
});

function createRequest() {
  return { requestId: "request-1", method: "GET", originalUrl: "/test" };
}

function createResponse() {
  const output = { status: 0, body: null };
  output.response = {
    status(value) { output.status = value; return this; },
    json(value) { output.body = value; return this; },
  };
  return output;
}
