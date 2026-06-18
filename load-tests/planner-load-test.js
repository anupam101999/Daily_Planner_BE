import { performance } from "node:perf_hooks";

const baseUrl = String(process.env.LOAD_TEST_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const frontendUrl = String(process.env.LOAD_TEST_FRONTEND_URL || "https://mytaskmate.vercel.app/");
const scenario = String(process.env.LOAD_TEST_SCENARIO || "read").toLowerCase();
const stages = parsePositiveNumbers(process.env.LOAD_TEST_CONCURRENCY || "1,2,5,10,25,50");
const durationSeconds = positiveNumber(process.env.LOAD_TEST_DURATION_SECONDS, 15);
const thinkTimeMs = nonNegativeNumber(process.env.LOAD_TEST_THINK_TIME_MS, 750);
const timeoutMs = positiveNumber(process.env.LOAD_TEST_TIMEOUT_MS, 10000);
const allowWrites = process.env.LOAD_TEST_ALLOW_WRITES === "true";
const stopErrorRate = nonNegativeNumber(process.env.LOAD_TEST_STOP_ERROR_RATE, 0.05);
const configuredUsers = readConfiguredUsers();

if (!["static", "read", "workflow", "pomodoro"].includes(scenario)) {
  fail("LOAD_TEST_SCENARIO must be static, read, workflow, or pomodoro");
}

if (["workflow", "pomodoro"].includes(scenario) && !allowWrites) {
  fail("Write scenarios require LOAD_TEST_ALLOW_WRITES=true and dedicated disposable test users");
}

const authSessions = scenario === "static" ? [] : await loginConfiguredUsers();
if (scenario === "pomodoro" && authSessions.length < Math.max(...stages)) {
  fail("Pomodoro testing requires one LOAD_TEST_USERS_JSON account per concurrent user");
}

console.log("\nMy Task Mate load test");
console.log(`Scenario: ${scenario}`);
console.log(`Target: ${scenario === "static" ? frontendUrl : baseUrl}`);
console.log(`Stages: ${stages.join(", ")} concurrent users for ${durationSeconds}s each`);
console.log(`Think time: ${thinkTimeMs}ms\n`);

const summaries = [];
for (const concurrency of stages) {
  const summary = await runStage(concurrency);
  summaries.push(summary);
  if (summary.errorRate >= stopErrorRate && stopErrorRate > 0) {
    console.log(
      `Stopping after ${concurrency} users because errors reached ${(summary.errorRate * 100).toFixed(2)}% `
      + `(limit ${(stopErrorRate * 100).toFixed(2)}%).\n`,
    );
    break;
  }
}

printComparison(summaries);
process.exitCode = summaries.some((summary) => summary.errorRate > 0.01) ? 1 : 0;

async function loginConfiguredUsers() {
  if (!configuredUsers.length) fail("Set LOAD_TEST_USERS_JSON or LOAD_TEST_USERNAME and LOAD_TEST_PASSWORD");
  return Promise.all(configuredUsers.map(async ({ username, password }) => {
    const response = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = await response.json().catch(() => null);
    if (!response.ok) fail(`Unable to authenticate ${username}: HTTP ${response.status}`);
    return session;
  }));
}

async function runStage(concurrency) {
  const metrics = createMetrics();
  const deadline = performance.now() + durationSeconds * 1000;
  const startedAt = performance.now();

  console.log(`Running ${concurrency} concurrent users...`);
  await Promise.all(Array.from({ length: concurrency }, (_, index) => virtualUser(index, deadline, metrics)));

  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const summary = summarize(concurrency, elapsedSeconds, metrics);
  printStage(summary);
  return summary;
}

async function virtualUser(index, deadline, metrics) {
  const authSession = authSessions.length ? authSessions[index % authSessions.length] : null;

  while (performance.now() < deadline) {
    const iterationStarted = performance.now();
    try {
      if (scenario === "static") await staticPageJourney(metrics);
      if (scenario === "read") await dashboardReadJourney(authSession, metrics);
      if (scenario === "workflow") await taskWorkflow(authSession, index, metrics);
      if (scenario === "pomodoro") await pomodoroWorkflow(authSession, index, metrics);
      metrics.iterations += 1;
    } catch (error) {
      metrics.iterationErrors += 1;
      metrics.errorMessages.set(error.message, (metrics.errorMessages.get(error.message) || 0) + 1);
    }

    metrics.iterationDurations.push(performance.now() - iterationStarted);
    if (thinkTimeMs) await sleep(thinkTimeMs);
  }
}

async function staticPageJourney(metrics) {
  await measuredRequest("landing_page", frontendUrl, {}, metrics);
}

async function dashboardReadJourney(authSession, metrics) {
  await Promise.all([
    measuredRequest("get_tasks", `${baseUrl}/api/tasks`, userOptions(authSession), metrics),
    measuredRequest("get_pomodoro", `${baseUrl}/api/pomodoro`, userOptions(authSession), metrics),
  ]);
}

async function taskWorkflow(authSession, workerIndex, metrics) {
  const marker = `load-test-${process.pid}-${workerIndex}-${Date.now()}`;
  let task;
  try {
    task = await measuredRequest("create_task", `${baseUrl}/api/tasks`, userOptions(authSession, {
      method: "POST",
      body: JSON.stringify({
        subject: marker,
        parentSubject: "Load Test",
        date: new Date().toISOString().slice(0, 10),
        estimatedMinutes: 25,
        sortTime: "99:99",
        priority: "low",
        notes: "Disposable load-test task",
        status: "planned",
      }),
    }), metrics);

    await measuredRequest("complete_task", `${baseUrl}/api/tasks/${task.id}`, userOptions(authSession, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", actualMinutes: 25 }),
    }), metrics);
  } finally {
    if (task?.id) {
      await measuredRequest("delete_task", `${baseUrl}/api/tasks/${task.id}`, userOptions(authSession, {
        method: "DELETE",
      }), metrics).catch(() => {});
    }
  }
}

