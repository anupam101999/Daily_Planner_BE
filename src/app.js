import cors from "cors";
import express from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestContext } from "./middleware/requestContext.js";
import apiRoutes from "./routes/index.js";

const app = express();

app.use(requestContext);
app.use(cors());
app.use(express.json());

app.get("/", (_request, response) => {
  response.status(200).json({
    ok: true,
    name: "Daily Planner API",
    version: "1.0.0",
    status: "running",
    health: "/api/health",
    endpoints: {
      users: "/api/users",
      register: "/api/users/register",
      login: "/api/users/login",
      tasks: "/api/tasks",
      pomodoro: "/api/pomodoro",
      finance: "/api/finance/summary",
      events: "/api/events",
    },
  });
});

app.use("/api", apiRoutes);
app.use((_request, response) => {
  response.status(404).json({
    ok: false,
    error: "Route not found",
    code: "ROUTE_NOT_FOUND",
    requestId: _request.requestId,
    health: "/api/health",
  });
});
app.use(errorHandler);

export default app;
