import { Router } from "express";
import { getAdminInsights } from "../controllers/adminController.js";

const router = Router();

router.get("/insights", getAdminInsights);

export default router;
