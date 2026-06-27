import { Router } from "express";
import { getAdminBatches, getAdminInsights, getAdminLogs, getAdminSettings, runAdminBatch, updateAdminBatchSchedule, updateAdminSettings } from "../controllers/adminController.js";

const router = Router();

router.get("/insights", getAdminInsights);
router.get("/batches", getAdminBatches);
router.get("/logs", getAdminLogs);
router.get("/settings", getAdminSettings);
router.post("/batches/:batchId/run", runAdminBatch);
router.patch("/batches/:batchId/schedule", updateAdminBatchSchedule);
router.patch("/settings", updateAdminSettings);

export default router;
