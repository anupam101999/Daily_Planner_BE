import test from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../src/middleware/requestContext.js";

test("request context enriches direct controller errors", () => {
  const request = { headers: { "x-request-id": "request-2" } };
  let body;
  const response = {
    statusCode: 404,
    setHeader() {},
    json(value) { body = value; return this; },
  };
  requestContext(request, response, () => {});
  response.json({ error: "Not found" });
  assert.deepEqual(body, { error: "Not found", code: "NOT_FOUND", requestId: "request-2" });
});
