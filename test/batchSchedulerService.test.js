import test from "node:test";
import assert from "node:assert/strict";
import { validateCronExpression } from "../src/services/batchSchedulerService.js";

test("batch scheduler accepts supported daily and interval schedules", () => {
  assert.equal(validateCronExpression("30 9 * * *"), true);
  assert.equal(validateCronExpression("15 */6 * * *"), true);
});

test("batch scheduler rejects malformed schedules", () => {
  assert.equal(validateCronExpression("every morning"), false);
  assert.equal(validateCronExpression("90 25 * * *"), false);
});
