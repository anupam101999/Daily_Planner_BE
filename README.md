# Daily Planner Backend

Express and Postgres API for the Daily Planner UI.

## Run locally

1. Install and start PostgreSQL.
2. Create a database named `daily_planner`.
3. Copy `.env.example` to `.env` and update the database credentials.
4. Install dependencies and start the API:

```bash
npm install
npm run dev
```

The API runs on `http://localhost:4000` by default and creates the `planner_tasks` and `planner_settings` tables automatically.

You can also start it directly with `node src/config/server.js`.

Application code is organized under `src`:

```text
src/
  app.js
  config/       # Server and database configuration
  controllers/  # Request handlers and database operations
  middleware/   # Express middleware
  routes/       # API route definitions
  utils/        # Shared mapping helpers
```

Planner users are stored in `daily_user`, and tasks are scoped to the selected user. Set `is_admin = true` directly in the database when a user should be selectable without a password. Completed tasks record both estimated and actual minutes for analytics.

Verify it at `http://localhost:4000/api/health`.

Incomplete planned tasks are automatically moved to the current day at midnight IST. To run the same rollover manually for every planner user, call this public endpoint without headers or a request body:

```http
POST /api/tasks/rollover
```

Set `DAILY_TASK_ROLLOVER_ENABLED=false` to disable the automatic batch process.

Use `DB_SSL=false` for a local PostgreSQL server. For an external provider such as Supabase, provide its host or `DATABASE_URL` and set `DB_SSL=true`.


## Deploy on Render

1. Push this backend to GitHub, GitLab, or Bitbucket.
2. In Render, create a Postgres database and copy its **Internal Database URL**.
3. Create a **Web Service** connected to the backend repository.
4. Use these service settings:

```text
Language: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

If the backend is inside a repository containing multiple projects, set **Root Directory** to `Daily_Planner_BE`.

5. Remove any old `DATABASE_URL` from the web service, then add the Neon connection using the same `DB_*` variables used locally:

```text
DB_HOST=<Neon pooled host>
DB_NAME=neondb
DB_USER=<Neon database user>
DB_PASSWORD=<Neon database password>
DB_PORT=5432
DB_SSL=true
DB_POOL_MAX=5
DB_CONNECTION_TIMEOUT_MS=5000
```

Do not set `PORT`; Render provides it automatically. After deployment, verify the API at:

```text
https://<your-service-name>.onrender.com/api/health
```
