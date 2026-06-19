import { pool } from "../config/database.js";
import { clearMarketIntelligenceCache, getMarketIntelligence } from "../services/marketIntelligenceService.js";
import { backfillInsiderTrades, getStoredInsiderTrades, syncRecentInsiderTrades } from "../services/insiderTradeService.js";

export async function getMarketIntelligenceFeature(request, response, next) {
  try {
    if (request.query.refresh === "true") clearMarketIntelligenceCache();
    const result = await pool.query(
      `select id::text, name, symbol, exchange, sector from fin_asset where user_id = $1 order by updated_at desc`,
      [request.dailyUserId],
    );
    const currentYear = new Date().getUTCFullYear();
    const [intelligence, marketInsiders, portfolioInsiders] = await Promise.all([
      getMarketIntelligence(result.rows, { country: request.query.country || "IN" }),
      getStoredInsiderTrades({ year: currentYear, page: 1, pageSize: 50 }),
      getStoredInsiderTrades({ year: currentYear, symbols: result.rows.map((row) => row.symbol), companyNames: result.rows.map((row) => row.name), page: 1, pageSize: 50 }),
    ]);
    intelligence.insiderTrades = { market: marketInsiders.rows, portfolio: portfolioInsiders.rows };
    intelligence.sources.insiderTradesDatabase = { ok: true, total: marketInsiders.total };
    response.json(intelligence);
  } catch (error) {
    next(error);
  }
}

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

export async function syncInsiderTradesFeature(_request, response, next) {
  try {
    response.json(await syncRecentInsiderTrades());
  } catch (error) {
    next(error);
  }
}

export async function backfillInsiderTradesFeature(request, response, next) {
  try {
    response.json(await backfillInsiderTrades({ fromYear: request.body?.fromYear, toYear: request.body?.toYear }));
  } catch (error) {
    next(error);
  }
}
