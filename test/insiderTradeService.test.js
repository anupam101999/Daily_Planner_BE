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
