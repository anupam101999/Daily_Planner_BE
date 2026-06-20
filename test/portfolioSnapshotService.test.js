import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPeriod } from "../src/services/portfolioSnapshotService.js";

test("snapshot periods align to daily, Monday, month, and Indian fiscal-year boundaries", () => {
  assert.deepEqual(snapshotPeriod("daily", "2026-06-20"), { start: "2026-06-20", end: "2026-06-20" });
  assert.deepEqual(snapshotPeriod("weekly", "2026-06-20"), { start: "2026-06-15", end: "2026-06-20" });
  assert.deepEqual(snapshotPeriod("monthly", "2026-06-20"), { start: "2026-06-01", end: "2026-06-20" });
  assert.deepEqual(snapshotPeriod("fiscal_year", "2026-06-20"), { start: "2026-04-01", end: "2026-06-20" });
  assert.deepEqual(snapshotPeriod("fiscal_year", "2026-02-10"), { start: "2025-04-01", end: "2026-02-10" });
});
