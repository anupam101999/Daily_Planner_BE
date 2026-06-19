const cache = new Map();
const inFlight = new Map();
const cacheMs = Number(
  process.env.FIN_MARKET_INTELLIGENCE_CACHE_MS || 60 * 60 * 1000,
);
const requestTimeoutMs = Number(
  process.env.FIN_MARKET_INTELLIGENCE_TIMEOUT_MS || 20_000,
);
const nseBaseUrl = "https://www.nseindia.com/api";
const bseBaseUrl = "https://api.bseindia.com/BseIndiaAPI/api";
export const NEWS_COUNTRIES = [
  { code: "IN", name: "India", language: "en" },
  { code: "US", name: "United States", language: "en" },
  { code: "GB", name: "United Kingdom", language: "en" },
  { code: "CA", name: "Canada", language: "en" },
  { code: "AU", name: "Australia", language: "en" },
  { code: "SG", name: "Singapore", language: "en" },
  { code: "HK", name: "Hong Kong", language: "en" },
  { code: "JP", name: "Japan", language: "en" },
  { code: "DE", name: "Germany", language: "en" },
  { code: "FR", name: "France", language: "en" },
  { code: "AE", name: "United Arab Emirates", language: "en" },
  { code: "ZA", name: "South Africa", language: "en" },
  { code: "BR", name: "Brazil", language: "en" },
  { code: "CH", name: "Switzerland", language: "en" },
];
const browserHeaders = {
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: "https://www.nseindia.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
};
const bseHeaders = { ...browserHeaders, Referer: "https://www.bseindia.com/" };

