const quoteCache = new Map();
const quoteCacheMs = Number(process.env.FIN_QUOTE_CACHE_MS || 60_000);
const quoteRequestDelayMs = Number(process.env.FIN_QUOTE_REQUEST_DELAY_MS || 850);
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

let nseCookie = "";
let nseCookieAt = 0;

export async function getMarketFinanceQuotes(tickers, provider = "nse") {
  const source = normalizeProvider(provider);
  const quotes = [];

  for (const ticker of tickers) {
    try {
      quotes.push(await getMarketFinanceQuote(ticker.symbol, ticker.exchange, source, { name: ticker.name }));
    } catch (error) {
      quotes.push({
        symbol: normalizeTickerPart(ticker.symbol),
        exchange: normalizeTickerPart(ticker.exchange || ""),
        error: error?.message || "Quote unavailable",
        source: sourceLabel(source),
        fetchedAt: new Date().toISOString(),
      });
    }
    if (quoteRequestDelayMs > 0) await delay(quoteRequestDelayMs);
  }

  return quotes;
}

export async function getMarketFinanceQuote(symbol, exchange = "", provider = "nse", context = {}) {
  const source = normalizeProvider(provider);
  const normalizedSymbol = normalizeTickerPart(symbol);
  const normalizedExchange = normalizeTickerPart(exchange);
  if (!normalizedSymbol || !normalizedExchange || normalizedExchange === "MANUAL") {
    throw new Error(`${sourceLabel(source)} quote requires a symbol and exchange for ${normalizedSymbol || "asset"}`);
  }

  const cacheKey = `${source}:${normalizedSymbol}:${normalizedExchange}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < quoteCacheMs) return cached.quote;

  const quote = await getQuoteWithFallbacks(normalizedSymbol, normalizedExchange, source, context);
  quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
  return quote;
}

async function getQuoteWithFallbacks(symbol, exchange, source, context = {}) {
  const primary = source === "screener" ? getScreenerFinanceQuote : getNseFinanceQuote;
  try {
    return await primary(symbol, exchange);
  } catch (primaryError) {
    const fallbackOrder = source === "screener"
      ? [getMfapiFinanceQuote, getGoogleFinanceQuote, getYahooFinanceQuote, getNseFinanceQuote]
      : [getMfapiFinanceQuote, getScreenerFinanceQuote, getYahooFinanceQuote, getGoogleFinanceQuote];
    let latestError = primaryError;
    const errors = [primaryError.message];

    for (const fallback of fallbackOrder) {
      try {
        const quote = await fallback(symbol, exchange, context);
        return {
          ...quote,
          source: `${quote.source} (${sourceLabel(source)} fallback)`,
          fallbackFrom: sourceLabel(source),
          fallbackReason: primaryError.message,
        };
      } catch (error) {
        latestError = error;
        errors.push(error.message);
      }
    }

    throw new Error(`${latestError.message}; tried ${sourceLabel(source)} fallback chain: ${errors.join(" | ")}`);
  }
}

async function getNseFinanceQuote(symbol, exchange) {
  if (exchange === "MUTF_IN") throw new Error(`NSE quote provider does not support mutual fund exchange ${symbol}:${exchange}`);
  const cookie = await getNseCookie();
  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
      "User-Agent": userAgent,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  }, `NSE quote for ${symbol}`);
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

async function getGoogleFinanceQuote(symbol, exchange) {
  const googleExchange = exchange === "BOM" ? "BSE" : exchange;
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${encodeURIComponent(googleExchange)}`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent,
    },
  }, `Google Finance quote for ${symbol}:${googleExchange}`);
  if (!response.ok) throw new Error(`Google Finance quote failed for ${symbol}:${googleExchange}: ${response.status}`);

  const html = await response.text();
  const price = readGooglePrice(html);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Google Finance quote did not include a valid price for ${symbol}:${googleExchange}`);
  return {
    symbol,
    exchange,
    price,
    currency: readGoogleCurrency(html),
    marketTime: readAttribute(html, "data-last-normal-market-timestamp"),
    source: "Google Finance",
    url,
    fetchedAt: new Date().toISOString(),
  };
}

async function getYahooFinanceQuote(symbol, exchange) {
  const yahooSymbol = yahooTicker(symbol, exchange);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": userAgent,
    },
  }, `Yahoo Finance quote for ${yahooSymbol}`);
  if (!response.ok) throw new Error(`Yahoo Finance quote failed for ${yahooSymbol}: ${response.status}`);

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const error = payload?.chart?.error;
  if (error) throw new Error(`Yahoo Finance quote failed for ${yahooSymbol}: ${error.description || error.code || "unavailable"}`);
  const quote = result?.indicators?.quote?.[0];
  const lastClose = [...(quote?.close || [])].reverse().find((value) => Number(value) > 0);
  const price = Number(result?.meta?.regularMarketPrice || lastClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Yahoo Finance quote did not include a valid price for ${yahooSymbol}`);
  return {
    symbol,
    exchange,
    price,
    currency: result?.meta?.currency || "INR",
    marketTime: result?.meta?.regularMarketTime ? new Date(Number(result.meta.regularMarketTime) * 1000).toISOString() : null,
    source: "Yahoo Finance",
    url,
    fetchedAt: new Date().toISOString(),
  };
}

