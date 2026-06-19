import test from "node:test";
import assert from "node:assert/strict";
import { buildPeriodPerformance } from "../src/controllers/financeController.js";
import { buildPosition } from "../src/services/financePositionService.js";

const asset = {
  id: "1",
  name: "Example Industries",
  symbol: "EXAMPLE",
  exchange: "NSE",
  sector: "Industrials",
  notes: "",
  lastPrice: 150,
};

function transaction(id, date, type, quantity, price, charges = 0) {
  return {
    id: String(id),
    assetId: asset.id,
    transactionDate: date,
    transactionType: type,
    quantity,
    price,
    charges,
    notes: "",
    createdAt: `${date}T00:00:00.000Z`,
  };
}

test("alpha return combines period realized and current unrealized profit", () => {
  const transactions = [
    transaction(1, "2025-01-01", "buy", 100, 100),
    transaction(2, "2026-05-01", "sell", 40, 140),
  ];
  const holding = buildPosition(asset, transactions);
  const performance = buildPeriodPerformance([holding], transactions, new Map(), "2026-04-01", "2026-06-30");

  assert.equal(performance.realizedProfit, 1600);
  assert.equal(performance.unrealizedProfit, 3000);
  assert.equal(performance.profit, 4600);
  assert.equal(performance.realizedCost, 4000);
  assert.equal(performance.unrealizedCost, 6000);
  assert.equal(performance.returnPercent, 46);
});
