import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createContainerService } from "./containers.js";
import { createRailwayClient } from "./railway.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const password = required("APP_PASSWORD");
if (password.length < 12) throw new Error("APP_PASSWORD must be at least 12 characters");

const containers = createContainerService(createRailwayClient(required("RAILWAY_API_TOKEN")), {
  // TARGET_* lets the app manage a different project from the one it runs in.
  projectId: process.env.TARGET_PROJECT_ID ?? required("RAILWAY_PROJECT_ID"),
  environmentId: process.env.TARGET_ENVIRONMENT_ID ?? required("RAILWAY_ENVIRONMENT_ID"),
  maxContainers: Number(process.env.MAX_CONTAINERS ?? 3),
});

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp(containers, password, page).fetch, port }, () => {
  console.log(`spinbox listening on ${port}`);
});
