const quoteCache = new Map();
const quoteCacheMs = Number(process.env.FIN_QUOTE_CACHE_MS || 60_000);

export async function getNiftyBenchmark(period = "1y", startDate = "", endDate = "") {
  const normalizedPeriod = normalizeBenchmarkPeriod(period);
  const query = normalizedPeriod === "custom" && startDate && endDate
    ? `period1=${unixDate(startDate)}&period2=${unixDate(nextDate(endDate))}&interval=1d`
    : `range=${benchmarkRange(normalizedPeriod)}&interval=1d`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?${query}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Nifty benchmark failed: ${response.status}`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const points = (result?.timestamp || []).map((timestamp, index) => ({
    date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    value: Number(result?.indicators?.quote?.[0]?.close?.[index]),
  })).filter((point) => point.date && Number.isFinite(point.value) && point.value > 0);
  if (points.length < 2) throw new Error("Nifty benchmark did not include enough history");

  const first = points[0].value;
  const last = points[points.length - 1].value;
  return {
    label: "Nifty 50",
    period: normalizedPeriod,
    startValue: first,
    endValue: last,
    returnPercent: ((last - first) / first) * 100,
    points,
    source: "Yahoo Finance",
    fetchedAt: new Date().toISOString(),
  };
}

export async function getGoogleFinanceQuote(symbol, exchange = "") {
  const normalizedSymbol = normalizeTickerPart(symbol);
  const normalizedExchange = normalizeTickerPart(exchange);
  if (!normalizedSymbol || !normalizedExchange || normalizedExchange === "MANUAL") {
    throw new Error(`Google Finance quote requires a symbol and exchange for ${normalizedSymbol || "asset"}`);
  }

  const cacheKey = `${normalizedSymbol}:${normalizedExchange}`;
  const cached = quoteCache.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < quoteCacheMs) {
    return cached.quote;
  }

  const url = `https://www.google.com/finance/quote/${normalizedSymbol}:${normalizedExchange}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Google Finance quote failed for ${cacheKey}: ${response.status}`);
  }

  const html = await response.text();
  const price = readQuotePrice(html);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Google Finance quote did not include a valid price for ${cacheKey}`);
  }

  const quote = {
    symbol: normalizedSymbol,
    exchange: normalizedExchange,
    price,
    currency: readCurrency(html),
    marketTime: readTimestamp(html),
    source: "Google Finance",
    url,
    fetchedAt: new Date().toISOString(),
  };

  quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
  return quote;
}

export async function getGoogleFinanceQuotes(tickers) {
  const quotes = await Promise.allSettled(
    tickers.map((ticker) => getGoogleFinanceQuote(ticker.symbol, ticker.exchange)),
  );

  return quotes.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: normalizeTickerPart(tickers[index].symbol),
      exchange: normalizeTickerPart(tickers[index].exchange || ""),
      error: result.reason?.message || "Quote unavailable",
      source: "Google Finance",
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getHistoricalStockPrices(asset, startDate, endDate) {
  const ticker = yahooTicker(asset.symbol, asset.exchange);
  if (!ticker) throw new Error(`Historical prices are unavailable for ${asset.symbol || asset.name || "asset"}`);
  const queryStart = shiftDate(startDate, -7);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${unixDate(queryStart)}&period2=${unixDate(nextDate(endDate))}&interval=1d&events=history`;
  const response = await fetch(url, { headers: yahooHeaders() });
  if (!response.ok) throw new Error(`Historical price request failed for ${ticker}: ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const prices = (result?.timestamp || []).map((timestamp, index) => ({
    date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    price: Number(result?.indicators?.quote?.[0]?.close?.[index]),
  })).filter((point) => point.date && Number.isFinite(point.price) && point.price > 0);
  if (!prices.length) throw new Error(`Yahoo Finance returned no historical prices for ${ticker}`);
  return { ticker, prices, source: "Yahoo Finance" };
}

function yahooTicker(symbol, exchange) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const normalizedExchange = String(exchange || "").trim().toUpperCase();
  if (!normalizedSymbol || normalizedExchange === "MANUAL" || normalizedExchange === "MUTF_IN") return "";
  if (normalizedExchange === "NSE") return normalizedSymbol.endsWith(".NS") ? normalizedSymbol : `${normalizedSymbol}.NS`;
  if (["BSE", "BOM"].includes(normalizedExchange)) return normalizedSymbol.endsWith(".BO") ? normalizedSymbol : `${normalizedSymbol}.BO`;
  return normalizedSymbol;
}

function yahooHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  };
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeTickerPart(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function normalizeBenchmarkPeriod(value) {
  return ["1w", "1mo", "3mo", "6mo", "1y", "2y", "5y", "custom"].includes(value) ? value : "1y";
}

function benchmarkRange(period) {
  if (period === "1w") return "5d";
  if (period === "custom") return "1y";
  return period;
}

function unixDate(value) {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function readQuotePrice(html) {
  return readNumberAttribute(html, "data-last-price")
    ?? readHeaderPrice(html)
    ?? readFirstCurrencyPrice(html);
}

function readHeaderPrice(html) {
  const headerStart = html.indexOf('<div class="N6SYTe">');
  if (headerStart < 0) return null;
  const headerText = stripTags(html.slice(headerStart, headerStart + 900));
  const match = headerText.match(currencyAmountPattern());
  return match ? parsePrice(match[0]) : null;
}

function readFirstCurrencyPrice(html) {
  const quoteStart = html.search(/<div class="gO24Ff">|<div class="JV7gl"|data-p="%\.@\.\[null,\[/);
  const searchable = stripTags(quoteStart >= 0 ? html.slice(quoteStart, quoteStart + 6000) : html);
  const match = searchable.match(currencyAmountPattern());
  return match ? parsePrice(match[0]) : null;
}

function currencyAmountPattern() {
  const rupee = String.fromCharCode(0x20B9);
  const euro = String.fromCharCode(0x20AC);
  const pound = String.fromCharCode(0x00A3);
  const yen = String.fromCharCode(0x00A5);
  const symbols = [rupee, "Rs\\.?", "US\\$", "CA\\$", "A\\$", "\\$", euro, pound, yen];
  return new RegExp(`(?:${symbols.map(escapeRegexExceptBackslash).join("|")})\\s*-?[0-9][0-9,.]*`, "i");
}

function escapeRegexExceptBackslash(value) {
  return value.includes("\\") ? value : value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrice(value) {
  const normalized = String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function readCurrency(html) {
  const attributeCurrency = readAttribute(html, "data-currency-code");
  if (attributeCurrency) return attributeCurrency;

  const headerStart = html.indexOf('<div class="N6SYTe">');
  const headerText = headerStart >= 0 ? html.slice(headerStart, headerStart + 900) : "";
  const headerCurrency = inferCurrencyFromText(headerText);
  if (headerCurrency) return headerCurrency;

  const visibleText = stripTags(html);
  const financeCurrencyMatch = visibleText.match(/\b(?:GMT[+-]\d+(?::\d+)?|UTC[+-]\d+(?::\d+)?)\s+([A-Z]{3})\b/);
  if (financeCurrencyMatch) return financeCurrencyMatch[1];

  const quoteStart = html.search(/<div class="N6SYTe">|<div class="gO24Ff">/);
  const quoteText = quoteStart >= 0 ? html.slice(quoteStart, quoteStart + 6000) : html;
  return inferCurrencyFromText(quoteText) || "INR";
}

function inferCurrencyFromText(text) {
  if (!text) return "";
  if (text.includes(String.fromCharCode(0x20B9)) || /Rs\.?/i.test(text)) return "INR";
  if (/US\$|\$/.test(text)) return "USD";
  if (text.includes(String.fromCharCode(0x20AC))) return "EUR";
  if (text.includes(String.fromCharCode(0x00A3))) return "GBP";
  if (text.includes(String.fromCharCode(0x00A5))) return "JPY";
  return "";
}

function readAttribute(html, attribute) {
  const match = html.match(new RegExp(`${attribute}="([^"]+)"`));
  return match?.[1] || "";
}

function readNumberAttribute(html, attribute) {
  const rawValue = readAttribute(html, attribute);
  if (!rawValue) return null;
  const value = rawValue.replace(/,/g, "");
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function readTimestamp(html) {
  const value = readAttribute(html, "data-last-normal-market-timestamp");
  if (!value) return null;
  const timestamp = Number(value) * 1000;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
