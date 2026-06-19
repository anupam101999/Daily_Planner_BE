import "dotenv/config";
import app from "../app.js";
import { initDatabase } from "./database.js";
import { startBatchSchedulers } from "../services/batchSchedulerService.js";

const port = Number(process.env.PORT || process.env.API_PORT || 4000);

initDatabase()
  .then(async () => {
    await startBatchSchedulers();
    app.listen(port, "0.0.0.0", () => {
      console.log(`Planner API running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start API", error);
    process.exit(1);
  });
