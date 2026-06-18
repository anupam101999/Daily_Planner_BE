const clients = new Map();

export function subscribeToPlannerEvents(request, response) {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write("event: connected\ndata: {}\n\n");

  clients.set(response, {
    userId: request.dailyUserId,
    actorIsAdmin: request.auth?.actorIsAdmin === true,
  });

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 25000);

  request.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(response);
  });
}

export function publishPlannerEvent(type, data) {
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [client, auth] of clients) {
    const isUserEvent = data?.userId != null;
    const canReceive = isUserEvent
      ? String(data.userId) === auth.userId
      : type === "user-created" && auth.actorIsAdmin;
    if (canReceive) client.write(message);
  }
}
