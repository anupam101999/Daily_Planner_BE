import { Router } from "express";
import { createTask, deleteTask, deleteTasks, getTasks, updateTask } from "../controllers/taskController.js";

const router = Router();

router.get("/", getTasks);
router.post("/", createTask);
router.patch("/:id", updateTask);
router.delete("/:id", deleteTask);
router.delete("/", deleteTasks);

export default router;