export async function getMarketIntelligence(assets, { country = "IN" } = {}) {
  const symbols = [
    ...new Set(
      assets.map((asset) => normalizeSymbol(asset.symbol)).filter(Boolean),
    ),
  ].sort();
  const selectedCountry =
    NEWS_COUNTRIES.find(
      (item) => item.code === String(country).toUpperCase(),
    ) || NEWS_COUNTRIES[0];
  const portfolioQuery = symbols.slice(0, 12).join(" OR ") || "stock market";
  const [
    flows,
    events,
    actions,
    insiders,
    bseInsiders,
    portfolioInsiders,
    shareholdings,
    yahooMarket,
    yahooPortfolio,
    googleMarket,
    googlePortfolio,
    announcements,
  ] = await Promise.all([
    capture(
      "institutionalFlows",
      cachedJson("nse:flows", `${nseBaseUrl}/fiidiiTradeReact`),
      [],
    ),
    capture(
      "events",
      cachedJson("nse:events", `${nseBaseUrl}/event-calendar`),
      [],
    ),
    capture(
      "corporateActions",
      cachedJson(
        "nse:actions",
        `${nseBaseUrl}/corporates-corporateActions?index=equities`,
      ),
      [],
    ),
    capture("insiderTrades", getRecentMarketInsiders(), []),
    capture("bseInsiderTrades", getRecentBseInsiders(), []),
    capture("portfolioInsiderTrades", getPortfolioInsiders(symbols), []),
    capture(
      "promoterHoldings",
      cachedJson(
        "nse:shareholdings",
        `${nseBaseUrl}/corporate-share-holdings-master?index=equities`,
      ),
      [],
    ),
    capture(
      "yahooMarketNews",
      getYahooNews(`${selectedCountry.name} stock market`, "market"),
      [],
    ),
    capture("yahooPortfolioNews", getPortfolioNews(symbols), []),
    capture(
      "googleMarketNews",
      getGoogleNews(
        `${selectedCountry.name} stock market investing`,
        selectedCountry,
        "",
      ),
      [],
    ),
    capture(
      "googlePortfolioNews",
      getGoogleNews(portfolioQuery, selectedCountry, "portfolio"),
      [],
    ),
    capture(
      "nseAnnouncements",
      cachedJson(
        "nse:announcements",
        `${nseBaseUrl}/corporate-announcements?index=equities`,
      ),
      [],
    ),
  ]);

  const portfolioEvents = filterBySymbols(events.data, symbols).map(
    normalizeEvent,
  );
  const allEvents = events.data.map(normalizeEvent);
  const portfolioActions = filterBySymbols(actions.data, symbols).map(
    normalizeAction,
  );
  const allActions = actions.data.map(normalizeAction);
  const normalizedInsiders = mergeInsiderTrades([
    ...insiders.data.map(normalizeInsiderTrade),
    ...bseInsiders.data.map(normalizeBseInsiderTrade),
  ]);
  const normalizedPortfolioInsiders = portfolioInsiders.data.map(
    normalizeInsiderTrade,
  );
  const promoterRows = buildPromoterHoldings(shareholdings.data, symbols);
  const announcementNews = announcements.data.map(normalizeAnnouncement);
  const portfolioAnnouncementNews = filterBySymbols(announcementNews, symbols);
  const marketNews = dedupe(
    [
      ...googleMarket.data,
      ...yahooMarket.data,
      ...(selectedCountry.code === "IN" ? announcementNews.slice(0, 8) : []),
    ],
    newsKey,
  );
  const portfolioNews = dedupe(
    [
      ...googlePortfolio.data,
      ...yahooPortfolio.data,
      ...portfolioAnnouncementNews.slice(0, 12),
    ],
    newsKey,
  );

  return {
    refreshedAt: new Date().toISOString(),
    refreshAfter: new Date(Date.now() + cacheMs).toISOString(),
    cacheSeconds: Math.round(cacheMs / 1000),
    selectedCountry,
    countries: NEWS_COUNTRIES,
    trackedSymbols: symbols,
    sources: Object.fromEntries(
      [
        flows,
        events,
        actions,
        insiders,
        bseInsiders,
        portfolioInsiders,
        shareholdings,
        yahooMarket,
        yahooPortfolio,
        googleMarket,
        googlePortfolio,
        announcements,
      ].map((result) => [result.name, result.status]),
    ),
    news: {
      portfolio: sortNews(portfolioNews).slice(0, 80),
      market: sortNews(marketNews).slice(0, 80),
    },
    institutionalFlows: flows.data.map(normalizeInstitutionalFlow),
    events: {
      portfolio: portfolioEvents.slice(0, 50),
      market: allEvents.slice(0, 50),
    },
    earnings: {
      portfolio: portfolioEvents.filter(isEarningsEvent).slice(0, 30),
      market: allEvents.filter(isEarningsEvent).slice(0, 30),
    },
    dividends: {
      portfolio: portfolioActions.filter(isDividendAction).slice(0, 30),
      market: allActions.filter(isDividendAction).slice(0, 30),
    },
    insiderTrades: {
      portfolio: normalizedPortfolioInsiders.slice(0, 50),
      market: normalizedInsiders.slice(0, 50),
    },
    promoterHoldings: promoterRows,
  };
}

