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
import { backfillInsiderTradesFeature, getBackfillStatusFeature, getInsiderTradesFeature, syncInsiderTradesFeature } from "../controllers/insiderTradeController.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

router.get("/overview", getFinanceOverview);
router.get("/analytics", getAnalyticsFeature);
router.get("/assets/held", getHeldStockOptions);
router.get("/holdings", getHoldingsFeature);
router.get("/profit", getProfitFeature);
router.get("/ledger", getLedgerFeature);
router.get("/insider-trades", getInsiderTradesFeature);
router.post("/insider-trades/sync", requireAdmin, syncInsiderTradesFeature);
router.post("/insider-trades/sync-last-7-days", requireAdmin, syncInsiderTradesFeature);
router.post("/insider-trades/backfill", requireAdmin, backfillInsiderTradesFeature);
router.get("/insider-trades/backfill/status", requireAdmin, getBackfillStatusFeature);

// Keep historical automation compatible with the former market-intelligence URLs.
router.post("/market-intelligence/insider-trades/backfill", requireAdmin, backfillInsiderTradesFeature);
router.get("/market-intelligence/insider-trades/backfill/status", requireAdmin, getBackfillStatusFeature);

router.post("/sync", syncFinanceQuotes);
router.post("/holdings", createHolding);
router.patch("/holdings/:id", updateHolding);
router.delete("/holdings/:id", deleteHolding);
router.post("/holdings/:id/sell", sellHolding);
router.post("/dividends", createDividend);
router.patch("/transactions/:id", updateTransaction);
router.delete("/transactions/:id", deleteTransaction);

export default router;
