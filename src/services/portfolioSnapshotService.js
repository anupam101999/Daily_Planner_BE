import { pool } from "../config/database.js";
import { buildAnalytics, buildHoldings, buildPeriodPerformance, loadPortfolio } from "../controllers/financeController.js";
import { getNiftyBenchmark } from "./googleFinanceService.js";

export const snapshotTypes = ["daily", "weekly", "monthly", "fiscal_year"];
const timezone = "Asia/Kolkata";

export async function capturePortfolioSnapshots(type, date = indiaDate()) {
  if (!snapshotTypes.includes(type)) throw new Error(`Unsupported portfolio snapshot type: ${type}`);
  const period = snapshotPeriod(type, date);
  const users = await pool.query("select distinct user_id as id from fin_asset order by user_id");
  const benchmark = await loadSnapshotBenchmark(period.start, date);
  let captured = 0;

  for (const user of users.rows) {
    const portfolio = await loadPortfolio(user.id);
    const holdings = buildHoldings(portfolio.assets, portfolio.transactions);
    const analytics = buildAnalytics(holdings, portfolio.transactions);
    const performance = buildPeriodPerformance(holdings, portfolio.transactions, new Map(), period.start, date);
    const alphaPercent = performance.returnPercent == null || benchmark.returnPercent == null
      ? null : performance.returnPercent - benchmark.returnPercent;
    const openHoldings = holdings.filter((holding) => Number(holding.quantity || 0) > 0).map(snapshotHolding);
    await pool.query(
      `insert into fin_portfolio_snapshot (
        user_id,snapshot_type,snapshot_date,period_start,period_end,current_value,invested_value,total_profit,
        profit_percent,realized_profit,unrealized_profit,total_charges,holding_count,sold_count,holdings,allocation,sectors,
        period_profit,period_return_percent,nifty_start_value,nifty_end_value,nifty_return_percent,alpha_percent,benchmark,captured_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24::jsonb,now())
      on conflict (user_id,snapshot_type,snapshot_date) do update set
        period_start=excluded.period_start,period_end=excluded.period_end,current_value=excluded.current_value,
        invested_value=excluded.invested_value,total_profit=excluded.total_profit,profit_percent=excluded.profit_percent,
        realized_profit=excluded.realized_profit,unrealized_profit=excluded.unrealized_profit,total_charges=excluded.total_charges,
        holding_count=excluded.holding_count,sold_count=excluded.sold_count,holdings=excluded.holdings,
        allocation=excluded.allocation,sectors=excluded.sectors,period_profit=excluded.period_profit,
        period_return_percent=excluded.period_return_percent,nifty_start_value=excluded.nifty_start_value,
        nifty_end_value=excluded.nifty_end_value,nifty_return_percent=excluded.nifty_return_percent,
        alpha_percent=excluded.alpha_percent,benchmark=excluded.benchmark,captured_at=now()`,
      [user.id, type, date, period.start, date, analytics.currentValue, analytics.investedValue, analytics.totalProfit,
        analytics.profitPercent, analytics.realizedProfit, analytics.unrealizedProfit, analytics.totalCharges,
        analytics.holdingCount, analytics.soldCount, JSON.stringify(openHoldings), JSON.stringify(analytics.allocation), JSON.stringify(analytics.sectors),
        performance.profit, performance.returnPercent, benchmark.startValue || null, benchmark.endValue || null,
        benchmark.returnPercent, alphaPercent, JSON.stringify(benchmark)],
    );
    captured += 1;
  }
  return { type, snapshotDate: date, captured, benchmark };
}

async function loadSnapshotBenchmark(startDate, endDate) {
  try { return await getNiftyBenchmark("custom", startDate, endDate); }
  catch (error) {
    try {
      const recent = await getNiftyBenchmark("1mo");
      const latest = recent.points.at(-1);
      return { label: recent.label, source: recent.source, startValue: latest?.value || recent.endValue,
        endValue: latest?.value || recent.endValue, returnPercent: null, latestDate: latest?.date,
        points: latest ? [latest] : [], unavailable: false, requestedPeriodUnavailable: true, error: error.message };
    } catch (fallbackError) {
      return { label: "Nifty 50", source: "Yahoo Finance", startValue: null, endValue: null,
        returnPercent: null, points: [], unavailable: true, error: `${error.message}; ${fallbackError.message}` };
    }
  }
}

export function snapshotPeriod(type, date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) throw new Error("Snapshot date is invalid");
  if (type === "daily") return { start: date, end: date };
  if (type === "weekly") {
    const day = value.getUTCDay();
    value.setUTCDate(value.getUTCDate() - (day === 0 ? 6 : day - 1));
  }
  if (type === "monthly") value.setUTCDate(1);
  if (type === "fiscal_year") {
    const year = value.getUTCMonth() < 3 ? value.getUTCFullYear() - 1 : value.getUTCFullYear();
    value.setUTCFullYear(year, 3, 1);
  }
  return { start: value.toISOString().slice(0, 10), end: date };
}

function indiaDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function snapshotHolding(holding) {
  return {
    id: holding.id,
    stockName: holding.stockName,
    symbol: holding.symbol,
    exchange: holding.exchange,
    sector: holding.sector,
    quantity: holding.quantity,
    averagePrice: holding.averagePrice,
    currentPrice: holding.currentPrice,
    investedValue: holding.investedValue,
    currentValue: holding.currentValue,
    profitLoss: holding.profitLoss,
    profitLossPercent: holding.profitLossPercent,
  };
}
