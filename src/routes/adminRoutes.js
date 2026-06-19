import { Router } from "express";
import { getAdminBatches, getAdminInsights, runAdminBatch, updateAdminBatchSchedule } from "../controllers/adminController.js";

const router = Router();

router.get("/insights", getAdminInsights);
router.get("/batches", getAdminBatches);
router.post("/batches/:batchId/run", runAdminBatch);
router.patch("/batches/:batchId/schedule", updateAdminBatchSchedule);

export default router;
