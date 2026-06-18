import { pool } from "../config/database.js";
import { publishPlannerEvent } from "../services/realtimeService.js";
import { issueAuthTokens, verifyRefreshToken } from "../services/authService.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

const publicUserColumns = `
  id::text,
  name,
  name as username,
  is_admin as "isAdmin",
  true as "requiresPassword"
`;

export async function getUsers(_request, response, next) {
  try {
    const result = await pool.query(`
      select ${publicUserColumns}
      from daily_user
      order by name asc
    `);
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
}

export async function createUser(request, response, next) {
  const username = readUsername(request.body);
  const password = String(request.body?.password || "");

  try {
    const user = await insertUser(username, password, response);
    if (!user) return;

    publishPlannerEvent("user-created", user);
    response.status(201).json(toAuthResponse(user, user));
  } catch (error) {
    handleCreateUserError(error, response, next);
  }
}

export async function createProfile(request, response, next) {
  const username = readUsername(request.body);
  const password = String(request.body?.password || "");

  try {
    if (!request.auth?.actorIsAdmin) {
      response.status(403).json({ error: "Only an admin can create profiles" });
      return;
    }

    const user = await insertUser(username, password, response);
    if (!user) return;

    publishPlannerEvent("user-created", user);
    response.status(201).json(user);
  } catch (error) {
    handleCreateUserError(error, response, next);
  }
}

async function insertUser(username, password, response) {
  if (!username || !password) {
    response.status(400).json({ error: "Username and password are required" });
    return null;
  }

  if (username.length > 80 || password.length > 128) {
    response.status(400).json({ error: "Username or password is too long" });
    return null;
  }

  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    `
      insert into daily_user (name, password_hash, is_admin)
      values ($1, $2, not exists(select 1 from daily_user))
      returning ${publicUserColumns}
    `,
    [username, passwordHash],
  );

  return result.rows[0];
}

function handleCreateUserError(error, response, next) {
  if (error.code === "23505") {
    response
      .status(409)
      .json({ error: "A user with this username already exists" });
    return;
  }
  next(error);
}

export async function loginUser(request, response, next) {
  const userId = normalizeBigintId(request.body?.userId);
  const username = readUsername(request.body);
  const password = String(request.body?.password || "");

  if (!userId && !username) {
    response.status(400).json({ error: "Username is required" });
    return;
  }

  if (!password) {
    response.status(400).json({ error: "Password is required" });
    return;
  }

  try {
    const result = await pool.query(
      `select ${publicUserColumns}, password_hash from daily_user where ${userId ? "id = $1" : "lower(name) = lower($1)"}`,
      [userId || username],
    );

    if (!result.rowCount) {
      response.status(404).json({ error: "Planner user not found" });
      return;
    }

    const user = result.rows[0];
    if (!(await verifyPassword(password, user.password_hash))) {
      response.status(401).json({ error: "Incorrect password" });
      return;
    }

    response.json(toAuthResponse(user, user));
  } catch (error) {
    next(error);
  }
}

export async function switchUser(request, response, next) {
  const userId = normalizeBigintId(request.body?.userId);

  if (!userId) {
    response.status(400).json({ error: "Select a valid planner profile" });
    return;
  }

  try {
    if (!request.auth?.actorIsAdmin) {
      response.status(403).json({ error: "Only an admin can switch profiles" });
      return;
    }

    const [result, actorResult] = await Promise.all([
      pool.query(`select ${publicUserColumns} from daily_user where id = $1`, [userId]),
      pool.query(`select ${publicUserColumns} from daily_user where id = $1 and is_admin is true`, [request.auth.actorId]),
    ]);

    if (!result.rowCount) {
      response.status(404).json({ error: "Planner user not found" });
      return;
    }

    if (!actorResult.rowCount) {
      response.status(401).json({ error: "Admin account is no longer available" });
      return;
    }

    response.json(toAuthResponse(result.rows[0], actorResult.rows[0]));
  } catch (error) {
    next(error);
  }
}

export async function getCurrentUser(request, response, next) {
  try {
    const result = await pool.query(`select ${publicUserColumns} from daily_user where id = $1`, [request.dailyUserId]);
    if (!result.rowCount) {
      response.status(401).json({ error: "Planner user not found" });
      return;
    }
    response.json(toPublicUser(result.rows[0]));
  } catch (error) {
    next(error);
  }
}

export async function refreshSession(request, response, next) {
  try {
    const refreshToken = readBearerToken(request) || String(request.body?.refreshToken || "");
    const payload = verifyRefreshToken(refreshToken);
    const [userResult, actorResult] = await Promise.all([
      pool.query(`select ${publicUserColumns} from daily_user where id = $1`, [payload.sub]),
      pool.query(`select ${publicUserColumns} from daily_user where id = $1`, [payload.actorId || payload.sub]),
    ]);

    if (!userResult.rowCount || !actorResult.rowCount || Boolean(actorResult.rows[0].isAdmin) !== (payload.actorIsAdmin === true)) {
      response.status(401).json({ error: "Session is no longer valid" });
      return;
    }

    response.json(toAuthResponse(userResult.rows[0], actorResult.rows[0]));
  } catch {
    response.status(401).json({ error: "Refresh token is invalid or expired" });
  }
}

function toAuthResponse(user, actor) {
  return {
    user: toPublicUser(user),
    ...issueAuthTokens(user, actor),
  };
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username || user.name,
    isAdmin: user.isAdmin,
    requiresPassword: true,
  };
}

function readUsername(body) {
  return String(body?.username || body?.name || "").trim();
}

function readBearerToken(request) {
  const authorization = String(request.get("Authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function normalizeBigintId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}
