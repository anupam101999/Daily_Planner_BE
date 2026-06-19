import test from "node:test";
import assert from "node:assert/strict";
import { insiderTradeSourceTestUtils as utils } from "../src/services/insiderTradeSourceService.js";

test("NSE insider filings preserve transaction facts", () => {
  const row = utils.normalizeNseTrade({ did: "1", symbol: "ABC", company: "ABC Ltd", acqName: "A Promoter", personCategory: "Promoter", tdpTransactionType: "Buy", acqMode: "Market Purchase", secAcq: "45,000", secVal: "17400000", acqfromDt: "17-Jun-2026", date: "18-Jun-2026 10:00", xbrl: "https://nsearchives.nseindia.com/test.xml" });
  assert.equal(row.transactionType, "Buy");
  assert.equal(row.quantity, 45000);
  assert.equal(row.value, 17400000);
  assert.equal(row.date, "17-Jun-2026");
});

test("BSE insider filings normalize into the shared trade shape", () => {
  const row = utils.normalizeBseTrade({ Fld_ID: 7, Fld_ScripCode: 544054, Companyname: "Suraj Estate Developers Ltd", Fld_PromoterName: "Shreepal Shah", Fld_TransactionType: "Acquisition", Fld_SecurityNo: "1,800", Fld_SecurityValue: "355130.00", Fld_FromDate: "2026-06-17T00:00:00" });
  assert.equal(row.symbol, "BSE:544054");
  assert.equal(row.transactionType, "Buy");
  assert.equal(row.quantity, 1800);
  assert.equal(row.date, "17-Jun-2026");
});

test("insider filing ranges are split into exchange-safe windows", () => {
  const ranges = utils.splitDateRange("2026-01-01", "2026-03-15", 31);
  assert.equal(ranges[0].from, "2026-01-01");
  assert.equal(ranges.at(-1).to, "2026-03-15");
  assert.ok(ranges.every((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86400000 <= 30));
});