export async function getIndianInsiderTrades({
  year,
  symbols = [],
  companyNames = [],
  search = "",
  date = "",
  page = 1,
  pageSize = 50,
} = {}) {
  const currentYear = new Date().getUTCFullYear();
  const selectedYear = Math.max(
    2018,
    Math.min(currentYear, Number(year || currentYear)),
  );
  const endDate =
    selectedYear === currentYear ? nseToday() : `31-12-${selectedYear}`;
  const exactDate = validDateFilter(date);
  const [nseResult, bseResult] = await Promise.allSettled([
    cachedJson(
      `nse:insiders:year:${selectedYear}:${endDate}`,
      `${nseBaseUrl}/corporates-pit?index=equities&from_date=01-01-${selectedYear}&to_date=${endDate}`,
    ),
    getBseInsiderTrades(selectedYear, exactDate),
  ]);
  if (nseResult.status === "rejected" && bseResult.status === "rejected")
    throw new Error("NSE and BSE insider disclosure sources are unavailable");
  const allowed = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const allowedCompanies = companyNames
    .map(normalizeCompanyName)
    .filter(Boolean);
  const query = cleanText(search);
  const nseRows =
    nseResult.status === "fulfilled"
      ? (nseResult.value.data || []).map(normalizeInsiderTrade)
      : [];
  const bseRows =
    bseResult.status === "fulfilled"
      ? bseResult.value.map(normalizeBseInsiderTrade)
      : [];
  const scopedRows = mergeInsiderTrades(
    [...nseRows, ...bseRows].filter(
      (row) => !hasInvalidInsiderActivityDate(row),
    ),
  ).filter((row) => {
    if (
      allowed.size &&
      !allowed.has(row.symbol) &&
      !allowedCompanies.some((name) =>
        companyNamesMatch(name, normalizeCompanyName(row.company)),
      )
    )
      return false;
    if (exactDate && insiderDate(row.date) !== exactDate) return false;
    return true;
  });
  const primarySearchRows = query
    ? scopedRows.filter((row) => matchesInsiderPrimarySearch(row, query))
    : scopedRows;
  const exactSearchRows =
    query && !primarySearchRows.length
      ? scopedRows.filter((row) => matchesInsiderSearchExact(row, query))
      : primarySearchRows;
  const rows = (
    query && !exactSearchRows.length
      ? scopedRows.filter((row) => matchesInsiderSearch(row, query))
      : exactSearchRows
  ).sort(
    (left, right) => insiderTimestamp(right.date) - insiderTimestamp(left.date),
  );
  const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 50));
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const safePage = Math.max(1, Math.min(pageCount, Number(page) || 1));
  const offset = (safePage - 1) * safePageSize;
  return {
    rows: rows.slice(offset, offset + safePageSize),
    total: rows.length,
    page: safePage,
    pageSize: safePageSize,
    pageCount,
    year: selectedYear,
    availableYears: Array.from(
      { length: currentYear - 2017 },
      (_, index) => currentYear - index,
    ),
    source:
      [nseRows.length ? "NSE" : "", bseRows.length ? "BSE" : ""]
        .filter(Boolean)
        .join(" and ") + " insider trading disclosures",
    sources: {
      nse: nseResult.status === "fulfilled",
      bse: bseResult.status === "fulfilled",
    },
    refreshedAt: new Date().toISOString(),
  };
}

export async function fetchIndianInsiderTradeFilings({ fromDate, toDate }) {
  const from = validDateFilter(fromDate);
  const to = validDateFilter(toDate);
  if (!from || !to || from > to) throw new Error("A valid insider filing date range is required");
  if (to > new Date().toISOString().slice(0, 10)) throw new Error("Insider filing range cannot end in the future");

  const nseRanges = splitDateRange(from, to, 31);
  const bseRanges = splitDateRange(from, to, 31);
  const [nsePayloads, bsePayloads] = await Promise.all([
    fetchInsiderWindows(nseRanges, (range) => {
      const params = new URLSearchParams({ index: "equities", from_date: nseDate(range.from), to_date: nseDate(range.to) });
      return cachedJson(`nse:insiders:filings:${range.from}:${range.to}`, `${nseBaseUrl}/corporates-pit?${params.toString()}`);
    }),
    fetchInsiderWindows(bseRanges, (range) => {
      const params = new URLSearchParams({ fromdt: bseDate(range.from), todt: bseDate(range.to), pageno: "1", scripcode: "" });
      return cachedJson(`bse:insiders:filings:${range.from}:${range.to}`, `${bseBaseUrl}/InsiderTrade15/w?${params.toString()}`, { headers: bseHeaders });
    }),
  ]);
  const nseRows = nsePayloads.flatMap((payload) => payload.data || []).map(normalizeInsiderTrade);
  const bseRows = bsePayloads.flatMap((payload) => payload.Table || []).map(normalizeBseInsiderTrade);
  const rows = [...nseRows, ...bseRows].filter((row) => !hasInvalidInsiderActivityDate(row));
  return {
    rows,
    received: rows.length,
    rejected: nseRows.length + bseRows.length - rows.length,
    sources: { nse: nseRows.length, bse: bseRows.length },
    fromDate: from,
    toDate: to,
  };
}

