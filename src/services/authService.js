import jwt from "jsonwebtoken";

const accessTokenLifetime = process.env.JWT_ACCESS_TOKEN_TTL || "30m";
const refreshTokenLifetime = process.env.JWT_REFRESH_TOKEN_TTL || "7d";

function getSecret(name) {
  const secret = String(process.env[name] || "");
  if (secret.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters`);
  }
  return secret;
}

export function issueAuthTokens(user, actor = user) {
  const claims = {
    sub: String(user.id),
    actorId: String(actor.id),
    actorIsAdmin: Boolean(actor.isAdmin),
  };

  return {
    accessToken: jwt.sign({ ...claims, type: "access" }, getSecret("JWT_ACCESS_SECRET"), {
      expiresIn: accessTokenLifetime,
      issuer: "daily-planner-api",
      audience: "daily-planner-ui",
    }),
    refreshToken: jwt.sign({ ...claims, type: "refresh" }, getSecret("JWT_REFRESH_SECRET"), {
      expiresIn: refreshTokenLifetime,
      issuer: "daily-planner-api",
      audience: "daily-planner-ui",
    }),
  };
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, getSecret("JWT_ACCESS_SECRET"), tokenOptions);
  if (payload.type !== "access") throw new Error("Invalid access token");
  return payload;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, getSecret("JWT_REFRESH_SECRET"), tokenOptions);
  if (payload.type !== "refresh") throw new Error("Invalid refresh token");
  return payload;
}

const tokenOptions = {
  issuer: "daily-planner-api",
  audience: "daily-planner-ui",
};