async function getMfapiFinanceQuote(symbol, exchange, context = {}) {
  if (exchange !== "MUTF_IN") throw new Error(`MFAPI quote provider supports only mutual fund exchange, not ${symbol}:${exchange}`);
  const scheme = /^\d+$/.test(symbol)
    ? { schemeCode: symbol, schemeName: context.name || symbol }
    : await findMfapiScheme(context.name || symbol);
  if (!scheme?.schemeCode) throw new Error(`MFAPI could not resolve mutual fund scheme for ${context.name || symbol}`);

  const url = `https://api.mfapi.in/mf/${encodeURIComponent(scheme.schemeCode)}/latest`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": userAgent,
    },
  }, `MFAPI quote for ${scheme.schemeCode}`);
  if (!response.ok) throw new Error(`MFAPI quote failed for ${scheme.schemeCode}: ${response.status}`);

  const payload = await response.json();
  const nav = Number(payload?.data?.[0]?.nav);
  if (!Number.isFinite(nav) || nav <= 0) throw new Error(`MFAPI quote did not include a valid NAV for ${scheme.schemeCode}`);
  return {
    symbol,
    exchange,
    price: nav,
    currency: "INR",
    marketTime: payload?.data?.[0]?.date || null,
    source: "MFAPI",
    schemeCode: String(scheme.schemeCode),
    schemeName: payload?.meta?.scheme_name || scheme.schemeName || context.name || symbol,
    url,
    fetchedAt: new Date().toISOString(),
  };
}

async function getScreenerFinanceQuote(symbol, exchange) {
  if (exchange === "MUTF_IN") throw new Error(`Screener quote provider does not support mutual fund exchange ${symbol}:${exchange}`);
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent,
    },
  }, `Screener quote for ${symbol}`);
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

async function getNseCookie() {
  if (nseCookie && Date.now() - nseCookieAt < 15 * 60_000) return nseCookie;
  const response = await fetchWithRetry("https://www.nseindia.com", {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent,
    },
  }, "NSE cookie");
  const rawCookies = response.headers.getSetCookie?.() || readSetCookieHeader(response.headers.get("set-cookie"));
  nseCookie = rawCookies.map((cookie) => String(cookie).split(";")[0]).filter(Boolean).join("; ");
  nseCookieAt = Date.now();
  return nseCookie;
}

function readGooglePrice(html) {
  return readNumberAttribute(html, "data-last-price") ?? readFirstCurrencyPrice(html);
}