async function fetchInsiderWindows(ranges, fetchWindow) {
  const payloads = [];
  for (const range of ranges) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        payloads.push(await fetchWindow(range));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    if (lastError) throw new Error(`Insider filing window ${range.from} to ${range.to} failed after 3 attempts: ${lastError.message}`);
  }
  return payloads;
}

async function getBseInsiderTrades(year, exactDate) {
  const ranges = exactDate
    ? [{ from: exactDate, to: exactDate }]
    : bseDateRanges(year);
  const results = await Promise.allSettled(
    ranges.map(({ from, to }) => {
      const fromDate = bseDate(from);
      const toDate = bseDate(to);
      const params = new URLSearchParams({
        fromdt: fromDate,
        todt: toDate,
        pageno: "1",
        scripcode: "",
      });
      return cachedJson(
        `bse:insiders:${from}:${to}`,
        `${bseBaseUrl}/InsiderTrade15/w?${params.toString()}`,
        { headers: bseHeaders },
      );
    }),
  );
  const payloads = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (!payloads.length)
    throw (
      results.find((result) => result.status === "rejected")?.reason ||
      new Error("BSE insider disclosures are unavailable")
    );
  return payloads.flatMap((payload) => payload.Table || []);
}

function bseDateRanges(year) {
  const today = new Date();
  const end =
    year === today.getUTCFullYear()
      ? new Date(Date.UTC(year, today.getUTCMonth(), today.getUTCDate()))
      : new Date(Date.UTC(year, 11, 31));
  const ranges = [];
  let cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor <= end) {
    const rangeEnd = new Date(
      Math.min(end.getTime(), cursor.getTime() + 89 * 86400000),
    );
    ranges.push({
      from: cursor.toISOString().slice(0, 10),
      to: rangeEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(rangeEnd.getTime() + 86400000);
  }
  return ranges;
}

function bseDate(value) {
  const [year, month, day] = String(value).split("-");
  return `${day}/${month}/${year}`;
}

function nseDate(value) {
  const [year, month, day] = String(value).split("-");
  return `${day}-${month}-${year}`;
}

function splitDateRange(fromDate, toDate, maximumDays) {
  const ranges = [];
  const end = Date.parse(`${toDate}T00:00:00Z`);
  let cursor = Date.parse(`${fromDate}T00:00:00Z`);
  while (cursor <= end) {
    const rangeEnd = Math.min(end, cursor + (maximumDays - 1) * 86400000);
    ranges.push({ from: new Date(cursor).toISOString().slice(0, 10), to: new Date(rangeEnd).toISOString().slice(0, 10) });
    cursor = rangeEnd + 86400000;
  }
  return ranges;
}

function matchesInsiderSearch(row, search) {
  const queryTokens = searchTokens(search);
  if (!queryTokens.length) return true;
  const words = searchTokens(
    [
      row.symbol,
      row.company,
      row.person,
      row.category,
      row.transactionType,
      row.acquisitionMode,
    ].join(" "),
  );
  return queryTokens.every((query) =>
    words.some(
      (word) =>
        word.includes(query) ||
        (word.length >= 4 && query.includes(word)) ||
        similarWord(query, word),
    ),
  );
}

function matchesInsiderSearchExact(row, search) {
  const queryTokens = searchTokens(search);
  if (!queryTokens.length) return true;
  const words = searchTokens(
    [
      row.symbol,
      row.company,
      row.person,
      row.category,
      row.transactionType,
      row.acquisitionMode,
    ].join(" "),
  );
  return queryTokens.every((query) =>
    words.some((word) => word.includes(query)),
  );
}

function matchesInsiderPrimarySearch(row, search) {
  const queryTokens = searchTokens(search);
  if (!queryTokens.length) return true;
  const words = searchTokens([row.symbol, row.company].join(" "));
  return queryTokens.every((query) =>
    words.some((word) => word.includes(query)),
  );
}

function searchTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function similarWord(left, right) {
  if (left.length < 4 || right.length < 4) return false;
  if (right.length > left.length + 2) right = right.slice(0, left.length);
  if (left.length > right.length + 2) left = left.slice(0, right.length);
  if (Math.abs(left.length - right.length) > 2) return false;
  const limit = left.length >= 7 ? 3 : left.length >= 5 ? 2 : 1;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }
    if (rowMinimum > limit) return false;
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] <= limit;
}

