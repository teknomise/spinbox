import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { IMAGES, RuleError, type ContainerService } from "./containers.js";
import { RailwayError } from "./railway.js";

export function createApp(containers: ContainerService, password: string, page: string) {
  const app = new Hono();

  app.use(secureHeaders());
  app.get("/health", (c) => c.json({ ok: true }));

  // The server holds a Railway token, so every other route needs the password.
  app.use("*", basicAuth({ username: "admin", password }));
  // Behind Railway's proxy the app sees http while the browser's Origin is https,
  // so compare hosts. A cross-site page cannot forge either header.
  app.use("/api/*", csrf({
    origin: (origin, c) => {
      try {
        return new URL(origin).host === c.req.header("host");
      } catch {
        return false;
      }
    },
  }));

  app.onError((error, c) => {
    if (error instanceof RuleError) return c.json({ error: error.message }, error.status);
    if (error instanceof RailwayError) {
      console.error("railway error:", error.message);
      return c.json({ error: "Railway request failed, try again" }, 502);
    }
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (error instanceof HTTPException) return error.getResponse(); // 401, 403 from middleware
    console.error("unexpected error:", error);
    return c.json({ error: "Something went wrong" }, 500);
  });

  app.get("/", (c) => c.html(page));
  app.get("/api/images", (c) => c.json(Object.keys(IMAGES)));
  app.get("/api/containers", async (c) => c.json(await containers.list()));

  app.post("/api/containers", async (c) => {
    const body = await c.req.json<{ image?: unknown }>();
    return c.json(await containers.spinUp(body?.image), 201);
  });

  app.delete("/api/containers/:id", async (c) => {
    await containers.spinDown(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
