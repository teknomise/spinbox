import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createContainerService, IMAGES } from "../src/containers.js";
import { createRailwayClient, RailwayError, type RailwayClient, type ServiceSummary } from "../src/railway.js";

const PASSWORD = "correct-horse-battery";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };

function fakeRailway(seed: ServiceSummary[] = []) {
  const services = [...seed];
  const client: RailwayClient = {
    listServices: vi.fn(async () => [...services]),
    getInstance: vi.fn(async () => ({ image: "nginx:1.27-alpine", deploymentId: "d1", status: "SUCCESS" as const })),
    createService: vi.fn(async ({ name }) => {
      const service = { id: `svc-${services.length + 1}`, name };
      services.push(service);
      return service;
    }),
    deleteService: vi.fn(async (id) => {
      services.splice(services.findIndex((s) => s.id === id), 1);
    }),
  };
  return client;
}

function build(railway: RailwayClient, maxContainers = 2) {
  const containers = createContainerService(railway, { projectId: "p", environmentId: "e", maxContainers });
  return createApp(containers, PASSWORD, "<h1>page</h1>");
}

const post = (body: string) => ({
  method: "POST",
  headers: { ...AUTH, "Content-Type": "application/json" },
  body,
});

describe("access", () => {
  let railway: RailwayClient;
  beforeEach(() => { railway = fakeRailway(); });

  it("health needs no password", async () => {
    expect((await build(railway).request("/health")).status).toBe(200);
  });

  it("page and API refuse a missing or wrong password", async () => {
    const app = build(railway);
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/api/containers")).status).toBe(401);
    const wrong = { Authorization: `Basic ${Buffer.from("admin:nope").toString("base64")}` };
    expect((await app.request("/api/containers", { headers: wrong })).status).toBe(401);
    expect(railway.listServices).not.toHaveBeenCalled();
  });

  it("refuses a cross-site form post", async () => {
    const res = await build(railway).request("/api/containers", {
      method: "POST",
      headers: { ...AUTH, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "image=nginx",
    });
    expect(res.status).toBe(403);
    expect(railway.createService).not.toHaveBeenCalled();
  });
});

describe("spin up", () => {
  it("creates a prefixed service from the allowed image", async () => {
    const railway = fakeRailway();
    const res = await build(railway).request("/api/containers", post('{"image":"nginx"}'));
    expect(res.status).toBe(201);
    expect(railway.createService).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p", environmentId: "e", image: IMAGES.nginx, name: expect.stringMatching(/^spinbox-nginx-[0-9a-f]{6}$/) }),
    );
  });

  it.each(['{"image":"evil/miner:latest"}', '{"image":"__proto__"}', '{"image":"constructor"}', '{"image":1}', "{}", "null"])(
    "rejects image body %s",
    async (body) => {
      const railway = fakeRailway();
      const res = await build(railway).request("/api/containers", post(body));
      expect(res.status).toBe(400);
      expect(railway.createService).not.toHaveBeenCalled();
    },
  );

  it("answers 400 to broken JSON", async () => {
    expect((await build(fakeRailway()).request("/api/containers", post("{oops"))).status).toBe(400);
  });

  it("stops at the limit, not counting services it does not own", async () => {
    const railway = fakeRailway([
      { id: "a", name: "spinbox-nginx-aaaaaa" },
      { id: "b", name: "spinbox-redis-bbbbbb" },
      { id: "c", name: "production-db" },
    ]);
    const res = await build(railway).request("/api/containers", post('{"image":"nginx"}'));
    expect(res.status).toBe(409);
    expect(railway.createService).not.toHaveBeenCalled();

    const roomy = fakeRailway([{ id: "c", name: "production-db" }]);
    expect((await build(roomy).request("/api/containers", post('{"image":"nginx"}'))).status).toBe(201);
  });
});

describe("spin down and list", () => {
  it("deletes its own service", async () => {
    const railway = fakeRailway([{ id: "a", name: "spinbox-nginx-aaaaaa" }]);
    const res = await build(railway).request("/api/containers/a", { method: "DELETE", headers: { ...AUTH, Origin: "http://localhost" } });
    expect(res.status).toBe(204);
    expect(railway.deleteService).toHaveBeenCalledWith("a", "e");
  });

  it("refuses to delete a service it did not create", async () => {
    const railway = fakeRailway([{ id: "c", name: "production-db" }]);
    const res = await build(railway).request("/api/containers/c", { method: "DELETE", headers: { ...AUTH, Origin: "http://localhost" } });
    expect(res.status).toBe(404);
    expect(railway.deleteService).not.toHaveBeenCalled();
  });

  it("lists only its own services with status", async () => {
    const railway = fakeRailway([{ id: "a", name: "spinbox-nginx-aaaaaa" }, { id: "c", name: "production-db" }]);
    const res = await build(railway).request("/api/containers", { headers: AUTH });
    expect(await res.json()).toEqual([{ id: "a", name: "spinbox-nginx-aaaaaa", image: "nginx:1.27-alpine", status: "SUCCESS" }]);
  });

  it("hides Railway error details from the browser", async () => {
    const railway = fakeRailway();
    railway.listServices = vi.fn(async () => { throw new RailwayError("secret internal detail", 502); });
    const res = await build(railway).request("/api/containers", { headers: AUTH });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret internal detail");
  });
});

describe("railway client", () => {
  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("sends the token and unwraps services", async () => {
    const fetchMock = reply({ data: { project: { services: { edges: [{ node: { id: "1", name: "x" } }] } } } });
    expect(await createRailwayClient("tok", fetchMock).listServices("p")).toEqual([{ id: "1", name: "x" }]);
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).variables).toEqual({ id: "p" });
  });

  it("turns GraphQL errors, HTTP errors and network failures into RailwayError", async () => {
    await expect(createRailwayClient("t", reply({ errors: [{ message: "Not Authorized" }] })).listServices("p")).rejects.toThrow("Not Authorized");
    await expect(createRailwayClient("t", reply({}, 500)).listServices("p")).rejects.toBeInstanceOf(RailwayError);
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    await expect(createRailwayClient("t", down).listServices("p")).rejects.toBeInstanceOf(RailwayError);
  });
});