function insiderTimestamp(value) {
  const date = insiderDate(value);
  if (!date) return 0;
  const time = String(value || "").match(/\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return Date.parse(
    `${date}T${time ? `${String(time[1]).padStart(2, "0")}:${time[2]}:${time[3] || "00"}` : "00:00:00"}Z`,
  );
}

function validDateFilter(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
    ? ""
    : text;
}

function insiderDate(value) {
  const match = String(value || "").match(/^(\d{1,2})-([A-Z]{3})-(\d{4})/i);
  if (!match) return "";
  const month = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ].indexOf(match[2].toUpperCase());
  return month < 0
    ? ""
    : `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

async function getRecentMarketInsiders() {
  const currentYear = new Date().getUTCFullYear();
  const endDate = nseToday();
  const payload = await cachedJson(
    `nse:insiders:recent:${currentYear}:${endDate}`,
    `${nseBaseUrl}/corporates-pit?index=equities&from_date=01-01-${currentYear}&to_date=${endDate}`,
  );
  return payload.data || [];
}

async function getRecentBseInsiders() {
  const end = new Date();
  const yearStart = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  const start = new Date(
    Math.max(yearStart.getTime(), end.getTime() - 89 * 86400000),
  );
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    fromdt: bseDate(from),
    todt: bseDate(to),
    pageno: "1",
    scripcode: "",
  });
  const payload = await cachedJson(
    `bse:insiders:recent:${from}:${to}`,
    `${bseBaseUrl}/InsiderTrade15/w?${params.toString()}`,
    { headers: bseHeaders },
  );
  return payload.Table || [];
}

function nseToday() {
  const date = new Date();
  return `${String(date.getUTCDate()).padStart(2, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

async function getPortfolioInsiders(symbols) {
  const results = await Promise.allSettled(
    symbols
      .slice(0, 20)
      .map((symbol) =>
        cachedJson(
          `nse:insiders:symbol:${symbol}`,
          `${nseBaseUrl}/corporates-pit?index=equities&symbol=${encodeURIComponent(symbol)}`,
        ),
      ),
  );
  return dedupe(
    results.flatMap((result) =>
      result.status === "fulfilled" ? result.value.data || [] : [],
    ),
    (row) => row.did || `${row.symbol}-${row.acqName}-${row.date}`,
  );
}

export function clearMarketIntelligenceCache() {
  cache.clear();
}

async function getPortfolioNews(symbols) {
  const results = await Promise.allSettled(
    symbols.slice(0, 15).map((symbol) => getYahooNews(`${symbol}.NS`, symbol)),
  );
  if (
    symbols.length &&
    !results.some((result) => result.status === "fulfilled")
  )
    throw new Error("All portfolio news requests failed");
  const rows = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  return dedupe(rows, (row) => row.id || row.url).sort((left, right) =>
    String(right.publishedAt).localeCompare(String(left.publishedAt)),
  );
}

async function getYahooNews(query, trackedSymbol) {
  const key = `yahoo:news:${query}`;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=12`;
  const payload = await cachedJson(key, url, { headers: browserHeaders });
  const quote = payload.quotes?.[0] || {};
  const news =
    trackedSymbol === "market"
      ? payload.news || []
      : (payload.news || []).filter((row) =>
          isRelevantNews(row, trackedSymbol, quote),
        );
  return news
    .map((row) => ({
      id: row.uuid || row.link,
      title: cleanText(row.title),
      publisher: cleanText(row.publisher) || "Market news",
      url: safeUrl(row.link),
      publishedAt: row.providerPublishTime
        ? new Date(Number(row.providerPublishTime) * 1000).toISOString()
        : null,
      thumbnail: safeUrl(
        row.thumbnail?.resolutions?.find((image) => image.tag === "140x140")
          ?.url || row.thumbnail?.resolutions?.[0]?.url,
      ),
      trackedSymbol: trackedSymbol === "market" ? "" : trackedSymbol,
      relatedSymbols: (row.relatedTickers || []).map(normalizeSymbol),
    }))
    .filter((row) => row.title && row.url);
}

async function getGoogleNews(query, country, trackedSymbol) {
  const locale = `en-${country.code}`;
  const key = `google:news:${country.code}:${query}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale}&gl=${country.code}&ceid=${country.code}:${country.language}`;
  const xml = await cachedText(key, url);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((match) => {
      const item = match[1];
      const title = decodeXml(readXmlTag(item, "title"));
      const publisher = decodeXml(readXmlTag(item, "source")) || "Google News";
      return {
        id: decodeXml(readXmlTag(item, "guid")) || readXmlTag(item, "link"),
        title,
        publisher,
        url: safeUrl(decodeXml(readXmlTag(item, "link"))),
        publishedAt: validIsoDate(decodeXml(readXmlTag(item, "pubDate"))),
        thumbnail: "",
        trackedSymbol:
          trackedSymbol === "portfolio"
            ? inferTrackedSymbol(title)
            : trackedSymbol,
        relatedSymbols: [],
        source: "Google News",
      };
    })
    .filter((row) => row.title && row.url);
}

function normalizeAnnouncement(row) {
  return {
    id: String(
      row.csvName ||
        row.seq_id ||
        `${row.symbol}-${row.an_dt}-${row.attchmntText}`,
    ),
    title: cleanText(
      `${row.symbol ? `${row.symbol}: ` : ""}${row.attchmntText || row.desc || "Corporate announcement"}`,
    ),
    publisher: "NSE corporate announcement",
    url: safeUrl(row.attchmntFile),
    publishedAt: parseNseDateTime(row.an_dt),
    thumbnail: "",
    trackedSymbol: normalizeSymbol(row.symbol),
    symbol: normalizeSymbol(row.symbol),
    relatedSymbols: [normalizeSymbol(row.symbol)].filter(Boolean),
    source: "NSE",
  };
}

function isRelevantNews(row, trackedSymbol, quote) {
  const symbol = normalizeSymbol(trackedSymbol);
  if (
    (row.relatedTickers || []).some(
      (ticker) => normalizeSymbol(ticker) === symbol,
    )
  )
    return true;
  const title = cleanText(row.title).toUpperCase();
  if (title.includes(symbol)) return true;
  const companyWords = cleanText(quote.shortname || quote.longname)
    .toUpperCase()
    .split(/\W+/)
    .filter((word) => word.length >= 4 && !["LIMITED", "INDIA"].includes(word));
  return companyWords.slice(0, 2).some((word) => title.includes(word));
}

async function cachedJson(key, url, options = {}) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.storedAt < cacheMs) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: browserHeaders,
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      cache.set(key, { data, storedAt: Date.now() });
      return data;
    } finally {
      clearTimeout(timer);
    }
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

async function cachedText(key, url) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.storedAt < cacheMs) return cached.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = fetchWithTimeout(url, { headers: browserHeaders }).then(
    async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.text();
      cache.set(key, { data, storedAt: Date.now() });
      return data;
    },
  );
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function capture(name, promise, fallback) {
  try {
    return {
      name,
      data: await promise,
      status: { available: true, error: "" },
    };
  } catch (error) {
    return {
      name,
      data: fallback,
      status: { available: false, error: readableSourceError(error) },
    };
  }
}

function normalizeInstitutionalFlow(row) {
  return {
    category: cleanText(row.category),
    date: cleanText(row.date),
    buyValue: number(row.buyValue),
    sellValue: number(row.sellValue),
    netValue: number(row.netValue),
    unit: "INR crore",
  };
}

function normalizeEvent(row) {
  return {
    id: `${row.symbol || row.company}-${row.date}-${row.purpose}`,
    symbol: normalizeSymbol(row.symbol),
    company: cleanText(row.company),
    date: cleanText(row.date),
    purpose: cleanText(row.purpose),
    description: cleanText(row.bm_desc || row.description),
    source: "NSE",
  };
}

function normalizeAction(row) {
  return {
    id: `${row.symbol || row.comp}-${row.exDate}-${row.subject}`,
    symbol: normalizeSymbol(row.symbol),
    company: cleanText(row.comp || row.company),
    exDate: cleanText(row.exDate),
    recordDate: cleanText(row.recDate),
    subject: cleanText(row.subject),
    source: "NSE",
  };
}

function normalizeInsiderTrade(row) {
  return {
    id: String(
      row.id ||
        row.recordId ||
        `${row.symbol}-${row.date || row.acqfromDt}-${row.acqName || row.personName}`,
    ),
    sourceRecordId: String(row.did || row.id || row.recordId || ""),
    symbol: normalizeSymbol(row.symbol),
    company: cleanText(row.company || row.compName),
    person: cleanText(row.acqName || row.personName || row.name),
    category: cleanText(row.personCategory || row.category),
    transactionType: cleanText(
      row.tdpTransactionType || row.transactionType || row.mode,
    ),
    acquisitionMode: cleanText(row.acqMode),
    quantity: Math.abs(number(
      row.secAcq ||
        row.buyQuantity ||
        row.sellquantity ||
        row.quantity ||
        row.noOfSecurities,
    )),
    value: Math.abs(number(row.secVal || row.value)),
    date: cleanText(row.acqfromDt || row.transactionDate || row.date),
    disclosureDate: cleanText(row.date || row.intimDt),
    disclosureUrl: safeUrl(row.xbrl),
    source: "NSE",
  };
}

function normalizeBseInsiderTrade(row) {
  const code = String(row.Fld_ScripCode || "").trim();
  return {
    id: `bse-${row.Fld_ID || `${code}-${row.Fld_CreateDate}`}`,
    sourceRecordId: String(row.Fld_ID || ""),
    symbol: code ? `BSE:${code}` : "BSE",
    company: cleanText(row.Companyname).replace(/-\$$/, "").trim(),
    person: cleanText(row.Fld_PromoterName),
    category: cleanText(row.Fld_PersonCatgName),
    transactionType: normalizeTradeType(row.Fld_TransactionType),
    acquisitionMode: cleanText(row.ModeOfAquisation),
    quantity: Math.abs(number(row.Fld_SecurityNo)),
    value: Math.abs(number(row.Fld_SecurityValue)),
    date: formatBseInsiderDate(row.Fld_FromDate || row.Fld_LetterDate),
    disclosureDate: formatBseInsiderDate(
      row.Fld_LetterDate || row.Fld_StampDate,
    ),
    disclosureUrl: safeUrl(
      row.xbrlurl ? `https://www.bseindia.com${row.xbrlurl}` : "",
    ),
    source: "BSE",
  };
}

