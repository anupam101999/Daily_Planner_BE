const cache = new Map();
const inFlight = new Map();
const cacheMs = Number(process.env.FIN_MARKET_INTELLIGENCE_CACHE_MS || 60 * 60 * 1000);
const requestTimeoutMs = Number(process.env.FIN_MARKET_INTELLIGENCE_TIMEOUT_MS || 20_000);
const nseBaseUrl = "https://www.nseindia.com/api";
const bseBaseUrl = "https://api.bseindia.com/BseIndiaAPI/api";
const browserHeaders = {
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: "https://www.nseindia.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
};
const bseHeaders = { ...browserHeaders, Referer: "https://www.bseindia.com/" };
let nseCookie = "";
let nseCookieStoredAt = 0;
const nseCookieMs = 15 * 60 * 1000;

export async function fetchIndianInsiderTradeFilings({ fromDate, toDate, signal }) {
  const from = validDate(fromDate);
  const to = validDate(toDate);
  if (!from || !to || from > to) throw new Error("A valid insider filing date range is required");
  if (to > new Date().toISOString().slice(0, 10)) throw new Error("Insider filing range cannot end in the future");

  const ranges = splitDateRange(from, to, 31);
  const [nseResult, bseResult] = await Promise.allSettled([
    fetchWindows(ranges, ({ from: start, to: end }) => {
      const params = new URLSearchParams({ index: "equities", from_date: exchangeDate(start, "-"), to_date: exchangeDate(end, "-") });
      return cachedJson(`nse:insiders:filings:${start}:${end}`, `${nseBaseUrl}/corporates-pit?${params}`, { nse: true, signal });
    }, signal),
    fetchWindows(ranges, ({ from: start, to: end }) => {
      const params = new URLSearchParams({ fromdt: exchangeDate(start, "/"), todt: exchangeDate(end, "/"), pageno: "1", scripcode: "" });
      return cachedJson(`bse:insiders:filings:${start}:${end}`, `${bseBaseUrl}/InsiderTrade15/w?${params}`, { headers: bseHeaders, signal });
    }, signal),
  ]);
  if (nseResult.status === "rejected" && bseResult.status === "rejected") {
    throw new Error(`NSE and BSE insider sources failed. NSE: ${nseResult.reason.message}. BSE: ${bseResult.reason.message}`);
  }
  const nsePayloads = nseResult.status === "fulfilled" ? nseResult.value : [];
  const bsePayloads = bseResult.status === "fulfilled" ? bseResult.value : [];
  const nseRows = nsePayloads.flatMap((payload) => payload.data || []).map(normalizeNseTrade);
  const bseRows = bsePayloads.flatMap((payload) => payload.Table || []).map(normalizeBseTrade);
  const rows = [...nseRows, ...bseRows].filter((row) => isValidActivityDate(row));
  return {
    rows,
    received: rows.length,
    rejected: nseRows.length + bseRows.length - rows.length,
    sources: { nse: nseRows.length, bse: bseRows.length },
    sourceErrors: {
      nse: nseResult.status === "rejected" ? nseResult.reason.message : "",
      bse: bseResult.status === "rejected" ? bseResult.reason.message : "",
    },
    fromDate: from,
    toDate: to,
  };
}

async function fetchWindows(ranges, fetchWindow, signal) {
  const payloads = [];
  for (const range of ranges) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      signal?.throwIfAborted();
      try {
        payloads.push(await fetchWindow(range));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (attempt < 3) await abortableDelay(attempt * 500, signal);
      }
    }
    if (lastError) throw new Error(`Insider filing window ${range.from} to ${range.to} failed after 3 attempts: ${lastError.message}`);
  }
  return payloads;
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason || new Error("Operation aborted")); }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function cachedJson(key, url, options = {}) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.storedAt < cacheMs) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = (async () => {
    const data = options.nse
      ? await fetchNseJson(url, options.signal)
      : await fetchJson(url, options);
    cache.set(key, { data, storedAt: Date.now() });
    return data;
  })();
  inFlight.set(key, request);
  try { return await request; } finally { inFlight.delete(key); }
}

