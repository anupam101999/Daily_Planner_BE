export function requireAdmin(request, response, next) {
  if (!request.auth?.actorIsAdmin) {
    response.status(403).json({ error: "Admin access is required" });
    return;
  }
  next();
}