function normalizeTradeType(value) {
  const type = cleanText(value);
  if (/acquisition|purchase|\bbuy\b/i.test(type)) return "Buy";
  if (/disposal|sale|\bsell\b/i.test(type)) return "Sell";
  return type;
}

function formatBseInsiderDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return cleanText(value);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][Number(match[2]) - 1];
  return `${match[3]}-${month}-${match[1]}`;
}

function hasInvalidInsiderActivityDate(row) {
  const activityDate = insiderDate(row.date);
  const disclosureDate = insiderDate(row.disclosureDate);
  const currentDate = new Date().toISOString().slice(0, 10);
  return (
    !activityDate ||
    activityDate > currentDate ||
    Boolean(disclosureDate && activityDate > disclosureDate)
  );
}

function mergeInsiderTrades(rows) {
  const merged = new Map();
  rows.forEach((row) => {
    const key = [
      normalizeCompanyName(row.company),
      normalizeCompanyName(row.person),
      insiderDate(row.date),
      normalizeTradeType(row.transactionType),
      number(row.quantity),
    ].join("|");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      return;
    }
    merged.set(key, {
      ...existing,
      symbol: existing.source === "NSE" ? existing.symbol : row.symbol,
      value: existing.value || row.value,
      disclosureUrl: existing.disclosureUrl || row.disclosureUrl,
      source: [
        ...new Set(`${existing.source} / ${row.source}`.split(" / ")),
      ].join(" / "),
    });
  });
  return [...merged.values()];
}

