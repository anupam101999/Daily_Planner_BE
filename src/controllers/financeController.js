import { pool } from "../config/database.js";
import { getNiftyBenchmark } from "../services/googleFinanceService.js";
import { getMarketFinanceQuotes } from "../services/marketQuoteService.js";
import { getFinanceSettings } from "../services/financeSettingsService.js";
import { appLog } from "../services/appLogService.js";
import { buildClosedTrades, buildPosition, validateTransactionSequence } from "../services/financePositionService.js";

const assetColumns = `
  id::text,
  name,
  symbol,
  exchange,
  sector,
  notes,
  skip_quote_sync as "skipQuoteSync",
  last_price as "lastPrice",
  last_price_at as "lastPriceAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const transactionColumns = `
  id::text,
  asset_id::text as "assetId",
  transaction_date::text as "transactionDate",
  transaction_type as "transactionType",
  quantity,
  price,
  charges,
  notes,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export async function getFinanceOverview(request, response, next) {
  try {
    const portfolio = await loadPortfolio(request.dailyUserId);
    const holdings = buildHoldings(portfolio.assets, portfolio.transactions);
    const analytics = buildAnalytics(holdings, portfolio.transactions);
    const fiscalYearStart = currentFiscalYearStart();
    const fiscalYear = buildPeriodPerformance(holdings, portfolio.transactions, new Map(), fiscalYearStart, today());
    response.json({
      currentValue: analytics.currentValue,
      investedValue: analytics.investedValue,
      totalProfit: analytics.totalProfit,
      profitPercent: analytics.profitPercent,
      realizedProfit: analytics.realizedProfit,
      unrealizedProfit: analytics.unrealizedProfit,
      thisFyProfit: fiscalYear.profit,
      thisFyReturn: fiscalYear.returnPercent,
      fiscalYearStart,
      holdingCount: analytics.holdingCount,
      soldCount: analytics.soldCount,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

export async function getHoldingsFeature(request, response, next) {
  try {
    const { page, pageSize, search } = readPagination(request.query);
    const sort = readSort(request.query.sort, "valueDesc");
    const status = String(request.query.status || "open").trim().toLowerCase();
    const offset = (page - 1) * pageSize;
    const assets = await loadFilteredHoldingAssets(request.dailyUserId, { search, status });
    const transactions = await loadTransactionsForAssets(request.dailyUserId, assets.map((asset) => asset.id));
    const rows = status === "sold"
      ? buildClosedTrades(assets, transactions)
      : buildHoldings(assets, transactions);
    const holdings = sortBuiltHoldings(rows, sort);
    response.json({
      holdings: holdings.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: holdings.length,
      status,
      search,
      sort,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

export async function getProfitFeature(request, response, next) {
  try {
    const portfolio = await loadPortfolio(request.dailyUserId);
    const holdings = buildHoldings(portfolio.assets, portfolio.transactions);
    const analytics = buildAnalytics(holdings, portfolio.transactions);
    response.json({
      summary: {
        totalProfit: analytics.totalProfit,
        profitPercent: analytics.profitPercent,
        grossInvestmentProfit: analytics.grossInvestmentProfit,
        totalCharges: analytics.totalCharges,
        realizedProfit: analytics.realizedProfit,
        unrealizedProfit: analytics.unrealizedProfit,
        dividends: analytics.dividends,
        fees: analytics.fees,
      },
      rows: [
        {
          id: "gross",
          label: "Profit before charges",
          calculation: "Open and closed investment profit before brokerage, charges, and fee entries",
          amount: analytics.grossInvestmentProfit,
        },
        {
          id: "dividends",
          label: "Dividends",
          calculation: "Dividend income recorded in transaction history",
          amount: analytics.dividends,
        },
        {
          id: "charges",
          label: "Charges and fees",
          calculation: "Buy brokerage, sell brokerage, and fee transactions deducted from profit",
          amount: -analytics.totalCharges,
        },
        {
          id: "actual",
          label: "Actual profit/loss",
          calculation: "Profit before charges plus dividends minus charges and fees",
          amount: analytics.totalProfit,
        },
      ],
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

export async function getAnalyticsFeature(request, response, next) {
  try {
    const period = String(request.query.period || "1y").trim();
    const periodWindow = readAnalyticsPeriod(period, request.query);
    const portfolio = await loadPortfolio(request.dailyUserId);
    const holdings = buildHoldings(portfolio.assets, portfolio.transactions);
    const analytics = buildAnalytics(holdings, portfolio.transactions);
    const benchmarkResult = await getNiftyBenchmark(periodWindow.period, periodWindow.startDate, periodWindow.endDate)
      .then((benchmark) => ({ ok: true, benchmark }))
      .catch((error) => ({ ok: false, error }));
    const benchmark = benchmarkResult.ok ? benchmarkResult.benchmark : unavailableBenchmark(periodWindow.period, benchmarkResult.error);
    const startPrices = new Map();
    const periodPerformance = buildPeriodPerformance(holdings, portfolio.transactions, startPrices, periodWindow.startDate, periodWindow.endDate);
    const startingProfit = await loadStartingPortfolioProfit(request.dailyUserId, periodWindow.startDate);
    const profitChange = buildProfitChange(startingProfit, analytics);
    const portfolioReturnPercent = profitChange.returnPercent;
    const benchmarkReturnPercent = benchmark.returnPercent;
    const alphaPercent = Number.isFinite(portfolioReturnPercent) && Number.isFinite(benchmarkReturnPercent) ? portfolioReturnPercent - benchmarkReturnPercent : null;

    response.json({
      period: periodWindow.period,
      periodStart: periodWindow.startDate,
      periodEnd: periodWindow.endDate,
      summary: {
        currentValue: analytics.currentValue,
        investedValue: analytics.investedValue,
        totalProfit: analytics.totalProfit,
        profitPercent: portfolioReturnPercent,
        allTimeProfitPercent: analytics.profitPercent,
        periodProfit: profitChange.profit,
        periodRealizedProfit: profitChange.realizedProfit,
        periodUnrealizedProfit: profitChange.unrealizedProfit,
        periodStartProfit: profitChange.startProfit,
        periodStartValue: periodPerformance.startValue,
        periodBuyValue: periodPerformance.buyValue,
        periodSellValue: periodPerformance.sellValue,
        periodDividendValue: periodPerformance.dividendValue,
        alphaPercent,
        niftyReturnPercent: benchmarkReturnPercent,
        holdingCount: analytics.holdingCount,
        soldCount: analytics.soldCount,
        topHoldingWeight: analytics.allocation[0]?.weight || 0,
        sectorCount: analytics.sectors.length,
      },
      performance: {
        portfolio: {
          label: "Portfolio",
          returnPercent: portfolioReturnPercent,
          value: analytics.currentValue,
          startValue: profitChange.startProfit,
          profit: profitChange.profit,
        },
        benchmark,
        alphaPercent,
        bars: [
          { label: "Portfolio", value: portfolioReturnPercent },
          { label: benchmark.label || "Nifty 50", value: benchmarkReturnPercent },
          { label: "Alpha", value: alphaPercent },
        ],
      },
      allocation: analytics.allocation,
      sectors: analytics.sectors,
      sold: analytics.sold,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

export async function syncFinanceQuotes(request, response, next) {
  try {
    const result = await refreshAllFinanceQuotesForUser(request.dailyUserId);
    response.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getLedgerFeature(request, response, next) {
  try {
    const { page, pageSize, search } = readPagination(request.query);
    const sort = readSort(request.query.sort, "dateDesc");
    const offset = (page - 1) * pageSize;
    const searchValue = `%${search.toLowerCase()}%`;
    const params = search
      ? [request.dailyUserId, searchValue, pageSize, offset]
      : [request.dailyUserId, pageSize, offset];
    const where = search
      ? `where t.user_id = $1 and (
          lower(a.name) like $2 or lower(a.symbol) like $2 or lower(t.transaction_type) like $2
          or t.transaction_date::text like $2 or t.price::text like $2
        )`
      : "where t.user_id = $1";
    const pageParam = search ? "$3" : "$2";
    const offsetParam = search ? "$4" : "$3";
    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `
          select
            t.id::text,
            t.asset_id::text as "assetId",
            t.transaction_date::text as "transactionDate",
            t.transaction_type as "transactionType",
            t.quantity,
            t.price,
            t.charges,
            t.notes,
            t.created_at as "createdAt",
            t.updated_at as "updatedAt",
            a.name as "assetName",
            a.symbol,
            a.exchange,
            a.sector
          from fin_transaction t
          join fin_asset a on a.id = t.asset_id
          ${where}
          order by ${ledgerOrderBy(sort)}
          limit ${pageParam} offset ${offsetParam}
        `,
        params,
      ),
      pool.query(`select count(*)::int as total from fin_transaction t join fin_asset a on a.id = t.asset_id ${where}`, search ? [request.dailyUserId, searchValue] : [request.dailyUserId]),
    ]);
    response.json({
      rows: rowsResult.rows.map((row) => ({
        ...normalizeTransaction(row),
        assetName: row.assetName,
        symbol: row.symbol,
        exchange: row.exchange,
        sector: row.sector || "",
      })),
      page,
      pageSize,
      total: countResult.rows[0]?.total || 0,
      sort,
    });
  } catch (error) {
    next(error);
  }
}

export async function getHeldStockOptions(request, response, next) {
  try {
    const result = await pool.query(
      `
        select
          a.id::text,
          a.name,
          a.symbol,
          a.exchange,
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity else 0 end), 0)
            - coalesce(sum(case when t.transaction_type = 'sell' then t.quantity else 0 end), 0) as quantity
        from fin_asset a
        left join fin_transaction t on t.asset_id = a.id and t.user_id = a.user_id
        where a.user_id = $1
        group by a.id
        having coalesce(sum(case when t.transaction_type = 'buy' then t.quantity else 0 end), 0)
          - coalesce(sum(case when t.transaction_type = 'sell' then t.quantity else 0 end), 0) > 0
        order by a.name asc
      `,
      [request.dailyUserId],
    );
    response.json({
      assets: result.rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        symbol: String(row.symbol || "").toUpperCase(),
        exchange: normalizeExchange(row.exchange),
        quantity: number(row.quantity),
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function createHolding(request, response, next) {
  const client = await pool.connect();
  try {
    const input = readAssetTicket(request.body);
    await client.query("begin");
    let assetResult = await client.query(
      `select ${assetColumns} from fin_asset where user_id = $1 and upper(symbol) = $2 and upper(exchange) = $3`,
      [request.dailyUserId, input.symbol, input.exchange],
    );
    if (!assetResult.rowCount) {
      assetResult = await client.query(
        `
          insert into fin_asset (user_id, name, symbol, exchange, sector, notes)
          values ($1, $2, $3, $4, $5, $6)
          returning ${assetColumns}
        `,
        [request.dailyUserId, input.stockName, input.symbol, input.exchange, input.sector, input.notes],
      );
    }
    await client.query(
      `
        insert into fin_transaction (user_id, asset_id, transaction_date, transaction_type, quantity, price, charges, notes)
        values ($1, $2, $3, 'buy', $4, $5, $6, $7)
      `,
      [request.dailyUserId, assetResult.rows[0].id, input.purchaseDate, input.quantity, input.averagePrice, input.charges, input.notes],
    );
    await client.query("commit");
    response.status(201).json({ ok: true, asset: normalizeAsset(assetResult.rows[0]) });
  } catch (error) {
    await client.query("rollback");
    handleFinanceError(error, response, next);
  } finally {
    client.release();
  }
}

export async function updateHolding(request, response, next) {
  const client = await pool.connect();
  try {
    const input = readAssetTicket(request.body, { allowZeroQuantity: true });
    await client.query("begin");
    const assetResult = await client.query(
      `
        update fin_asset
        set name = $3, symbol = $4, exchange = $5, sector = $6, notes = $7, updated_at = now()
        where id = $1 and user_id = $2
        returning ${assetColumns}
      `,
      [request.params.id, request.dailyUserId, input.stockName, input.symbol, input.exchange, input.sector, input.notes],
    );
    if (!assetResult.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    const firstBuy = await client.query(
      `
        select id from fin_transaction
        where user_id = $1 and asset_id = $2 and transaction_type = 'buy'
        order by transaction_date asc, created_at asc
        limit 1
      `,
      [request.dailyUserId, request.params.id],
    );
    if (firstBuy.rowCount) {
      await client.query(
        `
          update fin_transaction
          set transaction_date = $3, quantity = $4, price = $5, charges = $6, notes = $7, updated_at = now()
          where id = $1 and user_id = $2
        `,
        [firstBuy.rows[0].id, request.dailyUserId, input.purchaseDate, input.quantity, input.averagePrice, input.charges, input.notes],
      );
    }
    const updatedTransactions = await loadAssetTransactions(client, request.dailyUserId, request.params.id);
    assertValidTransactionSequence(updatedTransactions, input.symbol || input.stockName);
    await client.query("commit");
    response.json({ ok: true, asset: normalizeAsset(assetResult.rows[0]) });
  } catch (error) {
    await client.query("rollback");
    handleFinanceError(error, response, next);
  } finally {
    client.release();
  }
}

export async function deleteHolding(request, response, next) {
  try {
    const result = await pool.query("delete from fin_asset where id = $1 and user_id = $2", [request.params.id, request.dailyUserId]);
    if (!result.rowCount) {
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function sellHolding(request, response, next) {
  const client = await pool.connect();
  try {
    const sale = readSale(request.body);
    await client.query("begin");
    const assetResult = await client.query(
      `select ${assetColumns} from fin_asset where id = $1 and user_id = $2 for update`,
      [request.params.id, request.dailyUserId],
    );
    if (!assetResult.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    const asset = normalizeAsset(assetResult.rows[0]);
    const transactions = await loadAssetTransactions(client, request.dailyUserId, asset.id);
    assertValidTransactionSequence([
      ...transactions,
      {
        id: Number.MAX_SAFE_INTEGER,
        assetId: asset.id,
        transactionDate: sale.sellDate,
        transactionType: "sell",
        quantity: sale.quantity,
        price: sale.sellPrice,
        charges: sale.charges,
        notes: sale.notes,
        createdAt: new Date().toISOString(),
      },
    ], asset.symbol || asset.name);
    await client.query(
      `
        insert into fin_transaction (user_id, asset_id, transaction_date, transaction_type, quantity, price, charges, notes)
        values ($1, $2, $3, 'sell', $4, $5, $6, $7)
      `,
      [request.dailyUserId, request.params.id, sale.sellDate, sale.quantity, sale.sellPrice, sale.charges, sale.notes],
    );
    await client.query("commit");
    response.status(201).json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    handleFinanceError(error, response, next);
  } finally {
    client.release();
  }
}

export async function refreshAllFinanceQuotesForUser(userId) {
  const assetResult = await pool.query(
    `with asset_quantities as (
       select asset_id,
         coalesce(sum(case when transaction_type = 'buy' then quantity when transaction_type = 'sell' then -quantity else 0 end), 0) as net_quantity
       from fin_transaction
       where user_id = $1
       group by asset_id
     )
     select ${assetColumns}, coalesce(q.net_quantity, 0) as "netQuantity"
       from fin_asset a
       left join asset_quantities q on q.asset_id = a.id
      where a.user_id = $1
      order by a.updated_at desc`,
    [userId],
  );
  const allAssets = assetResult.rows.filter((row) => Number(row.netQuantity) > 0).map(normalizeAsset).filter((asset) => asset.symbol && asset.exchange);
  const assets = allAssets.filter((asset) => !isOptionsSector(asset));
  const syncAssets = assets.filter((asset) => !asset.skipQuoteSync);
  const settings = await getFinanceSettings();
  const quotes = await refreshAssetQuotes(userId, syncAssets, settings.financeQuoteProvider);
  const updated = quotes.filter((quote) => quote?.price).length;
  const failed = quotes.length - updated;
  const failures = quotes.map((quote, index) => quote?.price ? null : ({
    assetId: syncAssets[index]?.id,
    name: syncAssets[index]?.stockName,
    symbol: syncAssets[index]?.symbol,
    exchange: syncAssets[index]?.exchange,
    error: quote?.error || "Quote unavailable",
  })).filter(Boolean);
  if (failures.length) appLog.warn("finance.quote_sync_partial", { userId, message: `${failures.length} market quote(s) failed`, failures });
  return {
    ok: true,
    updated,
    failed,
    failures,
    checked: quotes.length,
    skipped: allAssets.length - syncAssets.length,
    skippedOptions: allAssets.length - assets.length,
    skippedByUser: assets.length - syncAssets.length,
    provider: settings.financeQuoteProvider,
    syncedAt: new Date().toISOString(),
  };
}

export async function refreshAllFinanceQuotesForAllUsers() {
  const userResult = await pool.query("select distinct user_id::text as id from fin_asset order by id");
  const results = [];
  for (const row of userResult.rows) {
    const result = await refreshAllFinanceQuotesForUser(row.id);
    results.push({ ...result, userId: row.id });
  }
  return {
    users: results.length,
    updated: results.reduce((total, item) => total + item.updated, 0),
    failed: results.reduce((total, item) => total + item.failed, 0),
    checked: results.reduce((total, item) => total + item.checked, 0),
    skipped: results.reduce((total, item) => total + item.skipped, 0),
    failures: results.flatMap((item) => item.failures.map((failure) => ({ ...failure, userId: item.userId }))),
    syncedAt: new Date().toISOString(),
  };
}

export async function createDividend(request, response, next) {
  try {
    const dividend = readDividend(request.body);
    const assetResult = await pool.query(
      `
        select
          a.id,
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity else 0 end), 0)
            - coalesce(sum(case when t.transaction_type = 'sell' then t.quantity else 0 end), 0) as quantity
        from fin_asset a
        left join fin_transaction t on t.asset_id = a.id and t.user_id = a.user_id
        where a.id = $1 and a.user_id = $2
        group by a.id
      `,
      [dividend.assetId, request.dailyUserId],
    );
    if (!assetResult.rowCount) {
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    if (number(assetResult.rows[0].quantity) <= 0) throw badRequest("Dividend can be added only for an open holding");

    const result = await pool.query(
      `
        insert into fin_transaction (user_id, asset_id, transaction_date, transaction_type, quantity, price, charges, notes)
        values ($1, $2, $3, 'dividend', 0, $4, 0, $5)
        returning ${transactionColumns}
      `,
      [request.dailyUserId, dividend.assetId, dividend.dividendDate, dividend.amount, dividend.notes],
    );
    response.status(201).json(normalizeTransaction(result.rows[0]));
  } catch (error) {
    handleFinanceError(error, response, next);
  }
}

export async function updateTransaction(request, response, next) {
  const client = await pool.connect();
  try {
    const transaction = readTransaction(request.body);
    const sector = String(request.body.sector || "").trim();
    await client.query("begin");
    const existingResult = await client.query(
      `select ${transactionColumns} from fin_transaction where id = $1 and user_id = $2 for update`,
      [request.params.id, request.dailyUserId],
    );
    if (!existingResult.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance transaction not found" });
      return;
    }
    const existing = normalizeTransaction(existingResult.rows[0]);
    if (transaction.assetId !== existing.assetId) throw badRequest("A transaction cannot be moved to another investment");
    const assetResult = await client.query(
      "update fin_asset set sector = $3, updated_at = now() where id = $1 and user_id = $2 returning id, name, symbol",
      [transaction.assetId, request.dailyUserId, sector],
    );
    if (!assetResult.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance asset not found" });
      return;
    }
    const assetTransactions = await loadAssetTransactions(client, request.dailyUserId, transaction.assetId);
    assertValidTransactionSequence(
      assetTransactions.map((row) => row.id === existing.id ? { ...row, ...transaction, id: row.id, createdAt: row.createdAt } : row),
      assetResult.rows[0].symbol || assetResult.rows[0].name,
    );
    const result = await client.query(
      `
        update fin_transaction
        set asset_id = $3, transaction_date = $4, transaction_type = $5, quantity = $6, price = $7,
          charges = $8, notes = $9, updated_at = now()
        where id = $1 and user_id = $2
        returning ${transactionColumns}
      `,
      [request.params.id, request.dailyUserId, transaction.assetId, transaction.transactionDate, transaction.transactionType, transaction.quantity, transaction.price, transaction.charges, transaction.notes],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance transaction not found" });
      return;
    }
    await client.query("commit");
    response.json(normalizeTransaction(result.rows[0]));
  } catch (error) {
    await client.query("rollback");
    handleFinanceError(error, response, next);
  } finally {
    client.release();
  }
}

export async function deleteTransaction(request, response, next) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existingResult = await client.query(
      `select ${transactionColumns} from fin_transaction where id = $1 and user_id = $2 for update`,
      [request.params.id, request.dailyUserId],
    );
    if (!existingResult.rowCount) {
      await client.query("rollback");
      response.status(404).json({ error: "Finance transaction not found" });
      return;
    }
    const existing = normalizeTransaction(existingResult.rows[0]);
    const assetResult = await client.query("select name, symbol from fin_asset where id = $1 and user_id = $2 for update", [existing.assetId, request.dailyUserId]);
    const assetTransactions = await loadAssetTransactions(client, request.dailyUserId, existing.assetId);
    assertValidTransactionSequence(
      assetTransactions.filter((row) => row.id !== existing.id),
      assetResult.rows[0]?.symbol || assetResult.rows[0]?.name || "Investment",
    );
    await client.query("delete from fin_transaction where id = $1 and user_id = $2", [request.params.id, request.dailyUserId]);
    await client.query("commit");
    response.status(204).end();
  } catch (error) {
    await client.query("rollback");
    handleFinanceError(error, response, next);
  } finally {
    client.release();
  }
}

export async function loadPortfolio(userId, options = {}) {
  const [assetResult, transactionResult] = await Promise.all([
    pool.query(`select ${assetColumns} from fin_asset where user_id = $1 order by updated_at desc`, [userId]),
    pool.query(`select ${transactionColumns} from fin_transaction where user_id = $1 order by transaction_date asc, created_at asc`, [userId]),
  ]);
  const assets = assetResult.rows.map(normalizeAsset);
  return {
    assets,
    transactions: transactionResult.rows.map(normalizeTransaction),
  };
}

async function loadFilteredHoldingAssets(userId, { search, status }) {
  const searchValue = `%${String(search || "").toLowerCase()}%`;
  const normalizedStatus = ["open", "sold", "all"].includes(status) ? status : "open";
  const result = await pool.query(
    `
      with asset_rollup as (
        select
          a.id,
          a.name,
          a.symbol,
          a.exchange,
          a.sector,
          a.notes,
          a.last_price,
          a.last_price_at,
          a.created_at,
          a.updated_at,
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity else 0 end), 0) as buy_quantity,
          coalesce(sum(case when t.transaction_type = 'sell' then t.quantity else 0 end), 0) as sell_quantity,
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity * t.price else 0 end), 0) as buy_gross,
          coalesce(sum(case when t.transaction_type = 'buy' then t.quantity * t.price + t.charges else 0 end), 0) as buy_cost
        from fin_asset a
        left join fin_transaction t on t.asset_id = a.id and t.user_id = a.user_id
        where a.user_id = $1
        group by a.id
      ),
      filtered as (
        select *,
          (buy_quantity - sell_quantity) as net_quantity,
          case when buy_quantity > 0 then buy_gross / buy_quantity else 0 end as average_price,
          greatest((buy_quantity - sell_quantity), 0) * coalesce(last_price, case when buy_quantity > 0 then buy_gross / buy_quantity else 0 end) as sort_value
        from asset_rollup
        where ($2 = 'all'
          or ($2 = 'sold' and sell_quantity > 0)
          or ($2 = 'open' and (buy_quantity - sell_quantity) > 0))
          and ($3 = ''
            or lower(name) like $4
            or lower(symbol) like $4
            or lower(exchange) like $4
            or lower(sector) like $4)
      )
      select *
      from filtered
      order by sort_value desc, updated_at desc
    `,
    [userId, normalizedStatus, String(search || "").trim(), searchValue],
  );
  return result.rows.map(normalizeAsset);
}

async function loadTransactionsForAssets(userId, assetIds) {
  if (!assetIds.length) return [];
  const result = await pool.query(
    `select ${transactionColumns} from fin_transaction where user_id = $1 and asset_id = any($2::bigint[]) order by transaction_date asc, created_at asc`,
    [userId, assetIds],
  );
  return result.rows.map(normalizeTransaction);
}

async function loadAssetTransactions(client, userId, assetId) {
  const result = await client.query(
    `select ${transactionColumns} from fin_transaction where user_id = $1 and asset_id = $2 order by transaction_date asc, created_at asc, id asc`,
    [userId, assetId],
  );
  return result.rows.map(normalizeTransaction);
}

function assertValidTransactionSequence(transactions, assetLabel) {
  const validation = validateTransactionSequence(transactions, assetLabel);
  if (!validation.valid) throw badRequest(validation.message);
  return validation;
}

async function refreshAssetQuotes(userId, assets, provider) {
  const targets = assets.filter((asset) => asset.symbol && asset.exchange).map((asset) => ({ symbol: asset.symbol, exchange: asset.exchange, name: asset.stockName || asset.name }));
  const quotes = await getMarketFinanceQuotes(targets, provider);
  await Promise.all(quotes.map((quote, index) => quote?.price ? persistAssetQuote(userId, assets[index].id, quote) : null));
  quotes.forEach((quote, index) => {
    if (quote?.price) {
      assets[index].lastPrice = quote.price;
      assets[index].lastPriceAt = quote.fetchedAt;
    }
  });
  return quotes;
}

async function persistAssetQuote(userId, assetId, quote) {
  if (!quote?.price) return;
  await pool.query(
    "update fin_asset set last_price = $3, last_price_at = $4, updated_at = now() where id = $1 and user_id = $2",
    [assetId, userId, quote.price, quote.fetchedAt],
  );
}

export function buildHoldings(assets, transactions) {
  return assets.map((asset) => buildPosition(asset, transactions)).sort((left, right) => right.currentValue - left.currentValue);
}

function sortBuiltHoldings(holdings, sort) {
  const sorters = {
    avgbuyDesc: (left, right) => Number(right.averagePrice || 0) - Number(left.averagePrice || 0),
    avgbuyAsc: (left, right) => Number(left.averagePrice || 0) - Number(right.averagePrice || 0),
    priceDesc: (left, right) => Number(right.currentPrice || 0) - Number(left.currentPrice || 0),
    priceAsc: (left, right) => Number(left.currentPrice || 0) - Number(right.currentPrice || 0),
    costDesc: (left, right) => holdingCostOrAverageSell(right) - holdingCostOrAverageSell(left),
    costAsc: (left, right) => holdingCostOrAverageSell(left) - holdingCostOrAverageSell(right),
    dateDesc: (left, right) => compareText(right.sellDate || right.purchaseDate, left.sellDate || left.purchaseDate),
    dateAsc: (left, right) => compareText(left.sellDate || left.purchaseDate, right.sellDate || right.purchaseDate),
    unitsDesc: (left, right) => holdingUnits(right) - holdingUnits(left),
    unitsAsc: (left, right) => holdingUnits(left) - holdingUnits(right),
    valueDesc: (left, right) => currentOrSoldValue(right) - currentOrSoldValue(left),
    valueAsc: (left, right) => currentOrSoldValue(left) - currentOrSoldValue(right),
    returnDesc: (left, right) => holdingReturnPercent(right) - holdingReturnPercent(left),
    returnAsc: (left, right) => holdingReturnPercent(left) - holdingReturnPercent(right),
    profitDesc: (left, right) => openOrClosedProfit(right) - openOrClosedProfit(left),
    profitAsc: (left, right) => openOrClosedProfit(left) - openOrClosedProfit(right),
    nameAsc: (left, right) => compareText(left.stockName || left.symbol, right.stockName || right.symbol),
    nameDesc: (left, right) => compareText(right.stockName || right.symbol, left.stockName || left.symbol),
  };
  return [...holdings].sort(sorters[sort] || sorters.valueDesc);
}

function holdingCostOrAverageSell(holding) {
  return Number(holding.status === "sold" ? holding.averageSellPrice : holding.investedValue || 0);
}

function holdingUnits(holding) {
  return Number(holding.status === "sold" ? holding.soldQuantity : holding.quantity || 0);
}

function currentOrSoldValue(holding) {
  return Number(holding.status === "sold" ? holding.sellValue : holding.currentValue || 0);
}

function openOrClosedProfit(holding) {
  return Number(holding.status === "sold" ? holding.realizedProfit : holding.profitLoss || 0);
}

function holdingReturnPercent(holding) {
  if (holding.status !== "sold") return Number(holding.profitLossPercent || 0);
  const soldCost = Number(holding.soldCost || 0);
  return soldCost ? (Number(holding.realizedProfit || 0) / soldCost) * 100 : 0;
}

export function buildAnalytics(holdings, transactions) {
  const openHoldings = holdings.filter((holding) => holding.quantity > 0);
  const investedValue = sum(openHoldings, "investedValue");
  const currentValue = sum(openHoldings, "currentValue");
  const unrealizedProfit = currentValue - investedValue;
  const realizedProfit = sum(holdings, "realizedProfit");
  const grossInvestmentProfit = sum(holdings, "grossProfitLoss") + sum(holdings, "grossRealizedProfit");
  const dividends = sum(holdings, "dividends");
  const fees = sum(holdings, "fees");
  const totalCharges = sum(holdings, "totalCharges");
  const totalProfit = grossInvestmentProfit + dividends - totalCharges;
  const allocation = openHoldings.map((holding) => ({
    id: holding.id,
    label: holding.stockName,
    symbol: holding.symbol,
    exchange: holding.exchange,
    value: holding.currentValue,
    investedValue: holding.investedValue,
    weight: currentValue ? (holding.currentValue / currentValue) * 100 : 0,
    profitLoss: holding.profitLoss,
    profitLossPercent: holding.profitLossPercent,
  }));
  const sectors = [...openHoldings.reduce((map, holding) => {
    const label = holding.sector || "Unclassified";
    const row = map.get(label) || { label, value: 0, investedValue: 0, count: 0, holdings: [] };
    row.value += holding.currentValue;
    row.investedValue += holding.investedValue;
    row.count += 1;
    row.holdings.push({
      id: holding.id,
      label: holding.stockName,
      symbol: holding.symbol,
      exchange: holding.exchange,
      value: holding.currentValue,
      investedValue: holding.investedValue,
      profitLoss: holding.profitLoss,
      profitLossPercent: holding.profitLossPercent,
    });
    map.set(label, row);
    return map;
  }, new Map()).values()].map((row) => ({ ...row, weight: currentValue ? (row.value / currentValue) * 100 : 0, profitLoss: row.value - row.investedValue }));
  const sold = holdings.flatMap((holding) => holding.closedTrades.map((trade) => ({
    id: trade.id,
    label: trade.stockName,
    symbol: trade.symbol,
    exchange: trade.exchange,
    sellDate: trade.sellDate,
    soldQuantity: trade.soldQuantity,
    realizedProfit: trade.realizedProfit,
    dividends: 0,
    fees: trade.charges,
    totalProfit: trade.realizedProfit,
  }))).sort((left, right) => right.totalProfit - left.totalProfit);
  return {
    investedValue,
    currentValue,
    unrealizedProfit,
    realizedProfit,
    grossInvestmentProfit,
    dividends,
    fees,
    totalCharges,
    totalProfit,
    profitPercent: investedValue ? (totalProfit / investedValue) * 100 : 0,
    holdingCount: openHoldings.length,
    soldCount: sold.length,
    allocation: allocation.sort((left, right) => right.value - left.value),
    sectors: sectors.sort((left, right) => right.value - left.value),
    sold,
  };
}

export function buildPeriodPerformance(holdings, transactions, startPrices, startDate, endDate = today()) {
  const holdingMap = new Map(holdings.map((holding) => [holding.id, holding]));
  const rowsByAsset = transactions.reduce((map, row) => {
    const rows = map.get(row.assetId) || [];
    rows.push(row);
    map.set(row.assetId, rows);
    return map;
  }, new Map());
  let startValue = 0;
  let endValue = 0;
  let buyValue = 0;
  let sellValue = 0;
  let dividendValue = 0;
  let feeValue = 0;
  let realizedProfit = 0;
  let realizedCost = 0;

  holdings.forEach((holding) => {
    const assetRows = rowsByAsset.get(holding.id) || [];
    const startQuantity = quantityBeforeDate(assetRows, startDate);
    const endQuantity = quantityThroughDate(assetRows, endDate);
    const historicalPrice = startPrices.get(String(holding.id))?.price;
    const historicalEndPrice = startPrices.get(String(holding.id))?.endPrice;
    const startPrice = Number.isFinite(Number(historicalPrice)) && Number(historicalPrice) > 0
      ? Number(historicalPrice)
      : holding.currentPrice || holding.averagePrice || 0;
    const endPrice = Number.isFinite(Number(historicalEndPrice)) && Number(historicalEndPrice) > 0
      ? Number(historicalEndPrice)
      : holding.currentPrice || holding.averagePrice || 0;
    startValue += inr(Math.max(0, startQuantity) * startPrice);
    endValue += inr(Math.max(0, endQuantity) * endPrice);
  });

  transactions.filter((row) => row.transactionDate >= startDate && row.transactionDate <= endDate).forEach((row) => {
    if (!holdingMap.has(row.assetId)) return;
    if (row.transactionType === "buy") buyValue += inr(row.quantity * row.price + row.charges);
    if (row.transactionType === "sell") sellValue += inr(row.quantity * row.price - row.charges);
    if (row.transactionType === "dividend") dividendValue += inr(row.price);
    if (row.transactionType === "fee") feeValue += inr(row.charges || row.price);
  });

  holdings.forEach((holding) => {
    holding.closedTrades
      .filter((trade) => trade.sellDate >= startDate && trade.sellDate <= endDate)
      .forEach((trade) => {
        realizedProfit += inr(trade.realizedProfit);
        realizedCost += inr(trade.soldCost);
      });
  });

  const openHoldings = holdings.filter((holding) => Number(holding.quantity || 0) > 0);
  const unrealizedProfit = inr(sum(openHoldings, "profitLoss"));
  const unrealizedCost = inr(sum(openHoldings, "investedValue"));
  realizedProfit = inr(realizedProfit);
  realizedCost = inr(realizedCost);
  const profit = inr(realizedProfit + unrealizedProfit + dividendValue - feeValue);
  const capitalBase = inr(realizedCost + unrealizedCost);
  return {
    startValue,
    endValue,
    buyValue,
    sellValue,
    dividendValue,
    feeValue,
    realizedProfit,
    unrealizedProfit,
    realizedCost,
    unrealizedCost,
    profit,
    returnPercent: capitalBase > 0 ? (profit / capitalBase) * 100 : null,
  };
}

export function buildProfitChange(startingProfit, currentAnalytics) {
  if (!startingProfit) {
    return { startProfit: null, profit: null, realizedProfit: null, unrealizedProfit: null, returnPercent: null };
  }
  const startProfit = inr(startingProfit.totalProfit);
  const profit = inr(currentAnalytics.totalProfit - startProfit);
  const realizedProfit = inr(currentAnalytics.realizedProfit - startingProfit.realizedProfit);
  const unrealizedProfit = inr(currentAnalytics.unrealizedProfit - startingProfit.unrealizedProfit);
  return {
    startProfit,
    profit,
    realizedProfit,
    unrealizedProfit,
    returnPercent: startProfit !== 0 ? (profit / Math.abs(startProfit)) * 100 : null,
  };
}

async function loadStartingPortfolioProfit(userId, startDate) {
  const result = await pool.query(
    `select total_profit as "totalProfit", realized_profit as "realizedProfit", unrealized_profit as "unrealizedProfit"
       from fin_portfolio_snapshot
      where user_id = $1 and snapshot_date <= $2
      order by snapshot_date desc, captured_at desc
      limit 1`,
    [userId, startDate],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    totalProfit: Number(row.totalProfit || 0),
    realizedProfit: Number(row.realizedProfit || 0),
    unrealizedProfit: Number(row.unrealizedProfit || 0),
  };
}

function quantityBeforeDate(rows, date) {
  return rows.filter((row) => row.transactionDate < date).reduce((quantity, row) => {
    if (row.transactionType === "buy") return quantity + row.quantity;
    if (row.transactionType === "sell") return quantity - row.quantity;
    return quantity;
  }, 0);
}

function quantityThroughDate(rows, date) {
  return rows.filter((row) => row.transactionDate <= date).reduce((quantity, row) => {
    if (row.transactionType === "buy") return quantity + row.quantity;
    if (row.transactionType === "sell") return quantity - row.quantity;
    return quantity;
  }, 0);
}

function readAnalyticsPeriod(value, query = {}) {
  const requestedStart = validDate(query.startDate);
  const requestedEnd = validDate(query.endDate);
  if (requestedStart && requestedEnd && requestedStart <= requestedEnd) {
    return { period: "custom", startDate: requestedStart, endDate: requestedEnd };
  }

  const period = ["1w", "1mo", "3mo", "6mo", "1y", "2y", "5y"].includes(value) ? value : "1y";
  const start = new Date();
  const endDate = today();
  if (period === "1w") start.setDate(start.getDate() - 7);
  if (period === "1mo") start.setMonth(start.getMonth() - 1);
  if (period === "3mo") start.setMonth(start.getMonth() - 3);
  if (period === "6mo") start.setMonth(start.getMonth() - 6);
  if (period === "1y") start.setFullYear(start.getFullYear() - 1);
  if (period === "2y") start.setFullYear(start.getFullYear() - 2);
  if (period === "5y") start.setFullYear(start.getFullYear() - 5);
  return { period, startDate: start.toISOString().slice(0, 10), endDate };
}

function unavailableBenchmark(period, error) {
  return {
    label: "Nifty 50",
    period,
    startValue: null,
    endValue: null,
    returnPercent: null,
    points: [],
    source: "",
    unavailable: true,
    error: error?.message || "Benchmark disabled during normal analytics reads",
  };
}

function readAssetTicket(body, options = {}) {
  const ticket = {
    stockName: String(body.stockName || body.name || "").trim(),
    symbol: String(body.symbol || "").trim().toUpperCase(),
    exchange: normalizeExchange(body.exchange),
    sector: String(body.sector || "").trim(),
    notes: String(body.notes || "").trim(),
    purchaseDate: requiredDate(body.purchaseDate || today(), "Purchase date"),
    quantity: Number(body.quantity),
    averagePrice: Number(body.averagePrice ?? body.price),
    charges: Number(body.charges || 0),
  };
  if (!ticket.stockName) throw badRequest("Investment name is required");
  if (!ticket.symbol) throw badRequest("Investment symbol is required");
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(ticket.exchange)) throw badRequest("Exchange must contain 2-20 uppercase letters, numbers, or underscores");
  validateQuantity(ticket.quantity, "Buy quantity", options.allowZeroQuantity);
  validateMoney(ticket.averagePrice, "Buy price", { positive: true });
  validateMoney(ticket.charges, "Charges");
  return ticket;
}

function readSale(body) {
  const sale = {
    sellDate: requiredDate(body.sellDate || today(), "Sell date"),
    quantity: Number(body.quantity),
    sellPrice: Number(body.sellPrice),
    charges: Number(body.charges || 0),
    notes: String(body.notes || "").trim(),
  };
  validateQuantity(sale.quantity, "Sell quantity");
  validateMoney(sale.sellPrice, "Sell price", { positive: true });
  validateMoney(sale.charges, "Sell charges");
  return sale;
}

function readDividend(body) {
  const dividend = {
    assetId: String(body.assetId || "").trim(),
    dividendDate: requiredDate(body.dividendDate || body.transactionDate || today(), "Dividend date"),
    amount: Number(body.amount ?? body.price),
    notes: String(body.notes || "").trim(),
  };
  if (!dividend.assetId) throw badRequest("Dividend stock is required");
  validateMoney(dividend.amount, "Dividend amount", { positive: true });
  return dividend;
}

function readTransaction(body) {
  const type = String(body.transactionType || "").trim().toLowerCase();
  if (!["buy", "sell", "dividend", "fee"].includes(type)) throw badRequest("Transaction type is invalid");
  const transaction = {
    assetId: String(body.assetId || "").trim(),
    transactionDate: requiredDate(body.transactionDate || today(), "Transaction date"),
    transactionType: type,
    quantity: Number(body.quantity || 0),
    price: Number(body.price || 0),
    charges: Number(body.charges || 0),
    notes: String(body.notes || "").trim(),
  };
  if (!transaction.assetId) throw badRequest("Transaction asset is required");
  if (["buy", "sell"].includes(type)) validateQuantity(transaction.quantity, "Transaction quantity");
  if (["buy", "sell"].includes(type)) validateMoney(transaction.price, "Transaction price", { positive: true });
  if (type === "dividend") validateMoney(transaction.price, "Dividend amount", { positive: true });
  if (type === "fee" && transaction.price === 0 && transaction.charges === 0) throw badRequest("Fee amount must be greater than 0");
  validateMoney(transaction.charges, "Charges");
  return transaction;
}

function readPagination(query) {
  return {
    page: Math.max(1, Number(query.page || 1)),
    pageSize: Math.max(5, Math.min(50, Number(query.pageSize || 12))),
    search: String(query.search || "").trim(),
  };
}

function readSort(value, fallback) {
  const allowed = new Set([
    "valueDesc",
    "valueAsc",
    "unitsDesc",
    "unitsAsc",
    "avgbuyDesc",
    "avgbuyAsc",
    "priceDesc",
    "priceAsc",
    "costDesc",
    "costAsc",
    "returnDesc",
    "returnAsc",
    "profitDesc",
    "profitAsc",
    "nameAsc",
    "nameDesc",
    "dateDesc",
    "dateAsc",
    "amountDesc",
    "amountAsc",
    "typeAsc",
    "assetAsc",
  ]);
  const sort = String(value || fallback).trim();
  return allowed.has(sort) ? sort : fallback;
}

function ledgerOrderBy(sort) {
  const amountExpression = "(case when t.transaction_type in ('buy', 'sell') then coalesce(t.quantity, 0) * coalesce(t.price, 0) + coalesce(t.charges, 0) else coalesce(t.price, 0) + coalesce(t.charges, 0) end)";
  const orderMap = {
    dateDesc: "t.transaction_date desc, t.created_at desc",
    dateAsc: "t.transaction_date asc, t.created_at asc",
    amountDesc: `${amountExpression} desc, t.transaction_date desc`,
    amountAsc: `${amountExpression} asc, t.transaction_date desc`,
    typeAsc: "t.transaction_type asc, t.transaction_date desc",
    assetAsc: "a.name asc, t.transaction_date desc",
  };
  return orderMap[sort] || orderMap.dateDesc;
}

function normalizeAsset(row) {
  return {
    id: String(row.id),
    name: row.name,
    stockName: row.name,
    symbol: String(row.symbol || "").toUpperCase(),
    exchange: normalizeExchange(row.exchange),
    sector: row.sector || "",
    notes: row.notes || "",
    skipQuoteSync: Boolean(row.skipQuoteSync ?? row.skip_quote_sync),
    lastPrice: (row.lastPrice ?? row.last_price) == null ? null : number(row.lastPrice ?? row.last_price),
    lastPriceAt: row.lastPriceAt || row.last_price_at || null,
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at,
  };
}

function normalizeTransaction(row) {
  return {
    id: String(row.id),
    assetId: String(row.assetId),
    transactionDate: String(row.transactionDate).slice(0, 10),
    transactionType: row.transactionType,
    quantity: number(row.quantity),
    price: number(row.price),
    charges: number(row.charges),
    notes: row.notes || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeExchange(value) {
  const exchange = String(value || "NSE").trim().toUpperCase();
  return exchange || "NSE";
}

function isOptionsSector(asset) {
  return String(asset?.sector || "").trim().toLowerCase() === "options";
}

function inr(value) {
  return round(Number(value || 0), 4);
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] || 0), 0);
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentFiscalYearStart() {
  const now = new Date();
  const year = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-04-01`;
}

function validDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? "" : text;
}

function requiredDate(value, label) {
  const date = validDate(value);
  if (!date) throw badRequest(`${label} must be a valid date`);
  if (date > today()) throw badRequest(`${label} cannot be in the future`);
  return date;
}

function validateQuantity(value, label, allowZero = false) {
  if (!Number.isFinite(value)) throw badRequest(`${label} must be a number`);
  if (value < 0 || (!allowZero && value === 0)) throw badRequest(`${label} must be greater than 0`);
  if (value > 999999999999) throw badRequest(`${label} is too large`);
  if (round(value, 6) !== value) throw badRequest(`${label} supports at most 6 decimal places`);
}

function validateMoney(value, label, { positive = false } = {}) {
  if (!Number.isFinite(value)) throw badRequest(`${label} must be a number`);
  if (value < 0 || (positive && value === 0)) throw badRequest(`${label} must be ${positive ? "greater than 0" : "0 or more"}`);
  if (value > 99999999999999) throw badRequest(`${label} is too large`);
  if (round(value, 4) !== value) throw badRequest(`${label} supports at most 4 decimal places`);
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function handleFinanceError(error, response, next) {
  if (error.status) {
    response.status(error.status).json({ error: error.message, code: error.code || "FINANCE_VALIDATION_ERROR", requestId: response.req?.requestId || "" });
    return;
  }
  if (error.code === "23505") {
    response.status(409).json({ error: "An investment with this symbol and exchange already exists", code: "FINANCE_ASSET_CONFLICT", requestId: response.req?.requestId || "" });
    return;
  }
  if (error.code === "23514" || error.code === "22003") {
    response.status(400).json({ error: "The transaction contains an invalid or unsupported numeric value", code: "FINANCE_VALUE_INVALID", requestId: response.req?.requestId || "" });
    return;
  }
  next(error);
}