function readFirstCurrencyPrice(html) {
  const quoteStart = String(html).search(/<div class="gO24Ff">|<div class="JV7gl"|data-p="%\.@\.\[null,\[/);
  const searchable = stripTags(quoteStart >= 0 ? String(html).slice(quoteStart, quoteStart + 6000) : html);
  const match = searchable.match(currencyAmountPattern());
  return match ? parsePrice(match[0]) : null;
}

function readGoogleCurrency(html) {
  if (String(html).includes(String.fromCharCode(0x20B9)) || /Rs\.?/i.test(html)) return "INR";
  return readAttribute(html, "data-currency-code") || "INR";
}

function readScreenerPrice(html) {
  const rupee = String.fromCharCode(0x20B9);
  const currentPricePattern = new RegExp(`Current Price\\s*(?:${rupee})?\\s*([0-9][0-9,.]*)`, "i");
  const currentPriceMatch = stripTags(html).match(currentPricePattern);
  if (currentPriceMatch) return parsePrice(currentPriceMatch[1]);

  const headerText = stripTags(String(html).slice(0, 4000));
  const headerMatch = headerText.match(new RegExp(`${rupee}\\s*([0-9][0-9,.]*)\\s+[-+]?\\d+(?:\\.\\d+)?%`));
  return headerMatch ? parsePrice(headerMatch[1]) : null;
}

function readScreenerCloseDate(html) {
  const match = stripTags(html).match(/\b(\d{1,2}\s+[A-Za-z]{3})\s+-\s+close price\b/i);
  return match?.[1] || null;
}

function readAttribute(html, attribute) {
  const match = String(html || "").match(new RegExp(`${attribute}="([^"]+)"`));
  return match?.[1] || "";
}

function readNumberAttribute(html, attribute) {
  const rawValue = readAttribute(html, attribute);
  if (!rawValue) return null;
  const number = Number(rawValue.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
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

async function findMfapiScheme(query) {
  const cleanQuery = String(query || "").replace(/_/g, " ").trim();
  if (!cleanQuery) return null;
  const url = `https://api.mfapi.in/mf/search?q=${encodeURIComponent(cleanQuery)}`;
  const response = await fetchWithRetry(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": userAgent,
    },
  }, `MFAPI scheme search for ${cleanQuery}`);
  if (!response.ok) throw new Error(`MFAPI scheme search failed for ${cleanQuery}: ${response.status}`);

  const candidates = (await response.json()).slice(0, 25);
  const scored = [];
  for (const candidate of candidates) {
    const latest = await readMfapiLatest(candidate.schemeCode);
    if (!latest) continue;
    scored.push({
      ...candidate,
      latest,
      score: mfapiSchemeScore(cleanQuery, candidate.schemeName, latest.date),
    });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored[0] || null;
}

async function readMfapiLatest(schemeCode) {
  const url = `https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}/latest`;
  try {
    const response = await fetchWithRetry(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": userAgent,
      },
    }, `MFAPI latest NAV for ${schemeCode}`);
    if (!response.ok) return null;
    const payload = await response.json();
    const nav = Number(payload?.data?.[0]?.nav);
    return Number.isFinite(nav) && nav > 0 ? { nav, date: payload?.data?.[0]?.date || "" } : null;
  } catch {
    return null;
  }
}

function mfapiSchemeScore(query, schemeName, latestDate) {
  const text = String(schemeName || "").toLowerCase();
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter((token) => token.length > 2);
  const tokenScore = tokens.reduce((score, token) => score + (text.includes(token) ? 10 : 0), 0);
  const directScore = text.includes("direct") ? 30 : 0;
  const growthScore = text.includes("growth") ? 30 : 0;
  const dateScore = mfapiDateScore(latestDate);
  return tokenScore + directScore + growthScore + dateScore;
}

function mfapiDateScore(value) {
  const match = String(value || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return 0;
  const timestamp = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isFinite(timestamp) ? timestamp / 31_536_000_000 : 0;
}

function yahooTicker(symbol, exchange) {
  if (exchange === "NSE") return `${symbol}.NS`;
  if (exchange === "BSE" || exchange === "BOM") return `${symbol}.BO`;
  if (exchange === "MUTF_IN") throw new Error(`Yahoo Finance quote provider does not support mutual fund exchange ${symbol}:${exchange}`);
  return symbol;
}

function readSetCookieHeader(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,\s]+=)/);
}

async function fetchWithRetry(url, options, label) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    await delay(Math.max(quoteRequestDelayMs, 1000));
    try {
      return await fetch(url, options);
    } catch (retryError) {
      throw new Error(`${label} request failed after retry: ${retryError.message}`);
    }
  }
  if (response.status !== 429) return response;

  const retryAfter = Number(response.headers.get("retry-after") || 0);
  await delay(Math.max(quoteRequestDelayMs * 3, retryAfter ? retryAfter * 1000 : 2500));
  response = await fetch(url, options);
  if (response.status === 429) throw new Error(`${label} rate limited after retry: 429`);
  return response;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
