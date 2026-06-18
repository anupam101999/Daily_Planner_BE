# My Task Mate load testing

The Vercel frontend serves static files and is not the main database capacity limit. Test the API separately because planner reads, task writes, Pomodoro state, and authentication reach PostgreSQL.

Run tests only against infrastructure you own. Use a staging database for write scenarios.

## Read-only dashboard test

This represents signed-in users loading and refreshing tasks plus Pomodoro state.

```powershell
$env:LOAD_TEST_BASE_URL="http://localhost:4000"
$env:LOAD_TEST_USERNAME="load-test-user"
$env:LOAD_TEST_PASSWORD="replace-me"
$env:LOAD_TEST_CONCURRENCY="1,2,5,10,25,50"
$env:LOAD_TEST_DURATION_SECONDS="20"
npm run load:test
```

The runner stops after a stage reaches 5% errors so a clearly overloaded API is not hammered by every larger stage. Set `LOAD_TEST_STOP_ERROR_RATE=0` only when you intentionally want to continue through failures.

For multiple accounts, set `LOAD_TEST_USERS_JSON` to a JSON array of objects containing `username` and `password`. The runner logs in and refreshes each short-lived access token automatically.

## Public landing-page test

```powershell
$env:LOAD_TEST_SCENARIO="static"
$env:LOAD_TEST_FRONTEND_URL="https://mytaskmate.vercel.app/"
$env:LOAD_TEST_CONCURRENCY="25,50,100,200"
npm run load:test
```

## Task write workflow

This repeatedly creates, completes, and deletes disposable tasks. Never point it at the production database unless losing test data is acceptable.

```powershell
$env:LOAD_TEST_SCENARIO="workflow"
$env:LOAD_TEST_ALLOW_WRITES="true"
$env:LOAD_TEST_USERS_JSON='[{"username":"load-1","password":"replace-me"},{"username":"load-2","password":"replace-me"}]'
$env:LOAD_TEST_CONCURRENCY="5,10,20"
npm run load:test
```

## Pomodoro transaction workflow

This starts and completes Pomodoro sessions, exercising the explicit PostgreSQL transaction that updates both the session and task focus totals. Every virtual user requires a unique disposable planner user because the database permits only one active Pomodoro per user.

```powershell
$env:LOAD_TEST_SCENARIO="pomodoro"
$env:LOAD_TEST_ALLOW_WRITES="true"
$env:LOAD_TEST_USERS_JSON='[{"username":"pomo-1","password":"replace-me"},{"username":"pomo-2","password":"replace-me"},{"username":"pomo-3","password":"replace-me"}]'
$env:LOAD_TEST_CONCURRENCY="1,3,5"
npm run load:test
```

## Reading the result

Use the highest concurrency stage that meets your product target. A reasonable initial target is:

- Error rate below 1%
- Read p95 below 500 ms
- Write p95 below 1000 ms
- Throughput still rises when concurrency increases

If concurrency rises but throughput stops rising while latency increases, the system has reached a bottleneck. Compare API CPU and memory with PostgreSQL connection, CPU, lock, and slow-query metrics during the same stage.