async function fetchNseJson(url, signal) {
  await refreshNseCookie(false, signal);
  let response = await fetchWithTimeout(url, { headers: nseHeaders(), signal });
  if (response.status === 401 || response.status === 403) {
    await refreshNseCookie(true, signal);
    response = await fetchWithTimeout(url, { headers: nseHeaders(), signal });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshNseCookie(force, signal) {
  if (!force && nseCookie && Date.now() - nseCookieStoredAt < nseCookieMs) return;
  const response = await fetchWithTimeout("https://www.nseindia.com/", {
    headers: { ...browserHeaders, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, signal,
  });
  if (!response.ok) throw new Error(`NSE session bootstrap failed with HTTP ${response.status}`);
  nseCookie = readCookies(response.headers);
  nseCookieStoredAt = Date.now();
}

function nseHeaders() {
  return {
    ...browserHeaders,
    ...(nseCookie ? { Cookie: nseCookie } : {}),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function readCookies(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  return values.flatMap((value) => value.split(/,(?=\s*[^;,=]+=[^;,]+)/)).map((value) => value.split(";", 1)[0].trim()).filter(Boolean).join("; ");
}

async function fetchJson(url, options) {
  const response = await fetchWithTimeout(url, { ...options, headers: options.headers || browserHeaders });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function normalizeNseTrade(row) {
  const holdingBeforePercent = nullableNumber(row.befAcqSharesPer);
  const holdingAfterPercent = nullableNumber(row.afterAcqSharesPer);
  const quantity = Math.abs(number(row.secAcq || row.buyQuantity || row.sellquantity || row.quantity || row.noOfSecurities));
  return {
    id: String(row.id || row.recordId || `${row.symbol}-${row.date || row.acqfromDt}-${row.acqName || row.personName}`),
    sourceRecordId: String(row.did || row.id || row.recordId || ""), symbol: normalizeSymbol(row.symbol),
    company: clean(row.company || row.compName), person: clean(row.acqName || row.personName || row.name),
    category: clean(row.personCategory || row.category), transactionType: clean(row.tdpTransactionType || row.transactionType || row.mode),
    acquisitionMode: clean(row.acqMode), quantity, value: Math.abs(number(row.secVal || row.value)),
    date: clean(row.acqfromDt || row.transactionDate || row.date), disclosureDate: clean(row.date || row.intimDt),
    disclosureUrl: safeUrl(row.xbrl), holdingBeforePercent, holdingAfterPercent,
    marketCapImpactPercent: marketCapImpact(quantity, number(row.befAcqSharesNo), holdingBeforePercent, number(row.afterAcqSharesNo), holdingAfterPercent), source: "NSE",
  };
}

function normalizeBseTrade(row) {
  const code = String(row.Fld_ScripCode || "").trim();
  const holdingBeforePercent = nullableNumber(row.Fld_PercentofShareholdingPre);
  const holdingAfterPercent = nullableNumber(row.Fld_PercentofShareholdingPost);
  const quantity = Math.abs(number(row.Fld_SecurityNo));
  return {
    id: `bse-${row.Fld_ID || `${code}-${row.Fld_CreateDate}`}`, sourceRecordId: String(row.Fld_ID || ""), symbol: code ? `BSE:${code}` : "BSE",
    company: clean(row.Companyname).replace(/-\$$/, "").trim(), person: clean(row.Fld_PromoterName), category: clean(row.Fld_PersonCatgName),
    transactionType: normalizeTradeType(row.Fld_TransactionType), acquisitionMode: clean(row.ModeOfAquisation), quantity,
    value: Math.abs(number(row.Fld_SecurityValue)), date: formatBseDate(row.Fld_FromDate || row.Fld_LetterDate),
    disclosureDate: formatBseDate(row.Fld_LetterDate || row.Fld_StampDate), disclosureUrl: safeUrl(row.xbrlurl ? `https://www.bseindia.com${row.xbrlurl}` : ""),
    holdingBeforePercent, holdingAfterPercent,
    marketCapImpactPercent: marketCapImpact(quantity, number(row.Fld_SecurityNoPrior), holdingBeforePercent, number(row.Fld_SecurityNoPost), holdingAfterPercent), source: "BSE",
  };
}

function marketCapImpact(quantity, beforeShares, beforePercent, afterShares, afterPercent) {
  const bases = [beforeShares > 0 && beforePercent > 0 ? beforeShares / (beforePercent / 100) : 0, afterShares > 0 && afterPercent > 0 ? afterShares / (afterPercent / 100) : 0].filter((value) => Number.isFinite(value) && value > 0);
  if (quantity > 0 && bases.length) return (quantity / bases[0]) * 100;
  return beforePercent != null && afterPercent != null ? Math.abs(afterPercent - beforePercent) : null;
}

function splitDateRange(from, to, maximumDays) {
  const ranges = []; const end = Date.parse(`${to}T00:00:00Z`); let cursor = Date.parse(`${from}T00:00:00Z`);
  while (cursor <= end) { const rangeEnd = Math.min(end, cursor + (maximumDays - 1) * 86400000); ranges.push({ from: new Date(cursor).toISOString().slice(0, 10), to: new Date(rangeEnd).toISOString().slice(0, 10) }); cursor = rangeEnd + 86400000; }
  return ranges;
}
function validDate(value) { const text = String(value || "").trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ""; const date = new Date(`${text}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : ""; }
function exchangeDate(value, separator) { const [year, month, day] = value.split("-"); return [day, month, year].join(separator); }
function activityDate(value) { const match = String(value || "").match(/^(\d{1,2})-([A-Z]{3})-(\d{4})/i); const month = match ? ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(match[2].toUpperCase()) : -1; return month < 0 ? "" : `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`; }
function isValidActivityDate(row) { const activity = activityDate(row.date); const disclosure = activityDate(row.disclosureDate); const today = new Date().toISOString().slice(0, 10); return Boolean(activity && activity <= today && (!disclosure || activity <= disclosure)); }
function normalizeTradeType(value) { const type = clean(value); if (/acquisition|purchase|\bbuy\b/i.test(type)) return "Buy"; if (/disposal|sale|\bsell\b/i.test(type)) return "Sell"; return type; }
function formatBseDate(value) { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/); if (!match) return clean(value); const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(match[2]) - 1]; return `${match[3]}-${month}-${match[1]}`; }
function normalizeSymbol(value) { return String(value || "").trim().toUpperCase().replace(/\.(NS|BO)$/i, ""); }
function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function number(value) { const parsed = Number(String(value ?? "0").replace(/,/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(value) { if (value == null || String(value).trim() === "" || /^nil$/i.test(String(value).trim())) return null; const parsed = Number(String(value).replace(/,/g, "")); return Number.isFinite(parsed) ? parsed : null; }
function safeUrl(value) { try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } }

export const insiderTradeSourceTestUtils = { normalizeNseTrade, normalizeBseTrade, marketCapImpact, activityDate, isValidActivityDate, splitDateRange };
