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
