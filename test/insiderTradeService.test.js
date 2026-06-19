import test from "node:test";
import assert from "node:assert/strict";
import { insiderTradeTestUtils as utils } from "../src/services/insiderTradeService.js";

test("insider trade fingerprint is stable across exchange naming differences", () => {
  const trade = { company: "Amanta Healthcare Limited", person: "Bhavesh Girishbhai Patel", date: "17-Jun-2026", transactionType: "Buy", quantity: 4635, value: 696730, acquisitionMode: "Market Purchase" };
  const duplicate = { ...trade, company: "Amanta Healthcare Ltd", source: "BSE", sourceRecordId: "425000" };
  assert.equal(utils.fingerprint(trade), utils.fingerprint(duplicate));
});

test("insider trade fingerprint changes when transaction facts change", () => {
  const trade = { company: "ABC Ltd", person: "A Promoter", date: "17-Jun-2026", transactionType: "Buy", quantity: 100, value: 1000, acquisitionMode: "Market Purchase" };
  assert.notEqual(utils.fingerprint(trade), utils.fingerprint({ ...trade, quantity: 101 }));
});

test("exchange dates convert to database ISO dates", () => {
  assert.equal(utils.exchangeDate("09-Mar-2026"), "2026-03-09");
  assert.equal(utils.exchangeDate("2026-03-09"), "2026-03-09");
  assert.equal(utils.exchangeDate("invalid"), "");
});

test("historical backfill uses calendar month windows", () => {
  assert.deepEqual(utils.monthWindows(2026, "2026-03-18"), [
    { from: "2026-01-01", to: "2026-01-31" },
    { from: "2026-02-01", to: "2026-02-28" },
    { from: "2026-03-01", to: "2026-03-18" },
  ]);
});

test("historical backfill respects selected start and end months", () => {
  assert.deepEqual(utils.backfillMonthWindows({ fromYear: 2025, fromMonth: 11, toYear: 2026, toMonth: 2, today: "2026-06-19" }), [
    { from: "2025-11-01", to: "2025-11-30" },
    { from: "2025-12-01", to: "2025-12-31" },
    { from: "2026-01-01", to: "2026-01-31" },
    { from: "2026-02-01", to: "2026-02-28" },
  ]);
});

test("historical backfill caps the selected current month at today", () => {
  assert.deepEqual(utils.backfillMonthWindows({ fromYear: 2026, fromMonth: 6, toYear: 2026, toMonth: 12, today: "2026-06-19" }), [
    { from: "2026-06-01", to: "2026-06-19" },
  ]);
});
