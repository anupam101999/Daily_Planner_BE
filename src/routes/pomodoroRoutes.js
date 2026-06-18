import { Router } from "express";
import {
  cancelPomodoro,
  completePomodoro,
  getPomodoroState,
  pausePomodoro,
  resumePomodoro,
  startPomodoro,
} from "../controllers/pomodoroController.js";

const router = Router();

router.get("/", getPomodoroState);
router.post("/start", startPomodoro);
router.patch("/:id/pause", pausePomodoro);
router.patch("/:id/resume", resumePomodoro);
router.patch("/:id/complete", completePomodoro);
router.patch("/:id/cancel", cancelPomodoro);

export default router;
