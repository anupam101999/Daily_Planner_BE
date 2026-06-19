import { pool } from "../config/database.js";
import { cancelInsiderTradeBackfill, getInsiderTradeBackfillStatus, getStoredInsiderTrades, queueInsiderTradeBackfill, syncRecentInsiderTrades } from "../services/insiderTradeService.js";

export async function getInsiderTradesFeature(request, response, next) {
  try {
    const scope = request.query.scope === "portfolio" ? "portfolio" : "market";
    const page = Math.max(1, Number(request.query.page || 1));
    const pageSize = Math.max(10, Math.min(100, Number(request.query.pageSize || 50)));
    let symbols = [];
    let companyNames = [];
    if (scope === "portfolio") {
      const result = await pool.query("select symbol, name from fin_asset where user_id = $1", [request.dailyUserId]);
      symbols = result.rows.map((row) => row.symbol);
      companyNames = result.rows.map((row) => row.name);
    }
    response.json(await getStoredInsiderTrades({ year: request.query.year, symbols, companyNames, search: request.query.search, date: request.query.date, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function syncInsiderTradesFeature(request, response, next) {
  try {
    if (request.body?.fromYear != null || request.body?.toYear != null) {
      response.status(400).json({
        error: "Historical year ranges must use the insider-trades/backfill endpoint",
        code: "INSIDER_BACKFILL_ENDPOINT_REQUIRED",
        endpoint: "/api/finance/insider-trades/backfill",
      });
      return;
    }
    response.json(await syncRecentInsiderTrades());
  } catch (error) {
    next(error);
  }
}

export async function backfillInsiderTradesFeature(request, response, next) {
  try {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const fromYear = Number(request.body?.fromYear ?? 2015);
    const fromMonth = Number(request.body?.fromMonth ?? 1);
    const toYear = Number(request.body?.toYear ?? currentYear);
    const toMonth = Number(request.body?.toMonth ?? (toYear === currentYear ? currentMonth : 12));
    const invalidRange = toYear < fromYear || (toYear === fromYear && toMonth < fromMonth);
    const futureRange = fromYear > currentYear || toYear > currentYear || (fromYear === currentYear && fromMonth > currentMonth) || (toYear === currentYear && toMonth > currentMonth);
    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || !Number.isInteger(fromMonth) || !Number.isInteger(toMonth) || fromYear < 2015 || fromMonth < 1 || fromMonth > 12 || toMonth < 1 || toMonth > 12 || invalidRange || futureRange) {
      response.status(400).json({
        error: "Enter a valid start and end month between 2015 and the current date",
        code: "INVALID_INSIDER_BACKFILL_RANGE",
      });
      return;
    }
    const result = await queueInsiderTradeBackfill({ fromYear, fromMonth, toYear, toMonth });
    if (!result.accepted) {
      response.status(409).json({ error: "An insider backfill is already running", code: "INSIDER_BACKFILL_ALREADY_RUNNING", ...result });
      return;
    }
    response.status(202).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getBackfillStatusFeature(_request, response, next) {
  try {
    response.json(await getInsiderTradeBackfillStatus());
  } catch (error) {
    next(error);
  }
}

export async function cancelBackfillFeature(_request, response, next) {
  try {
    const result = await cancelInsiderTradeBackfill();
    if (!result.accepted) {
      response.status(409).json({ error: "No insider backfill is currently running", code: "INSIDER_BACKFILL_NOT_RUNNING", ...result });
      return;
    }
    response.status(202).json(result);
  } catch (error) {
    next(error);
  }
}
