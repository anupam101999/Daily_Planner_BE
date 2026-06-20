import test from "node:test";
import assert from "node:assert/strict";
import { buildBackfillDates, priceOnOrBefore } from "../src/services/portfolioSnapshotBackfillService.js";

test("backfill creates completed weekly, monthly, and fiscal-year dates", () => {
  assert.deepEqual(buildBackfillDates("2026-03-28", "2026-04-05"), [
    { type: "weekly", date: "2026-03-29" },
    { type: "monthly", date: "2026-03-31" },
    { type: "fiscal_year", date: "2026-03-31" },
    { type: "weekly", date: "2026-04-05" },
  ]);
});

test("historical valuation uses the latest prior trading close", () => {
  const points = [{ date: "2026-06-18", price: 100 }, { date: "2026-06-19", price: 105 }];
  assert.equal(priceOnOrBefore(points, "2026-06-21"), 105);
  assert.equal(priceOnOrBefore(points, "2026-06-17"), null);
});