async function pomodoroWorkflow(authSession, workerIndex, metrics) {
  const marker = `pomo-load-test-${process.pid}-${workerIndex}-${Date.now()}`;
  let task;
  let session;
  try {
    task = await measuredRequest("create_task", `${baseUrl}/api/tasks`, userOptions(authSession, {
      method: "POST",
      body: JSON.stringify({
        subject: marker,
        parentSubject: "Load Test",
        date: new Date().toISOString().slice(0, 10),
        estimatedMinutes: 25,
        sortTime: "99:99",
        priority: "low",
        notes: "Disposable Pomodoro load-test task",
        status: "planned",
      }),
    }), metrics);

    session = await measuredRequest("start_pomodoro", `${baseUrl}/api/pomodoro/start`, userOptions(authSession, {
      method: "POST",
      body: JSON.stringify({ taskId: task.id, mode: "focus", durationMinutes: 1 }),
    }), metrics);

    await measuredRequest("complete_pomodoro", `${baseUrl}/api/pomodoro/${session.id}/complete`, userOptions(authSession, {
      method: "PATCH",
    }), metrics);
  } finally {
    if (session?.id) {
      await measuredRequest("cancel_pomodoro_cleanup", `${baseUrl}/api/pomodoro/${session.id}/cancel`, userOptions(authSession, {
        method: "PATCH",
      }), metrics).catch(() => {});
    }
    if (task?.id) {
      await measuredRequest("delete_task", `${baseUrl}/api/tasks/${task.id}`, userOptions(authSession, {
        method: "DELETE",
      }), metrics).catch(() => {});
    }
  }
}

async function measuredRequest(name, url, options, metrics) {
  const startedAt = performance.now();
  let response;
  try {
    const { authSession, ...requestOptions } = options;
    if (authSession) {
      await ensureAccessToken(authSession);
      requestOptions.headers = { ...requestOptions.headers, Authorization: `Bearer ${authSession.accessToken}` };
    }
    response = await fetch(url, { ...requestOptions, signal: AbortSignal.timeout(timeoutMs) });
    const duration = performance.now() - startedAt;
    recordRequest(metrics, name, duration, response.ok);
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}${body?.error ? ` - ${body.error}` : ""}`);
    return body;
  } catch (error) {
    if (!response) recordRequest(metrics, name, performance.now() - startedAt, false);
    throw error;
  }
}

function userOptions(authSession, options = {}) {
  return {
    ...options,
    authSession,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  };
}

async function ensureAccessToken(session) {
  const payload = JSON.parse(Buffer.from(session.accessToken.split(".")[1], "base64url").toString("utf8"));
  if (payload.exp * 1000 > Date.now() + 5000) return;
  if (!session.refreshPromise) {
    session.refreshPromise = fetch(`${baseUrl}/api/users/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.refreshToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (response) => {
      const nextSession = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`token_refresh: HTTP ${response.status}`);
      Object.assign(session, nextSession);
    }).finally(() => {
      session.refreshPromise = null;
    });
  }
  await session.refreshPromise;
}

