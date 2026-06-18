import { Router } from "express";
import { createProfile, createUser, getCurrentUser, getUsers, loginUser, refreshSession, switchUser } from "../controllers/userController.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireUser } from "../middleware/requireUser.js";

const router = Router();

router.post("/", createUser);
router.post("/register", createUser);
router.post("/login", loginUser);
router.post("/refresh", refreshSession);
router.get("/me", requireUser, getCurrentUser);
router.get("/", requireUser, requireAdmin, getUsers);
router.post("/profiles", requireUser, requireAdmin, createProfile);
router.post("/switch", requireUser, requireAdmin, switchUser);

export default router;