function normalizeCompanyName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(limited|ltd|private|pvt|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function companyNamesMatch(left, right) {
  return Boolean(
    left &&
    right &&
    (left === right || left.includes(right) || right.includes(left)),
  );
}

function buildPromoterHoldings(rows, symbols) {
  const grouped = filterBySymbols(rows, symbols).reduce((map, row) => {
    const symbol = normalizeSymbol(row.symbol);
    const values = map.get(symbol) || [];
    values.push(row);
    map.set(symbol, values);
    return map;
  }, new Map());
  return [...grouped.entries()]
    .map(([symbol, values]) => {
      values.sort(
        (left, right) => parseNseDate(right.date) - parseNseDate(left.date),
      );
      const latest = values[0];
      const previous = values.find(
        (row) => cleanText(row.date) !== cleanText(latest.date),
      );
      const promoterPercent = number(latest.pr_and_prgrp);
      return {
        symbol,
        company: cleanText(latest.name),
        period: cleanText(latest.date),
        promoterPercent,
        publicPercent: number(latest.public_val),
        changePercent: previous
          ? promoterPercent - number(previous.pr_and_prgrp)
          : null,
        source: "NSE shareholding disclosure",
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.changePercent || 0) - Math.abs(left.changePercent || 0),
    );
}

function filterBySymbols(rows, symbols) {
  const allowed = new Set(symbols);
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    allowed.has(normalizeSymbol(row.symbol)),
  );
}

function isEarningsEvent(row) {
  return /financial results|quarterly results|annual results|earnings/i.test(
    `${row.purpose} ${row.description}`,
  );
}

function isDividendAction(row) {
  return /dividend/i.test(row.subject || "");
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\.(NS|BO)$/i, "");
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function number(value) {
  const parsed = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNseDate(value) {
  const match = String(value || "").match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i);
  if (!match) return 0;
  const month = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ].indexOf(match[2].toUpperCase());
  return month < 0 ? 0 : Date.UTC(Number(match[3]), month, Number(match[1]));
}