function readConfiguredUsers() {
  if (process.env.LOAD_TEST_USERS_JSON) {
    try {
      const users = JSON.parse(process.env.LOAD_TEST_USERS_JSON);
      if (Array.isArray(users)) return users.filter((user) => user?.username && user?.password);
    } catch {
      fail("LOAD_TEST_USERS_JSON must be a JSON array of username/password objects");
    }
  }
  const username = String(process.env.LOAD_TEST_USERNAME || "");
  const password = String(process.env.LOAD_TEST_PASSWORD || "");
  return username && password ? [{ username, password }] : [];
}

function createMetrics() {
  return {
    requests: 0,
    requestErrors: 0,
    iterations: 0,
    iterationErrors: 0,
    requestDurations: [],
    iterationDurations: [],
    endpoints: new Map(),
    errorMessages: new Map(),
  };
}

function recordRequest(metrics, name, duration, ok) {
  metrics.requests += 1;
  metrics.requestDurations.push(duration);
  if (!ok) metrics.requestErrors += 1;
  const endpoint = metrics.endpoints.get(name) || { count: 0, errors: 0, durations: [] };
  endpoint.count += 1;
  endpoint.durations.push(duration);
  if (!ok) endpoint.errors += 1;
  metrics.endpoints.set(name, endpoint);
}

function summarize(concurrency, elapsedSeconds, metrics) {
  return {
    concurrency,
    elapsedSeconds,
    requests: metrics.requests,
    requestRate: metrics.requests / elapsedSeconds,
    iterations: metrics.iterations,
    iterationRate: metrics.iterations / elapsedSeconds,
    errorRate: metrics.requests ? metrics.requestErrors / metrics.requests : 1,
    iterationErrorRate: (metrics.iterations + metrics.iterationErrors)
      ? metrics.iterationErrors / (metrics.iterations + metrics.iterationErrors)
      : 1,
    latency: latencySummary(metrics.requestDurations),
    iterationLatency: latencySummary(metrics.iterationDurations),
    endpoints: [...metrics.endpoints.entries()].map(([name, value]) => ({
      name,
      count: value.count,
      errorRate: value.count ? value.errors / value.count : 0,
      latency: latencySummary(value.durations),
    })),
    errors: [...metrics.errorMessages.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
  };
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    average: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) || 0,
  };
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function printStage(summary) {
  console.log(
    `  ${summary.requestRate.toFixed(1)} req/s | p50 ${formatMs(summary.latency.p50)} | `
    + `p95 ${formatMs(summary.latency.p95)} | p99 ${formatMs(summary.latency.p99)} | `
    + `errors ${(summary.errorRate * 100).toFixed(2)}%`,
  );
  for (const endpoint of summary.endpoints) {
    console.log(
      `    ${endpoint.name.padEnd(25)} ${String(endpoint.count).padStart(6)} requests | `
      + `p95 ${formatMs(endpoint.latency.p95).padStart(9)} | errors ${(endpoint.errorRate * 100).toFixed(2)}%`,
    );
  }
  for (const [message, count] of summary.errors) console.log(`    error x${count}: ${message}`);
  console.log("");
}

function printComparison(summaries) {
  console.log("Concurrency summary");
  console.log("users | req/s | p95 latency | p99 latency | errors");
  for (const summary of summaries) {
    console.log(
      `${String(summary.concurrency).padStart(5)} | ${summary.requestRate.toFixed(1).padStart(5)} | `
      + `${formatMs(summary.latency.p95).padStart(11)} | ${formatMs(summary.latency.p99).padStart(11)} | `
      + `${(summary.errorRate * 100).toFixed(2).padStart(6)}%`,
    );
  }
  console.log("\nTreat capacity as the highest stage that stays below your latency target with less than 1% errors.");
}

function parsePositiveNumbers(value) {
  const numbers = String(value).split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
  if (!numbers.length) fail("LOAD_TEST_CONCURRENCY must contain positive integers");
  return numbers;
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) fail("Load-test durations and timeouts must be positive numbers");
  return number;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) fail("LOAD_TEST_THINK_TIME_MS must be zero or positive");
  return number;
}

function formatMs(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  console.error(`Load test configuration error: ${message}`);
  process.exit(1);
}
