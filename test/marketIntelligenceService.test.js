import test from "node:test";
import assert from "node:assert/strict";
import { marketIntelligenceTestUtils as utils, NEWS_COUNTRIES } from "../src/services/marketIntelligenceService.js";

test("India is the default news country", () => {
  assert.equal(NEWS_COUNTRIES[0].code, "IN");
  assert.equal(NEWS_COUNTRIES[0].name, "India");
});

test("institutional flow values are normalized as numbers", () => {
  assert.deepEqual(utils.normalizeInstitutionalFlow({ category: "DII", date: "18-Jun-2026", buyValue: "16,163.18", sellValue: "12646.37", netValue: "3516.81" }), {
    category: "DII",
    date: "18-Jun-2026",
    buyValue: 16163.18,
    sellValue: 12646.37,
    netValue: 3516.81,
    unit: "INR crore",
  });
});

test("NSE insider disclosures preserve Buy/Sell, mode, quantity, and value", () => {
  const row = utils.normalizeInsiderTrade({ did: "1", symbol: "ABC", company: "ABC Ltd", acqName: "A Promoter", personCategory: "Promoter", tdpTransactionType: "Buy", acqMode: "Market Purchase", secAcq: "45,000", secVal: "17400000", acqfromDt: "17-Jun-2026", date: "18-Jun-2026 10:00", xbrl: "https://nsearchives.nseindia.com/test.xml" });
  assert.equal(row.transactionType, "Buy");
  assert.equal(row.acquisitionMode, "Market Purchase");
  assert.equal(row.quantity, 45000);
  assert.equal(row.value, 17400000);
  assert.equal(row.disclosureUrl, "https://nsearchives.nseindia.com/test.xml");
  assert.equal(row.date, "17-Jun-2026");
});

test("NSE insider dates normalize for exact-date filtering", () => {
  assert.equal(utils.insiderDate("31-Dec-2025 21:33"), "2025-12-31");
  assert.equal(utils.insiderDate("1-Jan-2026"), "2026-01-01");
});

test("future activity dates and activity after disclosure are rejected", () => {
  assert.equal(utils.hasInvalidInsiderActivityDate({ date: "09-Nov-2026", disclosureDate: "11-Mar-2026 15:17" }), true);
  assert.equal(utils.hasInvalidInsiderActivityDate({ date: "09-Mar-2026", disclosureDate: "12-Mar-2026 16:27" }), false);
});

test("insider search tolerates common company-name spelling mistakes", () => {
  const row = { symbol: "SENORES", company: "Senores Pharmaceuticals Limited", person: "A Promoter", category: "Promoter", transactionType: "Buy", acquisitionMode: "Market Purchase" };
  assert.equal(utils.matchesInsiderSearch(row, "senorous pharam"), true);
  assert.equal(utils.matchesInsiderSearch(row, "unrelated bank"), false);
});

test("exact insider search does not include merely similar people", () => {
  const amanta = { symbol: "BSE:544502", company: "Amanta Healthcare Ltd", person: "Bhavesh Patel" };
  const unrelated = { symbol: "BSE:504080", company: "JSL Industries Ltd", person: "Saatyaki Anant Amin" };
  assert.equal(utils.matchesInsiderSearchExact(amanta, "AMANTA"), true);
  assert.equal(utils.matchesInsiderSearchExact(unrelated, "AMANTA"), false);
});

test("company and ticker matches take priority over insider-name matches", () => {
  assert.equal(utils.matchesInsiderPrimarySearch({ symbol: "BSE:544502", company: "Amanta Healthcare Ltd", person: "Bhavesh Patel" }, "AMANTA"), true);
  assert.equal(utils.matchesInsiderPrimarySearch({ symbol: "PERSISTENT", company: "Sasken Technologies Ltd", person: "Mrinmoy Samanta" }, "AMANTA"), false);
});

test("BSE insider disclosures normalize into the shared trade shape", () => {
  const row = utils.normalizeBseInsiderTrade({ Fld_ID: 7, Fld_ScripCode: 544054, Companyname: "Suraj Estate Developers Ltd", Fld_PromoterName: "Shreepal Shah", Fld_PersonCatgName: "KMP", Fld_TransactionType: "Acquisition", ModeOfAquisation: "Market Purchase", Fld_SecurityNo: "1,800", Fld_SecurityValue: "355130.00", Fld_FromDate: "2026-06-17T00:00:00", xbrlurl: "/XBRLFILES/test.xml" });
  assert.equal(row.symbol, "BSE:544054");
  assert.equal(row.transactionType, "Buy");
  assert.equal(row.quantity, 1800);
  assert.equal(row.value, 355130);
  assert.equal(row.date, "17-Jun-2026");
  assert.equal(row.source, "BSE");
});

test("dual-listed insider disclosures merge without hiding their sources", () => {
  const shared = { company: "ABC Limited", person: "A Promoter", transactionType: "Buy", quantity: 100, value: 1000, date: "17-Jun-2026", disclosureUrl: "" };
  const rows = utils.mergeInsiderTrades([{ ...shared, id: "n", symbol: "ABC", source: "NSE" }, { ...shared, id: "b", symbol: "BSE:500001", source: "BSE" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "ABC");
  assert.equal(rows[0].source, "NSE / BSE");
});

test("BSE yearly requests are split into periods of at most 90 days", () => {
  const ranges = utils.bseDateRanges(2025);
  assert.equal(ranges[0].from, "2025-01-01");
  assert.equal(ranges.at(-1).to, "2025-12-31");
  assert.ok(ranges.every((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86400000 <= 89));
});

test("portfolio filtering matches normalized exchange symbols", () => {
  const rows = [{ symbol: "RELIANCE" }, { symbol: "HDFCBANK.NS" }, { symbol: "INFY" }];
  assert.deepEqual(utils.filterBySymbols(rows, ["HDFCBANK", "INFY"]), [rows[1], rows[2]]);
});

test("earnings and dividend disclosures are classified by purpose", () => {
  assert.equal(utils.isEarningsEvent({ purpose: "Financial Results", description: "Quarterly results" }), true);
  assert.equal(utils.isEarningsEvent({ purpose: "Appointment of director", description: "" }), false);
  assert.equal(utils.isDividendAction({ subject: "Dividend - Rs 13 Per Share" }), true);
});

test("promoter holding changes compare distinct reporting periods", () => {
  const rows = [
    { symbol: "ABC", name: "ABC Limited", date: "31-MAR-2026", pr_and_prgrp: "55", public_val: "45" },
    { symbol: "ABC", name: "ABC Limited", date: "31-DEC-2025", pr_and_prgrp: "53.5", public_val: "46.5" },
  ];
  assert.deepEqual(utils.buildPromoterHoldings(rows, ["ABC"])[0], {
    symbol: "ABC",
    company: "ABC Limited",
    period: "31-MAR-2026",
    promoterPercent: 55,
    publicPercent: 45,
    changePercent: 1.5,
    source: "NSE shareholding disclosure",
  });
});
