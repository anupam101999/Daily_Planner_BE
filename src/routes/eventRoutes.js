import { Router } from "express";
import { subscribeToPlannerEvents } from "../services/realtimeService.js";

const router = Router();

router.get("/", subscribeToPlannerEvents);

export default router;
