import { pool } from "../config/database.js";
import { getInsiderTradeBackfillStatus, getStoredInsiderTrades, queueInsiderTradeBackfill, syncRecentInsiderTrades } from "../services/insiderTradeService.js";

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
    const fromYear = Number(request.body?.fromYear ?? 2015);
    const toYear = Number(request.body?.toYear ?? new Date().getUTCFullYear());
    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 2015 || toYear < fromYear) {
      response.status(400).json({
        error: "fromYear and toYear must be valid years, with toYear greater than or equal to fromYear",
        code: "INVALID_INSIDER_BACKFILL_RANGE",
      });
      return;
    }
    const result = await queueInsiderTradeBackfill({ fromYear, toYear });
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
