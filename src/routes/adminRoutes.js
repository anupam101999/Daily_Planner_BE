import { Router } from "express";
import { getAdminBatches, getAdminInsights, runAdminBatch } from "../controllers/adminController.js";

const router = Router();

router.get("/insights", getAdminInsights);
router.get("/batches", getAdminBatches);
router.post("/batches/:batchId/run", runAdminBatch);

export default router;
