import { timingSafeEqual } from "node:crypto";

export function getApiKeyAuth(apiKey) {
  const candidate = String(apiKey || "").trim();
  if (!candidate) return null;

  return configuredApiKeys().find(({ key }) => safeEqual(candidate, key)) || null;
}

export function hasApiKeyConfiguration() {
  return configuredApiKeys().length > 0;
}

function configuredApiKeys() {
  return String(process.env.API_KEYS || process.env.API_KEY || "")
    .split(",")
    .map(parseApiKeyConfig)
    .filter(Boolean);
}

function parseApiKeyConfig(config) {
  const [key, userId, role = "admin"] = String(config || "").split(":").map((part) => part.trim());
  if (!key || !/^\d+$/.test(userId)) return null;
  return {
    key,
    userId,
    actorId: userId,
    actorIsAdmin: role.toLowerCase() !== "user",
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
