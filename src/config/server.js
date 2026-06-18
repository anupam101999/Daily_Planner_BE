import "dotenv/config";
import app from "../app.js";
import { initDatabase } from "./database.js";
import { startDailyTaskRolloverScheduler } from "../services/dailyTaskRolloverScheduler.js";
import { startFinanceQuoteScheduler } from "../services/financeQuoteScheduler.js";

const port = Number(process.env.PORT || process.env.API_PORT || 4000);

initDatabase()
  .then(() => {
    startDailyTaskRolloverScheduler();
    startFinanceQuoteScheduler();
    app.listen(port, "0.0.0.0", () => {
      console.log(`Planner API running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start API", error);
    process.exit(1);
  });
