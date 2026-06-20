import { Router } from "express";
import {
  createHolding,
  createDividend,
  deleteHolding,
  deleteTransaction,
  getAnalyticsFeature,
  getFinanceOverview,
  getHeldStockOptions,
  getHoldingsFeature,
  getLedgerFeature,
  getProfitFeature,
  sellHolding,
  syncFinanceQuotes,
  updateHolding,
  updateTransaction,
} from "../controllers/financeController.js";
import { backfillHistoricalSnapshots, getPortfolioSnapshots, updatePortfolioSnapshot } from "../controllers/snapshotController.js";

const router = Router();

router.get("/overview", getFinanceOverview);
router.get("/analytics", getAnalyticsFeature);
router.get("/assets/held", getHeldStockOptions);
router.get("/holdings", getHoldingsFeature);
router.get("/profit", getProfitFeature);
router.get("/ledger", getLedgerFeature);
router.get("/snapshots", getPortfolioSnapshots);
router.post("/snapshots/backfill", backfillHistoricalSnapshots);
router.patch("/snapshots/:id", updatePortfolioSnapshot);
router.post("/sync", syncFinanceQuotes);
router.post("/holdings", createHolding);
router.patch("/holdings/:id", updateHolding);
router.delete("/holdings/:id", deleteHolding);
router.post("/holdings/:id/sell", sellHolding);
router.post("/dividends", createDividend);
router.patch("/transactions/:id", updateTransaction);
router.delete("/transactions/:id", deleteTransaction);

export default router;
