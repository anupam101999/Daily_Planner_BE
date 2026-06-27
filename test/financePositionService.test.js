import test from "node:test";
import assert from "node:assert/strict";
import { buildClosedTrades, buildPosition, validateTransactionSequence } from "../src/services/financePositionService.js";

const asset = {
  id: "1",
  name: "Example Industries",
  symbol: "EXAMPLE",
  exchange: "NSE",
  sector: "Industrials",
  notes: "",
  lastPrice: 150,
};

function transaction(id, transactionDate, transactionType, quantity, price, charges = 0) {
  return {
    id: String(id),
    assetId: asset.id,
    transactionDate,
    transactionType,
    quantity,
    price,
    charges,
    notes: "",
    createdAt: `2026-01-${String(id).padStart(2, "0")}T00:00:00.000Z`,
  };
}

test("FIFO consumes the oldest buy lots and preserves the remaining cost basis", () => {
  const rows = [
    transaction(1, "2026-01-01", "buy", 100, 100, 100),
    transaction(2, "2026-01-02", "buy", 100, 120, 0),
    transaction(3, "2026-01-03", "sell", 150, 140, 150),
  ];

  const position = buildPosition(asset, rows);
  assert.equal(position.quantity, 50);
  assert.equal(position.investedValue, 6000);
  assert.equal(position.averagePrice, 120);
  assert.equal(position.charges, 0);
  assert.equal(position.soldCost, 16100);
  assert.equal(position.sellValue, 20850);
  assert.equal(position.realizedProfit, 4750);
  assert.equal(position.closedTrades[0].averagePrice, 106.66666666666667);
});

test("open average price ignores fully sold earlier lots", () => {
  const rows = [
    transaction(1, "2025-10-25", "buy", 206, 156.6919, 27.6599),
    transaction(2, "2025-11-25", "sell", 206, 173.5579, 30.6372),
    transaction(3, "2026-03-13", "buy", 430, 117.37, 59.8),
  ];

  const position = buildPosition(asset, rows);
  assert.equal(position.quantity, 430);
  assert.equal(position.investedValue, 50528.9);
  assert.equal(position.averagePrice, 117.37);
  assert.equal(position.charges, 59.8);
  assert.equal(position.closedTrades[0].averagePrice, 156.6919);
});

test("each sell is returned as a distinct closed trade", () => {
  const rows = [
    transaction(1, "2026-01-01", "buy", 10, 100),
    transaction(2, "2026-01-02", "sell", 4, 120, 10),
    transaction(3, "2026-01-03", "sell", 6, 90, 5),
  ];

  const trades = buildClosedTrades([asset], rows);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((trade) => trade.soldQuantity), [4, 6]);
  assert.deepEqual(trades.map((trade) => trade.realizedProfit), [70, -65]);
  assert.equal(buildPosition(asset, rows).status, "sold");
});

test("partial sells leave an open position", () => {
  const rows = [
    transaction(1, "2026-01-01", "buy", 100, 100),
    transaction(2, "2026-01-02", "sell", 40, 110),
  ];
  const position = buildPosition(asset, rows);
  assert.equal(position.status, "open");
  assert.equal(position.quantity, 60);
  assert.equal(position.closedTrades.length, 1);
});

test("validation rejects overselling with an actionable message", () => {
  const validation = validateTransactionSequence([
    transaction(1, "2026-01-01", "buy", 10, 100),
    transaction(2, "2026-01-02", "sell", 11, 110),
  ], asset.symbol);

  assert.equal(validation.valid, false);
  assert.match(validation.message, /cannot sell 11 units/);
  assert.match(validation.message, /only 10 units are available/);
});

test("validation rejects a sell moved before its funding buy", () => {
  const validation = validateTransactionSequence([
    transaction(1, "2026-01-10", "buy", 10, 100),
    transaction(2, "2026-01-05", "sell", 5, 110),
  ], asset.symbol);

  assert.equal(validation.valid, false);
  assert.match(validation.message, /only 0 units are available on that date/);
});
