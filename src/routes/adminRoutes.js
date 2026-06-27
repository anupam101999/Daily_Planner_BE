import { Router } from "express";
import {
  deleteAdminDatabaseRow,
  getAdminBatches,
  getAdminDatabaseTable,
  getAdminDatabaseTables,
  getAdminInsights,
  getAdminLogs,
  getAdminQuoteAssets,
  getAdminSettings,
  insertAdminDatabaseRow,
  runAdminBatch,
  runAdminDatabaseQuery,
  updateAdminBatchSchedule,
  updateAdminDatabaseRow,
  updateAdminQuoteAsset,
  updateAdminSettings,
} from "../controllers/adminController.js";

const router = Router();

router.get("/insights", getAdminInsights);
router.get("/batches", getAdminBatches);
router.get("/logs", getAdminLogs);
router.get("/settings", getAdminSettings);
router.get("/quote-assets", getAdminQuoteAssets);
router.patch("/quote-assets/:assetId", updateAdminQuoteAsset);
router.get("/database/tables", getAdminDatabaseTables);
router.get("/database/tables/:table", getAdminDatabaseTable);
router.post("/database/tables/:table/rows", insertAdminDatabaseRow);
router.patch("/database/tables/:table/rows", updateAdminDatabaseRow);
router.delete("/database/tables/:table/rows", deleteAdminDatabaseRow);
router.post("/database/query", runAdminDatabaseQuery);
router.post("/batches/:batchId/run", runAdminBatch);
router.patch("/batches/:batchId/schedule", updateAdminBatchSchedule);
router.patch("/settings", updateAdminSettings);

export default router;
