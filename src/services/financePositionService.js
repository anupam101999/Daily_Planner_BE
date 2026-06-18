const QUANTITY_EPSILON = 0.000001;

export function buildPosition(asset, transactions) {
  const rows = sortTransactions(transactions.filter((row) => row.assetId === asset.id));
  const lots = [];
  const closedTrades = [];
  let buyQuantity = 0;
  let sellQuantity = 0;
  let buyGross = 0;
  let sellGross = 0;
  let buyCharges = 0;
  let sellCharges = 0;
  let dividends = 0;
  let fees = 0;

  for (const row of rows) {
    if (row.transactionType === "buy") {
      const gross = money(row.quantity * row.price);
      buyQuantity += row.quantity;
      buyGross += gross;
      buyCharges += row.charges;
      lots.push({
        transactionId: row.id,
        transactionDate: row.transactionDate,
        remaining: row.quantity,
        unitGrossCost: row.price,
        unitCost: (gross + row.charges) / row.quantity,
      });
      continue;
    }
    if (row.transactionType === "sell") {
      const matched = consumeFifoLots(lots, row.quantity);
      const proceeds = money(row.quantity * row.price - row.charges);
      const grossProceeds = money(row.quantity * row.price);
      sellQuantity += row.quantity;
      sellGross += grossProceeds;
      sellCharges += row.charges;
      closedTrades.push({
        id: `trade-${row.id}`,
        transactionId: row.id,
        assetId: asset.id,
        stockName: asset.name,
        symbol: asset.symbol,
        exchange: asset.exchange,
        sector: asset.sector,
        status: "sold",
        sellDate: row.transactionDate,
        purchaseDate: matched.firstBuyDate || row.transactionDate,
        soldQuantity: row.quantity,
        quantity: 0,
        averagePrice: row.quantity ? matched.grossCost / row.quantity : 0,
        averageSellPrice: row.price,
        soldCost: money(matched.costBasis),
        grossSoldCost: money(matched.grossCost),
        sellValue: proceeds,
        realizedProfit: money(proceeds - matched.costBasis),
        charges: row.charges,
        notes: row.notes || "",
        unmatchedQuantity: matched.unmatchedQuantity,
      });
      continue;
    }
    if (row.transactionType === "dividend") dividends += money(row.price);
    if (row.transactionType === "fee") fees += money(row.charges || row.price);
  }

  const quantity = round(lots.reduce((total, lot) => total + lot.remaining, 0), 6);
  const remainingCost = money(lots.reduce((total, lot) => total + lot.remaining * lot.unitCost, 0));
  const remainingGrossCost = money(lots.reduce((total, lot) => total + lot.remaining * lot.unitGrossCost, 0));
  const soldCost = money(closedTrades.reduce((total, trade) => total + trade.soldCost, 0));
  const sellValue = money(closedTrades.reduce((total, trade) => total + trade.sellValue, 0));
  const currentPrice = asset.lastPrice || (buyQuantity ? buyGross / buyQuantity : 0);
  const currentValue = money(quantity * currentPrice);
  const realizedProfit = money(sellValue - soldCost);
  const profitLoss = money(currentValue - remainingCost);
  const grossProfitLoss = money(currentValue - remainingGrossCost);
  const grossSoldCost = closedTrades.reduce((total, trade) => total + trade.grossSoldCost, 0);
  const grossRealizedProfit = money(sellGross - grossSoldCost);
  const firstBuy = rows.find((row) => row.transactionType === "buy");

  return {
    id: asset.id,
    stockName: asset.name,
    symbol: asset.symbol,
    exchange: asset.exchange,
    sector: asset.sector,
    notes: asset.notes,
    purchaseDate: firstBuy?.transactionDate || today(),
    quantity,
    soldQuantity: round(sellQuantity, 6),
    averagePrice: buyQuantity ? buyGross / buyQuantity : 0,
    averageSellPrice: sellQuantity ? sellGross / sellQuantity : 0,
    sellValue,
    soldCost,
    currentPrice,
    charges: firstBuy?.charges || 0,
    investedValue: remainingCost,
    currentValue,
    profitLoss,
    profitLossPercent: remainingCost ? (profitLoss / remainingCost) * 100 : 0,
    totalProfit: money(profitLoss + realizedProfit + dividends - fees),
    grossProfitLoss,
    grossRealizedProfit,
    totalCharges: money(buyCharges + sellCharges + fees),
    realizedProfit,
    dividends,
    fees,
    status: quantity > QUANTITY_EPSILON ? "open" : "sold",
    lastPrice: asset.lastPrice,
    lastPriceAt: asset.lastPriceAt,
    closedTrades,
  };
}

export function buildClosedTrades(assets, transactions) {
  return assets.flatMap((asset) => buildPosition(asset, transactions).closedTrades);
}

export function validateTransactionSequence(transactions, assetLabel = "Investment") {
  let available = 0;
  for (const row of sortTransactions(transactions)) {
    if (row.transactionType === "buy") available = round(available + row.quantity, 6);
    if (row.transactionType !== "sell") continue;
    if (row.quantity > available + QUANTITY_EPSILON) {
      return {
        valid: false,
        message: `${assetLabel} cannot sell ${formatQuantity(row.quantity)} units on ${row.transactionDate}; only ${formatQuantity(available)} units are available on that date`,
      };
    }
    available = round(available - row.quantity, 6);
  }
  return { valid: true, remainingQuantity: available };
}

function consumeFifoLots(lots, requestedQuantity) {
  let remaining = requestedQuantity;
  let costBasis = 0;
  let grossCost = 0;
  let firstBuyDate = "";
  for (const lot of lots) {
    if (remaining <= QUANTITY_EPSILON) break;
    if (lot.remaining <= QUANTITY_EPSILON) continue;
    const matchedQuantity = Math.min(remaining, lot.remaining);
    if (!firstBuyDate) firstBuyDate = lot.transactionDate;
    costBasis += matchedQuantity * lot.unitCost;
    grossCost += matchedQuantity * lot.unitGrossCost;
    lot.remaining = round(lot.remaining - matchedQuantity, 6);
    remaining = round(remaining - matchedQuantity, 6);
  }
  return {
    costBasis: money(costBasis),
    grossCost: money(grossCost),
    firstBuyDate,
    unmatchedQuantity: remaining > QUANTITY_EPSILON ? remaining : 0,
  };
}

function sortTransactions(rows) {
  return [...rows].sort((left, right) => {
    const byDate = String(left.transactionDate).localeCompare(String(right.transactionDate));
    if (byDate) return byDate;
    const byCreated = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    if (byCreated) return byCreated;
    return Number(left.id || 0) - Number(right.id || 0);
  });
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 6 });
}

function money(value) {
  return round(value, 4);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