function parseNseDateTime(value) {
  const match = String(value || "").match(
    /^(\d{1,2})-([A-Z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/i,
  );
  if (!match) return null;
  const month = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ].indexOf(match[2].toUpperCase());
  return month < 0
    ? null
    : new Date(
        Date.UTC(
          Number(match[3]),
          month,
          Number(match[1]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        ),
      ).toISOString();
}

function readXmlTag(xml, tag) {
  return (
    xml.match(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
    )?.[1] || ""
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function validIsoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inferTrackedSymbol(title) {
  return normalizeSymbol(String(title).split(/[:\s-]/)[0]);
}

function newsKey(row) {
  return cleanText(row.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .slice(0, 120);
}

function sortNews(rows) {
  return [...rows].sort((left, right) =>
    String(right.publishedAt || "").localeCompare(
      String(left.publishedAt || ""),
    ),
  );
}

function dedupe(rows, key) {
  const seen = new Set();
  return rows.filter((row) => {
    const value = key(row);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function readableSourceError(error) {
  if (error?.name === "AbortError") return "Source timed out";
  return `Source unavailable: ${cleanText(error?.message) || "unknown error"}`;
}

export const marketIntelligenceTestUtils = {
  buildPromoterHoldings,
  filterBySymbols,
  isDividendAction,
  isEarningsEvent,
  normalizeInstitutionalFlow,
  normalizeInsiderTrade,
  normalizeBseInsiderTrade,
  mergeInsiderTrades,
  bseDateRanges,
  hasInvalidInsiderActivityDate,
  insiderDate,
  matchesInsiderSearch,
  matchesInsiderSearchExact,
  matchesInsiderPrimarySearch,
};
