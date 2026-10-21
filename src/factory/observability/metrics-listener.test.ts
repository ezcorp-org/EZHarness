import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFactoryTempPrivateRoot } from "../../__tests__/helpers/factory-private-root";
import { FACTORY_METRIC_FAMILIES, factoryMetricRenderer } from "./metric-registry";
import { FACTORY_METRICS_CONTENT_TYPE, FACTORY_ROLE_HOLDING_SERVICES, type FactoryRoleHoldingService, loadFactoryMetricsToken, serveFactoryMetrics, serveFactoryReadyMetrics, startDeclaredFactoryMetrics, startFactoryMetricsListener, wellFormedFactoryMetricsEndpoint, type FactoryMetricsListener } from "./metrics-listener";

const TOKEN = "scrape-token-0123456789abcdefghijklmnop";

describe("the metrics listener (C11 M4)", () => {
  let listener: FactoryMetricsListener;
  let failing = false;
  beforeAll(async () => {
    listener = await startFactoryMetricsListener({
      hostname: "127.0.0.1",
      port: 0,
      scrapeToken: TOKEN,
      scrape: async () => {
        if (failing) throw new Error(`database at postgres://user:${TOKEN}@host is down`);
        return factoryMetricRenderer("gateway", { strict: true }).render([{ name: "factory_service_ready", value: 1 }]);
      },
    });
  });
  afterAll(async () => { await listener.stop(); });

  const scrape = (init: RequestInit = {}, path = "/metrics") => fetch(`${listener.url}${path}`, init);
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  test("serves the exposition to a scraper holding the token", async () => {
    const response = await scrape(bearer(TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(FACTORY_METRICS_CONTENT_TYPE);
    const body = await response.text();
    expect(body).toContain("factory_service_ready 1");
    expect(body).toContain("factory_metrics_label_refused_total 0");
  });

  test("refuses a missing, wrong, or differently sized token with no detail", async () => {
    for (const init of [{}, bearer("wrong"), bearer(`${TOKEN}x`), { headers: { authorization: TOKEN } }]) {
      const response = await scrape(init);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
  });

  test("answers only GET on /metrics", async () => {
    expect((await scrape(bearer(TOKEN), "/other")).status).toBe(404);
    expect((await scrape({ ...bearer(TOKEN), method: "POST" })).status).toBe(405);
  });

  test("a failed collection is 503 and never echoes its cause", async () => {
    failing = true;
    const response = await scrape(bearer(TOKEN));
    failing = false;
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("postgres://");
  });
});

describe("the scrape token file", () => {
  let root: string;
  beforeAll(async () => {
    root = await makeFactoryTempPrivateRoot("w4h-34-metrics-");
    await chmod(root, 0o700);
    await writeFile(join(root, "token"), `${TOKEN}\n`, { mode: 0o600 });
    await writeFile(join(root, "short"), "short", { mode: 0o600 });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test("is read through the private reader and trimmed", async () => {
    expect(await loadFactoryMetricsToken(join(root, "token"))).toBe(TOKEN);
  });

  test("refuses by name a token it cannot read or that is too short", async () => {
    await expect(loadFactoryMetricsToken(join(root, "missing"))).rejects.toMatchObject({ code: "factory_metrics_token_unreadable" });
    await expect(loadFactoryMetricsToken(join(root, "short"))).rejects.toMatchObject({ code: "factory_metrics_token_invalid" });
  });
});

describe("a service's declared metrics endpoint", () => {
  const endpoint = { hostname: "0.0.0.0", port: 9464, scrapeTokenPath: "/run/ezcorp/secrets/metrics-token" };

  test("is exactly a hostname, a port and a token path", () => {
    expect(wellFormedFactoryMetricsEndpoint(endpoint)).toBe(true);
    expect(wellFormedFactoryMetricsEndpoint({ ...endpoint, hostname: "harness.internal" })).toBe(true);
    for (const broken of [
      { ...endpoint, port: 0 }, { ...endpoint, port: 70_000 }, { ...endpoint, port: "9464" },
      { ...endpoint, hostname: "" }, { ...endpoint, hostname: "has space" }, { ...endpoint, scrapeTokenPath: "" },
      { ...endpoint, extra: 1 }, { hostname: "0.0.0.0", port: 9464 }, null, "metrics",
    ]) expect(wellFormedFactoryMetricsEndpoint(broken)).toBe(false);
  });

  test("serves through the production renderer, which drops and counts a refused series", async () => {
    const root = await makeFactoryTempPrivateRoot("w4h-34-serve-");
    try {
      await chmod(root, 0o700);
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      const served = await serveFactoryMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "pool", async () => [
        { name: "factory_pool_tenant_holds", labels: { tenant: "tenant-01" }, value: 2 },
        { name: "factory_pool_tenant_holds", labels: { tenant: "not-registered" }, value: 9 },
      ], { tenant: ["tenant-01"] });
      try {
        const body = await (await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
        expect(body).toContain('factory_pool_tenant_holds{tenant="tenant-01"} 2');
        expect(body).not.toContain("not-registered");
        expect(body).toContain("factory_metrics_label_refused_total 1");
      } finally { await served.stop(); }
      // A registered set read per scrape, past its bound: the scrape fails as a whole.
      const tooMany = await serveFactoryMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "pool", async () => [],
        async () => ({ tenant: Array.from({ length: 101 }, (_, index) => `t${index}`) }));
      try {
        expect((await fetch(`${tooMany.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
      } finally { await tooMany.stop(); }
      await expect(serveFactoryMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "missing") }, "pool", async () => [])).rejects.toMatchObject({ code: "factory_metrics_token_unreadable" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("concurrent scrapes share one collection and one body; the next scrape collects again (F9)", async () => {
    const root = await makeFactoryTempPrivateRoot("w4h-34-single-flight-");
    try {
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      let collections = 0;
      const waiting: Array<() => void> = [];
      const release = () => { for (const settle of waiting.splice(0)) settle(); };
      let failing = false;
      const served = await serveFactoryMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "pool", async () => {
        collections += 1;
        await new Promise<void>((settle) => { waiting.push(settle); });
        if (failing) throw new Error("database down");
        return [{ name: "factory_pool_requests", labels: { state: "queued" }, value: collections }];
      });
      try {
        const scrape = () => fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
        const waitForCollection = async (count: number) => { while (collections < count) await Bun.sleep(5); };
        const pair = [scrape(), scrape()];
        await waitForCollection(1);
        await Bun.sleep(50);
        release();
        const bodies = await Promise.all(pair.map(async (response) => (await response).text()));
        expect(collections).toBe(1);
        expect(bodies[1]).toBe(bodies[0]!);
        failing = true;
        const failed = [scrape(), scrape()];
        await waitForCollection(2);
        await Bun.sleep(50);
        release();
        expect(await Promise.all(failed.map(async (response) => (await response).status))).toEqual([503, 503]);
        expect(collections).toBe(2);
      } finally { await served.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("a service's ready gauge", () => {
  test("reads ready at each scrape", async () => {
    const root = await makeFactoryTempPrivateRoot("w4h-34-ready-");
    try {
      await chmod(root, 0o700);
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      let ready = false;
      const served = await serveFactoryReadyMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "orchestrator", () => ready);
      try {
        const scrape = async () => (await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
        expect(await scrape()).toContain("factory_service_ready 0");
        ready = true;
        expect(await scrape()).toContain("factory_service_ready 1");
      } finally { await served.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // C12 "Container runtime readiness (hosted)" with C11 FactoryServiceRoleHeld (W4H-35 merge): the supervisor's endpoint serves the
  // held-roles family beside its ready gauge, read at each scrape; the gauge stays the record's verdict.
  test("the supervisor serves its held roles beside the ready gauge, read at each scrape (W4H-35)", async () => {
    const root = await makeFactoryTempPrivateRoot("w4h-35-held-");
    try {
      await chmod(root, 0o700);
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      let held: readonly string[] = ["container-runtime"];
      const served = await serveFactoryReadyMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "supervisor", () => true, undefined, () => held);
      try {
        const scrape = async () => (await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
        const first = await scrape();
        expect(first).toContain("factory_service_ready 1");
        expect(first).toContain('factory_service_role_held{role="container-runtime"} 1');
        held = [];
        expect(await scrape()).toContain('factory_service_role_held{role="container-runtime"} 0');
      } finally { await served.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // W4H-35 session-6 defect: a supervisor served without a held-roles provider dropped factory_service_role_held, a family the
  // registry declares for it (tests/postgres/factory-metrics-scrape.test.ts:108). The provider is now required for such a service,
  // by type and at run time; a silent 0 would page nothing for a missing wiring (alert-rules.ts: factory_service_role_held == 1).
  test("the services that must serve held roles are read from the registry, and the type names the same set", () => {
    const declared = FACTORY_METRIC_FAMILIES.find((family) => family.name === "factory_service_role_held")?.services ?? [];
    const typed: readonly FactoryRoleHoldingService[] = ["supervisor"];
    expect([...FACTORY_ROLE_HOLDING_SERVICES]).toEqual([...declared]);
    expect([...FACTORY_ROLE_HOLDING_SERVICES]).toEqual([...typed]);
  });

  test("a supervisor served without a held-roles provider is refused, by type and at run time", () => {
    const endpoint = { hostname: "127.0.0.1", port: 0, scrapeTokenPath: "/nonexistent/token" };
    // @ts-expect-error the supervisor declares factory_service_role_held, so its held-roles provider is required
    expect(() => serveFactoryReadyMetrics(endpoint, "supervisor", () => true)).toThrow("the supervisor service declares factory_service_role_held: its held-roles provider is required");
  });

  test("a held-roles provider for a service that declares no held-roles family is refused", () => {
    const endpoint = { hostname: "127.0.0.1", port: 0, scrapeTokenPath: "/nonexistent/token" };
    // @ts-expect-error the gateway declares no factory_service_role_held family, so it takes no held-roles provider
    expect(() => serveFactoryReadyMetrics(endpoint, "gateway", () => true, undefined, () => [])).toThrow("the gateway service declares no factory_service_role_held family");
  });

  test("every ready-gauge service serves exactly its declared family set", async () => {
    const root = await makeFactoryTempPrivateRoot("w4h-35-declared-");
    try {
      await chmod(root, 0o700);
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      const endpoint = { hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") };
      const servers = { gateway: () => serveFactoryReadyMetrics(endpoint, "gateway", () => true), orchestrator: () => serveFactoryReadyMetrics(endpoint, "orchestrator", () => true), supervisor: () => serveFactoryReadyMetrics(endpoint, "supervisor", () => true, undefined, () => []) };
      for (const [service, serve] of Object.entries(servers)) {
        const served = await serve();
        try {
          const text = await (await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
          const names = new Set(text.split("\n").filter((line) => line !== "" && !line.startsWith("#")).map((line) => line.split(/[{ ]/)[0]));
          const declared = FACTORY_METRIC_FAMILIES.filter((family) => family.services.includes(service as never)).map((family) => family.name);
          expect(`${service} serves ${[...names].sort().join(" ")}`).toBe(`${service} serves ${[...declared].sort().join(" ")}`);
        } finally { await served.stop(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a readiness probe that fails or hangs reads as not ready, and the endpoint stays up (F7)", async () => {
    const root = await makeFactoryTempPrivateRoot("ezcorp-metrics-ready-probe-");
    try {
      await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
      let probe: () => Promise<boolean> = async () => { throw new Error("connection refused"); };
      const served = await serveFactoryReadyMetrics({ hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") }, "gateway", () => probe(), 50);
      try {
        const scrape = async () => (await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
        expect(await scrape()).toContain("factory_service_ready 0");
        probe = () => new Promise<boolean>(() => undefined);
        // A hung probe must not hang the scrape: it answers well inside one second.
        const bounded = await fetch(`${served.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1_000) })
          .then((response) => response.text(), () => "the scrape hung");
        expect(bounded).toContain("factory_service_ready 0");
        probe = async () => true;
        expect(await scrape()).toContain("factory_service_ready 1");
      } finally { await served.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("a declared endpoint's start", () => {
  test("starts nothing when undeclared, and reports a failure by code only", async () => {
    const reports: string[] = [];
    expect(await startDeclaredFactoryMetrics(undefined, async () => { throw new Error("never"); }, (code) => { reports.push(code); })).toBeUndefined();
    const endpoint = { hostname: "127.0.0.1", port: 1, scrapeTokenPath: "/x" };
    expect(await startDeclaredFactoryMetrics(endpoint, async () => { throw Object.assign(new Error("/secret/path"), { code: "factory_metrics_token_unreadable" }); }, (code) => { reports.push(code); })).toBeUndefined();
    expect(await startDeclaredFactoryMetrics(endpoint, async () => { throw new Error("/secret/path"); }, (code) => { reports.push(code); })).toBeUndefined();
    expect(await startDeclaredFactoryMetrics(endpoint, async () => { throw Object.assign(new Error("x"), { code: "Not A Code" }); }, (code) => { reports.push(code); })).toBeUndefined();
    expect(reports).toEqual(["factory_metrics_token_unreadable", "factory_metrics_unavailable", "factory_metrics_unavailable"]);
    const listener = { url: "u", stop: async () => undefined };
    expect(await startDeclaredFactoryMetrics(endpoint, async () => listener, () => undefined)).toBe(listener);
  });
});
