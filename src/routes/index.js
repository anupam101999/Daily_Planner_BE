import { Router } from "express";
import { pool } from "../config/database.js";
import eventRoutes from "./eventRoutes.js";
import pomodoroRoutes from "./pomodoroRoutes.js";
import taskRoutes from "./taskRoutes.js";
import userRoutes from "./userRoutes.js";
import { requireUser } from "../middleware/requireUser.js";
import { rolloverTasks } from "../controllers/taskController.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import adminRoutes from "./adminRoutes.js";
import financeRoutes from "./financeRoutes.js";

const router = Router();

router.get("/health", (_request, response) => {
  response.json({
    ok: true,
    databasePool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: pool.options.max,
    },
  });
});
router.use("/users", userRoutes);
router.use("/admin", requireUser, requireAdmin, adminRoutes);
router.post("/tasks/rollover", requireUser, requireAdmin, rolloverTasks);
router.use("/tasks", requireUser, taskRoutes);
router.use("/pomodoro", requireUser, pomodoroRoutes);
router.use("/events", requireUser, eventRoutes);
router.use("/finance", requireUser, financeRoutes);

export default router;
