import { verifyAccessToken } from "../services/authService.js";
import { getApiKeyAuth, hasApiKeyConfiguration } from "../services/apiKeyService.js";

export function requireUser(request, response, next) {
  try {
    const apiKey = String(request.get("x-api-key") || "");
    if (apiKey) {
      if (!hasApiKeyConfiguration()) {
        response.status(500).json({ error: "API key is not configured correctly" });
        return;
      }

      const apiKeyAuth = getApiKeyAuth(apiKey);
      if (!apiKeyAuth) {
        response.status(401).json({ error: "API key is invalid" });
        return;
      }

      request.dailyUserId = apiKeyAuth.userId;
      request.auth = {
        actorId: apiKeyAuth.actorId,
        actorIsAdmin: apiKeyAuth.actorIsAdmin,
        apiKey: true,
      };
      next();
      return;
    }

    const authorization = String(request.get("Authorization") || "");
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      response.status(401).json({ error: "Authentication token is required" });
      return;
    }

    const payload = verifyAccessToken(match[1]);
    request.dailyUserId = String(payload.sub);
    request.auth = {
      actorId: String(payload.actorId || payload.sub),
      actorIsAdmin: payload.actorIsAdmin === true,
    };
    next();
  } catch {
    response.status(401).json({ error: "Authentication token is invalid or expired" });
  }
}
