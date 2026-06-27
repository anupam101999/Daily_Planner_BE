const quoteCache = new Map();
const quoteCacheMs = Number(process.env.FIN_QUOTE_CACHE_MS || 60_000);
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

let nseCookie = "";
let nseCookieAt = 0;

export async function getMarketFinanceQuotes(tickers, provider = "nse") {
  const source = normalizeProvider(provider);
  const quotes = await Promise.allSettled(
    tickers.map((ticker) => getMarketFinanceQuote(ticker.symbol, ticker.exchange, source)),
  );

  return quotes.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: normalizeTickerPart(tickers[index].symbol),
      exchange: normalizeTickerPart(tickers[index].exchange || ""),
      error: result.reason?.message || "Quote unavailable",
      source: sourceLabel(source),
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getMarketFinanceQuote(symbol, exchange = "", provider = "nse") {
  const source = normalizeProvider(provider);
  const normalizedSymbol = normalizeTickerPart(symbol);
  const normalizedExchange = normalizeTickerPart(exchange);
  if (!normalizedSymbol || !normalizedExchange || normalizedExchange === "MANUAL") {
    throw new Error(`${sourceLabel(source)} quote requires a symbol and exchange for ${normalizedSymbol || "asset"}`);
  }

  const cacheKey = `${source}:${normalizedSymbol}:${normalizedExchange}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < quoteCacheMs) return cached.quote;

  const quote = source === "screener"
    ? await getScreenerFinanceQuote(normalizedSymbol, normalizedExchange)
    : await getNseFinanceQuoteWithFallback(normalizedSymbol, normalizedExchange);

  quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
  return quote;
}

async function getNseFinanceQuote(symbol, exchange) {
  if (exchange === "MUTF_IN") throw new Error(`NSE quote provider does not support mutual fund exchange ${symbol}:${exchange}`);
  const cookie = await getNseCookie();
  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
      "User-Agent": userAgent,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!response.ok) throw new Error(`NSE quote failed for ${symbol}: ${response.status}`);
  const payload = await response.json();
  const price = Number(payload?.priceInfo?.lastPrice || payload?.priceInfo?.close || payload?.priceInfo?.previousClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`NSE quote did not include a valid price for ${symbol}`);
  return {
    symbol,
    exchange,
    price,
    currency: "INR",
    marketTime: payload?.metadata?.lastUpdateTime || payload?.metadata?.lastUpdateTimeIST || null,
    source: "NSE",
    url,
    fetchedAt: new Date().toISOString(),
  };
}

async function getNseFinanceQuoteWithFallback(symbol, exchange) {
  try {
    return await getNseFinanceQuote(symbol, exchange);
  } catch (error) {
    const quote = await getScreenerFinanceQuote(symbol, exchange);
    return {
      ...quote,
      source: "Screener (NSE fallback)",
      fallbackFrom: "NSE",
      fallbackReason: error.message,
    };
  }
}

async function getNseCookie() {
  if (nseCookie && Date.now() - nseCookieAt < 15 * 60_000) return nseCookie;
  const response = await fetch("https://www.nseindia.com", {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent,
    },
  });
  const rawCookies = response.headers.getSetCookie?.() || readSetCookieHeader(response.headers.get("set-cookie"));
  nseCookie = rawCookies.map((cookie) => String(cookie).split(";")[0]).filter(Boolean).join("; ");
  nseCookieAt = Date.now();
  return nseCookie;
}

async function getScreenerFinanceQuote(symbol, exchange) {
  if (exchange === "MUTF_IN") throw new Error(`Screener quote provider does not support mutual fund exchange ${symbol}:${exchange}`);
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent,
    },
  });
  if (!response.ok) throw new Error(`Screener quote failed for ${symbol}: ${response.status}`);
  const html = await response.text();
  const price = readScreenerPrice(html);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Screener quote did not include a valid price for ${symbol}`);
  return {
    symbol,
    exchange,
    price,
    currency: "INR",
    marketTime: readScreenerCloseDate(html),
    source: "Screener",
    url,
    fetchedAt: new Date().toISOString(),
  };
}

function readScreenerPrice(html) {
  const currentPriceMatch = String(html).match(/Current Price\s*<\/span>\s*<span[^>]*>\s*₹?\s*([0-9][0-9,.]*)/i)
    || stripTags(html).match(/Current Price\s*₹?\s*([0-9][0-9,.]*)/i);
  if (currentPriceMatch) return parsePrice(currentPriceMatch[1]);
  const headerText = stripTags(String(html).slice(0, 4000));
  const headerMatch = headerText.match(/₹\s*([0-9][0-9,.]*)\s+[-+]?\d+(?:\.\d+)?%/);
  return headerMatch ? parsePrice(headerMatch[1]) : null;
}

function readScreenerCloseDate(html) {
  const match = stripTags(html).match(/\b(\d{1,2}\s+[A-Za-z]{3})\s+-\s+close price\b/i);
  return match?.[1] || null;
}

function parsePrice(value) {
  const number = Number(String(value || "").replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase() === "screener" ? "screener" : "nse";
}

function sourceLabel(provider) {
  return provider === "screener" ? "Screener" : "NSE";
}

function normalizeTickerPart(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function readSetCookieHeader(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,\s]+=)/);
}
