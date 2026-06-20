import { pool } from "../config/database.js";
import { snapshotTypes } from "../services/portfolioSnapshotService.js";
import { backfillPortfolioSnapshots } from "../services/portfolioSnapshotBackfillService.js";

const snapshotColumns = `id::text,snapshot_type as "snapshotType",snapshot_date::text as "snapshotDate",
  period_start::text as "periodStart",period_end::text as "periodEnd",current_value as "currentValue",
  invested_value as "investedValue",total_profit as "totalProfit",profit_percent as "profitPercent",
  realized_profit as "realizedProfit",unrealized_profit as "unrealizedProfit",total_charges as "totalCharges",
  holding_count as "holdingCount",sold_count as "soldCount",holdings,allocation,sectors,
  period_profit as "periodProfit",period_return_percent as "periodReturnPercent",nifty_start_value as "niftyStartValue",
  nifty_end_value as "niftyEndValue",nifty_return_percent as "niftyReturnPercent",alpha_percent as "alphaPercent",
  benchmark,captured_at as "capturedAt"`;

export async function getPortfolioSnapshots(request, response, next) {
  try {
    const requestedType = String(request.query.type || "all").trim().toLowerCase();
    const type = snapshotTypes.includes(requestedType) ? requestedType : "all";
    const page = Math.max(1, Number(request.query.page || 1));
    const pageSize = Math.max(6, Math.min(24, Number(request.query.pageSize || 9)));
    const offset = (page - 1) * pageSize;
    const params = type === "all" ? [request.dailyUserId] : [request.dailyUserId, type];
    const where = `where user_id=$1${type === "all" ? "" : " and snapshot_type=$2"}`;
    const [rows, count, latest] = await Promise.all([
      pool.query(`select ${snapshotColumns} from fin_portfolio_snapshot ${where} order by snapshot_date desc,captured_at desc limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int total from fin_portfolio_snapshot ${where}`, params),
      pool.query(`select distinct on (snapshot_type) ${snapshotColumns} from fin_portfolio_snapshot where user_id=$1 order by snapshot_type,snapshot_date desc,captured_at desc`, [request.dailyUserId]),
    ]);
    response.json({
      snapshots: rows.rows.map(normalizeSnapshot),
      latest: latest.rows.map(normalizeSnapshot),
      type,
      page,
      pageSize,
      total: count.rows[0].total,
      pageCount: Math.max(1, Math.ceil(count.rows[0].total / pageSize)),
    });
  } catch (error) {
    next(error);
  }
}

export async function updatePortfolioSnapshot(request, response, next) {
  try {
    const existing = await pool.query(`select ${snapshotColumns} from fin_portfolio_snapshot where id=$1 and user_id=$2`, [request.params.id, request.dailyUserId]);
    if (!existing.rowCount) return response.status(404).json({ error: "Portfolio snapshot not found" });
    const current = normalizeSnapshot(existing.rows[0]);
    const body = request.body || {};
    const nextRow = { ...current, ...body };
    if (!snapshotTypes.includes(nextRow.snapshotType)) return response.status(400).json({ error: "Snapshot type is invalid" });
    for (const field of ["snapshotDate", "periodStart", "periodEnd"]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nextRow[field] || ""))) return response.status(400).json({ error: `${field} is invalid` });
    }
    if (nextRow.periodStart > nextRow.periodEnd) return response.status(400).json({ error: "Period start cannot be after period end" });
    const numeric = ["currentValue","investedValue","totalProfit","profitPercent","realizedProfit","unrealizedProfit","totalCharges","periodProfit","periodReturnPercent","niftyStartValue","niftyEndValue","niftyReturnPercent","alphaPercent"];
    numeric.forEach((field) => { nextRow[field] = nextRow[field] == null || nextRow[field] === "" ? null : Number(nextRow[field]); });
    if (numeric.some((field) => nextRow[field] != null && !Number.isFinite(nextRow[field]))) return response.status(400).json({ error: "Snapshot contains an invalid number" });
    nextRow.holdingCount = Math.max(0, Number(nextRow.holdingCount || 0));
    nextRow.soldCount = Math.max(0, Number(nextRow.soldCount || 0));
    for (const field of ["holdings", "allocation", "sectors"]) if (!Array.isArray(nextRow[field])) return response.status(400).json({ error: `${field} must be an array` });
    const result = await pool.query(
      `update fin_portfolio_snapshot set snapshot_type=$3,snapshot_date=$4,period_start=$5,period_end=$6,current_value=$7,
       invested_value=$8,total_profit=$9,profit_percent=$10,realized_profit=$11,unrealized_profit=$12,total_charges=$13,
       holding_count=$14,sold_count=$15,holdings=$16::jsonb,allocation=$17::jsonb,sectors=$18::jsonb,period_profit=$19,
       period_return_percent=$20,nifty_start_value=$21,nifty_end_value=$22,nifty_return_percent=$23,alpha_percent=$24,
       benchmark=$25::jsonb,captured_at=now() where id=$1 and user_id=$2 returning ${snapshotColumns}`,
      [request.params.id,request.dailyUserId,nextRow.snapshotType,nextRow.snapshotDate,nextRow.periodStart,nextRow.periodEnd,
       nextRow.currentValue,nextRow.investedValue,nextRow.totalProfit,nextRow.profitPercent,nextRow.realizedProfit,nextRow.unrealizedProfit,
       nextRow.totalCharges,nextRow.holdingCount,nextRow.soldCount,JSON.stringify(nextRow.holdings),JSON.stringify(nextRow.allocation),
       JSON.stringify(nextRow.sectors),nextRow.periodProfit,nextRow.periodReturnPercent,nextRow.niftyStartValue,nextRow.niftyEndValue,
       nextRow.niftyReturnPercent,nextRow.alphaPercent,JSON.stringify(nextRow.benchmark || {})],
    );
    response.json({ snapshot: normalizeSnapshot(result.rows[0]) });
  } catch (error) { next(error); }
}

export async function backfillHistoricalSnapshots(request, response, next) {
  try {
    response.json(await backfillPortfolioSnapshots(request.dailyUserId));
  } catch (error) {
    next(error);
  }
}

function normalizeSnapshot(row) {
  return {
    ...row,
    currentValue: Number(row.currentValue || 0),
    investedValue: Number(row.investedValue || 0),
    totalProfit: Number(row.totalProfit || 0),
    profitPercent: Number(row.profitPercent || 0),
    realizedProfit: Number(row.realizedProfit || 0),
    unrealizedProfit: Number(row.unrealizedProfit || 0),
    totalCharges: Number(row.totalCharges || 0),
    periodProfit: Number(row.periodProfit || 0),
    periodReturnPercent: row.periodReturnPercent == null ? null : Number(row.periodReturnPercent),
    niftyStartValue: row.niftyStartValue == null ? null : Number(row.niftyStartValue),
    niftyEndValue: row.niftyEndValue == null ? null : Number(row.niftyEndValue),
    niftyReturnPercent: row.niftyReturnPercent == null ? null : Number(row.niftyReturnPercent),
    alphaPercent: row.alphaPercent == null ? null : Number(row.alphaPercent),
    holdingCount: Number(row.holdingCount || 0),
    soldCount: Number(row.soldCount || 0),
    holdings: Array.isArray(row.holdings) ? row.holdings : [],
    allocation: Array.isArray(row.allocation) ? row.allocation : [],
    sectors: Array.isArray(row.sectors) ? row.sectors : [],
  };
}
