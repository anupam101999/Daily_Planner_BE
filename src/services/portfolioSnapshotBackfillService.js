import { pool } from "../config/database.js";
import { buildAnalytics, buildHoldings, buildProfitChange, loadPortfolio } from "../controllers/financeController.js";
import { getHistoricalStockPrices, getNiftyBenchmark } from "./googleFinanceService.js";
import { snapshotPeriod } from "./portfolioSnapshotService.js";

const backfillTypes = ["weekly", "monthly", "fiscal_year"];

export async function backfillPortfolioSnapshots(userId) {
  const portfolio = await loadPortfolio(userId);
  const firstDate = portfolio.transactions.map((row) => row.transactionDate).sort()[0];
  if (!firstDate) return { created: 0, skipped: 0, failed: [], message: "No ledger transactions to backfill" };

  const endDate = shiftDate(indiaDate(), -1);
  if (firstDate > endDate) return { created: 0, skipped: 0, failed: [], message: "No completed historical periods to backfill" };
  const dates = buildBackfillDates(firstDate, endDate);
  const histories = await loadHistories(portfolio.assets, firstDate, endDate);
  const benchmark = await loadBenchmarkHistory(firstDate, endDate);
  let created = 0;
  let skipped = 0;
  const failed = [];

  for (const item of dates) {
    try {
      const current = buildHistoricalPortfolio(portfolio, histories, item.date);
      const period = snapshotPeriod(item.type, item.date);
      const start = buildHistoricalPortfolio(portfolio, histories, period.start);
      const change = buildProfitChange({
        totalProfit: start.analytics.totalProfit,
        realizedProfit: start.analytics.realizedProfit,
        unrealizedProfit: start.analytics.unrealizedProfit,
      }, current.analytics);
      const nifty = benchmarkForPeriod(benchmark, period.start, item.date);
      const alphaPercent = change.returnPercent == null || nifty.returnPercent == null ? null : change.returnPercent - nifty.returnPercent;
      const result = await insertSnapshot(userId, item, period, current, change, nifty, alphaPercent);
      if (result.rowCount) created += 1;
      else skipped += 1;
    } catch (error) {
      failed.push({ type: item.type, date: item.date, error: error.message });
    }
  }

  return { created, skipped, failed, attempted: dates.length, firstDate, endDate };
}

export function buildBackfillDates(startDate, endDate) {
  const output = [];
  for (let date = utcDate(startDate); date <= utcDate(endDate); date.setUTCDate(date.getUTCDate() + 1)) {
    const value = isoDate(date);
    const tomorrow = new Date(date); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (date.getUTCDay() === 0) output.push({ type: "weekly", date: value });
    if (tomorrow.getUTCDate() === 1) output.push({ type: "monthly", date: value });
    if (date.getUTCMonth() === 2 && date.getUTCDate() === 31) output.push({ type: "fiscal_year", date: value });
  }
  return output.sort((left, right) => left.date.localeCompare(right.date) || backfillTypes.indexOf(left.type) - backfillTypes.indexOf(right.type));
}

async function loadHistories(assets, startDate, endDate) {
  const results = await Promise.allSettled(assets.map((asset) => getHistoricalStockPrices(asset, startDate, endDate)));
  return new Map(assets.map((asset, index) => [String(asset.id), results[index].status === "fulfilled"
    ? results[index].value
    : { prices: [], error: results[index].reason?.message || "Historical price unavailable" }]));
}

async function loadBenchmarkHistory(startDate, endDate) {
  try { return await getNiftyBenchmark("custom", startDate, endDate); }
  catch (error) { return { points: [], source: "Yahoo Finance", error: error.message }; }
}

function buildHistoricalPortfolio(portfolio, histories, date) {
  const transactions = portfolio.transactions.filter((row) => row.transactionDate <= date);
  const positions = buildHoldings(portfolio.assets, transactions);
  const prices = new Map();
  for (const holding of positions.filter((row) => Number(row.quantity) > 0)) {
    const history = histories.get(String(holding.id));
    const price = priceOnOrBefore(history?.prices || [], date);
    if (!price) throw new Error(`${holding.symbol}: ${history?.error || `no closing price on or before ${date}`}`);
    prices.set(String(holding.id), price);
  }
  const assets = portfolio.assets.map((asset) => prices.has(String(asset.id)) ? { ...asset, lastPrice: prices.get(String(asset.id)) } : asset);
  const holdings = buildHoldings(assets, transactions);
  return { holdings, analytics: buildAnalytics(holdings, transactions) };
}

export function priceOnOrBefore(points, date) {
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index].date <= date) return points[index].price;
  return null;
}

function benchmarkForPeriod(history, startDate, endDate) {
  const startValue = pointOnOrBefore(history.points || [], startDate)?.value ?? null;
  const endPoint = pointOnOrBefore(history.points || [], endDate);
  const endValue = endPoint?.value ?? null;
  return {
    label: "Nifty 50", source: history.source || "Yahoo Finance", startValue, endValue,
    returnPercent: startValue && endValue ? ((endValue - startValue) / startValue) * 100 : null,
    latestDate: endPoint?.date || null, unavailable: !startValue || !endValue, error: history.error,
  };
}

function pointOnOrBefore(points, date) {
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index].date <= date) return points[index];
  return null;
}

async function insertSnapshot(userId, item, period, portfolio, change, benchmark, alphaPercent) {
  const analytics = portfolio.analytics;
  const openHoldings = portfolio.holdings.filter((holding) => Number(holding.quantity) > 0).map(snapshotHolding);
  return pool.query(
    `insert into fin_portfolio_snapshot (
      user_id,snapshot_type,snapshot_date,period_start,period_end,current_value,invested_value,total_profit,
      profit_percent,realized_profit,unrealized_profit,total_charges,holding_count,sold_count,holdings,allocation,sectors,
      period_profit,period_return_percent,nifty_start_value,nifty_end_value,nifty_return_percent,alpha_percent,benchmark,captured_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24::jsonb,now())
    on conflict (user_id,snapshot_type,snapshot_date) do nothing`,
    [userId,item.type,item.date,period.start,item.date,analytics.currentValue,analytics.investedValue,analytics.totalProfit,
      analytics.profitPercent,analytics.realizedProfit,analytics.unrealizedProfit,analytics.totalCharges,
      analytics.holdingCount,analytics.soldCount,JSON.stringify(openHoldings),JSON.stringify(analytics.allocation),JSON.stringify(analytics.sectors),
      change.profit,change.returnPercent,benchmark.startValue,benchmark.endValue,benchmark.returnPercent,alphaPercent,JSON.stringify(benchmark)],
  );
}

function snapshotHolding(holding) {
  return {
    id: holding.id, stockName: holding.stockName, symbol: holding.symbol, exchange: holding.exchange, sector: holding.sector,
    quantity: holding.quantity, averagePrice: holding.averagePrice, currentPrice: holding.currentPrice,
    investedValue: holding.investedValue, currentValue: holding.currentValue,
    profitLoss: holding.profitLoss, profitLossPercent: holding.profitLossPercent,
  };
}

function utcDate(value) { return new Date(`${value}T00:00:00.000Z`); }
function isoDate(value) { return value.toISOString().slice(0, 10); }
function shiftDate(value, days) { const date = utcDate(value); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }
function indiaDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
