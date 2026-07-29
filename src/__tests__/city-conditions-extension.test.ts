/**
 * city-conditions — host-side contract: the manifest installs, the
 * bundled registration and its ceiling agree, and the shipped
 * `conditions.workflow.yaml` loads, namespaces, batches and RUNS.
 *
 * The workflow assertions drive the REAL executor over the REAL YAML with
 * the REAL tool handlers behind an injected `fetch` — no network. That is
 * what makes the parallel-batch claim (`weather` ∥ `air`) a fact rather
 * than a comment: the batcher's own output is asserted, and the run is
 * then executed end-to-end through it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadManifest } from "../extensions/loader";
import { validateManifestV2 } from "../extensions/manifest";
import { getProjectRoot, resolveBundledExtensions } from "../extensions/bundled";
import { clampToBundledCeiling, getCeiling } from "../extensions/bundled-ceiling";
import { clampWorkflowsPermission } from "../extensions/clamp-permissions";
import { loadExtensionWorkflows } from "../runtime/workflow-extension-loader";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { validateWorkflow } from "../runtime/workflow-validator";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";
import type { ToolCallResult } from "../extensions/types";
import type { AgentEvents, WorkflowDefinition, WorkflowStep } from "../types";
import { tools } from "../../docs/extensions/examples/city-conditions/index";
import {
  _resetBindingsForTests,
  _setFetchImplForTests,
} from "../../docs/extensions/examples/city-conditions/lib/open-meteo";

const EXT_NAME = "city-conditions";
const EXT_DIR = join(getProjectRoot(), "docs/extensions/examples/city-conditions");

const OPEN_METEO_HOSTS = [
  "air-quality-api.open-meteo.com",
  "api.open-meteo.com",
  "geocoding-api.open-meteo.com",
];

// ── Upstream fixtures (the suite never touches the network) ──────────

const GEO_BODY = {
  results: [{
    name: "Austin",
    admin1: "Texas",
    country: "United States",
    latitude: 30.267,
    longitude: -97.743,
    timezone: "America/Chicago",
  }],
};

const FORECAST_BODY = {
  utc_offset_seconds: -18000,
  current: {
    time: "2026-07-28T15:04",
    temperature_2m: 34.2,
    apparent_temperature: 38.1,
    relative_humidity_2m: 55,
    wind_speed_10m: 12.4,
    weather_code: 2,
    is_day: 1,
  },
};

const AIR_BODY = {
  current: {
    alder_pollen: null,
    birch_pollen: 0.2,
    grass_pollen: 8.1,
    mugwort_pollen: null,
    olive_pollen: null,
    ragweed_pollen: 1.4,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Install the fake upstream; returns a probe of peak concurrent calls. */
function stubUpstream(geo: unknown = GEO_BODY): { peakConcurrent: () => number } {
  let inFlight = 0;
  let peak = 0;
  _setFetchImplForTests((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geocoding-api")) return json(geo);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return json(url.includes("air-quality-api") ? AIR_BODY : FORECAST_BODY);
  }) as typeof fetch);
  return { peakConcurrent: () => peak };
}

// ── Workflow harness ────────────────────────────────────────────────

/** Dispatch `city-conditions__<tool>` straight at the real handlers. */
function extensionToolRunner(): WorkflowToolRunner {
  return {
    setCurrentUserId() {},
    async executeToolCall(toolName, input): Promise<ToolCallResult> {
      const bare = toolName.startsWith(`${EXT_NAME}__`)
        ? toolName.slice(EXT_NAME.length + 2)
        : toolName;
      const handler = tools[bare];
      if (!handler) {
        return { content: [{ type: "text", text: `unknown tool ${toolName}` }], isError: true };
      }
      return await handler(input);
    },
  };
}

function executor(): WorkflowExecutor {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
    toolRunnerFactory: extensionToolRunner,
  });
}

async function loadConditionsWorkflow(): Promise<WorkflowDefinition> {
  const loaded = await loadExtensionWorkflows([
    { extensionName: EXT_NAME, installPath: EXT_DIR },
  ]);
  const wf = loaded.find((w) => w.name === `${EXT_NAME}:conditions`);
  if (!wf) throw new Error("conditions.workflow.yaml did not load");
  return wf;
}

function step(wf: WorkflowDefinition, name: string): WorkflowStep {
  const found = wf.steps.find((s) => s.name === name);
  if (!found) throw new Error(`step "${name}" is missing from the workflow`);
  return found;
}

// ── Manifest ────────────────────────────────────────────────────────

describe("manifest", () => {
  test("loads from disk and passes install-time validation", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.name).toBe(EXT_NAME);
    const result = validateManifestV2(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("the declared entrypoint exists (the install path checksums it)", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.entrypoint).toBe("./index.ts");
    expect(existsSync(join(EXT_DIR, "index.ts"))).toBe(true);
  });

  test("declares a smokeTest naming one of its own tools", async () => {
    const manifest = await loadManifest(EXT_DIR);
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(manifest.smokeTest).toBeDefined();
    expect(names).toContain(manifest.smokeTest!.tool);
  });

  test("takes no credential-shaped env grant — the install gate is never approached", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.permissions?.env).toBeUndefined();
  });
});

// ── Install posture: user-installed, NOT bundled ────────────────────
//
// This extension is deliberately not auto-installed. It reaches
// third-party APIs, which should be opt-in for a self-hosted deployment,
// and its closest analogue (`weather` — same provider, same demo purpose,
// also ships a card) is unbundled for the same reason.
//
// The old bundled-grant + ceiling assertions have no subject any more, so
// they are re-pointed at what governs the extension NOW: the manifest
// declaration a user consents to at install, and the real install-time
// clamp that turns it into a grant. The "is not bundled" and "has no
// ceiling row" assertions are not filler — they are what stops a future
// change from silently re-bundling it.

describe("install posture (unbundled)", () => {
  test("is NOT in the bundled auto-install list", () => {
    const bundled = resolveBundledExtensions({}).map((e) => e.name);
    expect(bundled).not.toContain(EXT_NAME);
    // The directory is still on disk — unbundled means "not auto-installed",
    // not "not shipped".
    expect(existsSync(join(getProjectRoot(), "docs/extensions/examples/city-conditions"))).toBe(true);
  });

  test("has no bundled ceiling row, and the ceiling clamp is a passthrough", () => {
    // `getCeiling` returns null for a non-bundled name, which makes
    // `clampToBundledCeiling` a documented passthrough. A ceiling row here
    // would be inert AND would desync the table from BUNDLED_EXTENSIONS
    // (asserted by bundled-ceiling.test.ts).
    expect(getCeiling(EXT_NAME)).toBeNull();
    const requested = { network: [...OPEN_METEO_HOSTS], grantedAt: {} };
    const { effective, clamped } = clampToBundledCeiling(EXT_NAME, requested);
    expect(clamped).toBe(false);
    expect(effective).toEqual(requested);
  });

  test("the manifest declares exactly the three Open-Meteo hosts and nothing wider", async () => {
    const manifest = await loadManifest(EXT_DIR);
    const perms = manifest.permissions ?? {};
    expect([...(perms.network ?? [])].sort()).toEqual(OPEN_METEO_HOSTS);
    expect(perms.shell).toBeUndefined();
    expect(perms.filesystem).toBeUndefined();
    expect(perms.env).toBeUndefined();
    expect(perms.storage).toBeUndefined();
  });

  test("the declared workflow grant survives the real install-time clamp with a finite bound", async () => {
    // The path a user-installed extension actually takes:
    // `clampWorkflowsPermission(submitted, manifest)` with no submitted
    // grant means "the admin approved the declaration as-is". The rate
    // bound must come out finite — `intersectPermissions` later does
    // `Math.min` on it, and a NaN there silently kills the grant.
    const manifest = await loadManifest(EXT_DIR);
    const granted = clampWorkflowsPermission(undefined, manifest.permissions?.workflows);
    expect(granted).toEqual({ names: ["conditions"], maxRunsPerHour: 12 });
    expect(Number.isFinite(granted!.maxRunsPerHour)).toBe(true);
  });

  test("the manifest declares the same bare workflow name the shipped asset does", async () => {
    // Manifest ↔ asset consistency: a declared name that no shipped YAML
    // provides is an unfireable grant, and a shipped workflow the manifest
    // does not declare can never be triggered from extension code.
    const manifest = await loadManifest(EXT_DIR);
    const declared = manifest.permissions?.workflows?.names ?? [];
    const shipped = (await loadExtensionWorkflows([
      { extensionName: EXT_NAME, installPath: EXT_DIR },
    ])).map((w) => w.name.slice(EXT_NAME.length + 1));
    expect(declared).toEqual(["conditions"]);
    expect(shipped).toEqual(declared);
  });
});

// ── The shipped workflow ────────────────────────────────────────────

describe("conditions.workflow.yaml", () => {
  test("loads from the install dir and is namespaced to the extension", async () => {
    const wf = await loadConditionsWorkflow();
    expect(wf.name).toBe("city-conditions:conditions");
    expect(wf.description).toContain("concurrently");
  });

  test("passes definition-time validation", async () => {
    const wf = await loadConditionsWorkflow();
    expect(validateWorkflow(wf)).toEqual([]);
  });

  test("every tool step targets one of this extension's own tools", async () => {
    const wf = await loadConditionsWorkflow();
    const toolSteps = wf.steps.filter((s) => s.kind === "tool");
    expect(toolSteps.length).toBe(3);
    for (const s of toolSteps) {
      expect(s.tool!.startsWith(`${EXT_NAME}__`)).toBe(true);
      expect(Object.keys(tools)).toContain(s.tool!.slice(EXT_NAME.length + 2));
    }
  });

  test("weather and air share ONE parallel batch — the point of the graph", async () => {
    const wf = await loadConditionsWorkflow();
    const batches = executor().resolveExecutionOrder(wf.steps);
    const names = batches.map((b) => b.map((s) => s.name));
    expect(names).toEqual([
      ["locate"],
      ["located"],
      ["weather", "air"],
      ["report"],
      ["complete"],
      ["output"],
    ]);
  });

  test("weather and air depend on `located` and on nothing else", async () => {
    const wf = await loadConditionsWorkflow();
    expect(step(wf, "weather").dependsOn).toEqual(["located"]);
    expect(step(wf, "air").dependsOn).toEqual(["located"]);
  });

  test("the completion gate asserts the mold field is still present", async () => {
    const wf = await loadConditionsWorkflow();
    const cond = step(wf, "complete").condition as { all: Array<{ ref: string }> };
    const refs = cond.all.map((c) => c.ref);
    expect(refs).toContain("$steps.report.output.mold.available");
    expect(refs).toContain("$steps.report.output.place.name");
    expect(refs).toContain("$steps.report.output.pollen.band");
  });
});

describe("conditions workflow — end to end", () => {
  test("runs green and assembles the full report, fetching the two upstreams concurrently", async () => {
    const probe = stubUpstream();
    try {
      const run = await executor().runWorkflow(await loadConditionsWorkflow(), { city: "Austin" });
      expect(run.status).toBe("success");
      expect(probe.peakConcurrent()).toBe(2);

      const out = run.result!.output as Record<string, unknown>;
      expect((out.place as { name: string }).name).toBe("Austin");
      expect(out.observedAt).toBe("2026-07-28T15:04:00-05:00");
      expect(out.localTime).toBe("3:04 PM");
      expect((out.weather as { label: string }).label).toBe("Partly cloudy");
      expect((out.pollen as { band: string }).band).toBe("moderate");
      expect((out.mold as { available: boolean }).available).toBe(false);
      expect(String(out.summary)).toContain("Austin at 3:04 PM");
      expect(String(out.summary)).toContain("Mold not available");
    } finally {
      _resetBindingsForTests();
    }
  });

  test("an unknown city fails the run loudly at `locate`, carrying the code", async () => {
    _setFetchImplForTests((async (input: string | URL | Request) => {
      if (String(input).includes("geocoding-api")) return json({ results: [] });
      return json(FORECAST_BODY);
    }) as typeof fetch);
    try {
      const run = await executor().runWorkflow(await loadConditionsWorkflow(), { city: "Atlantis" });
      expect(run.status).toBe("error");
      const error = run.result!.error;
      const message = typeof error === "string" ? error : error!.message;
      expect(message).toContain("locate");
      expect(message).toContain("CITY_NOT_FOUND");
    } finally {
      _resetBindingsForTests();
    }
  });

  test("the `located` gate blocks a place with no coordinates, and says which ref broke", async () => {
    // A geocoder that 200s with a latitude-less match — the exact shape the
    // gate exists to stop before two upstream calls are spent on it.
    const runner = (): WorkflowToolRunner => ({
      setCurrentUserId() {},
      async executeToolCall(toolName): Promise<ToolCallResult> {
        if (toolName.endsWith("__geocode")) {
          const body = JSON.stringify({ v: 1, ok: true, place: { name: "Nowhere" } });
          return { content: [{ type: "text", text: body }], isError: false };
        }
        return { content: [{ type: "text", text: "should not be reached" }], isError: true };
      },
    });
    const bus = new EventBus<AgentEvents>();
    const wf = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
      toolRunnerFactory: runner,
    });

    const run = await wf.runWorkflow(await loadConditionsWorkflow(), { city: "Nowhere" });
    expect(run.status).toBe("error");
    const error = run.result!.error;
    const message = typeof error === "string" ? error : error!.message;
    expect(message).toContain("located");
    expect(message).toContain("$steps.locate.output.place.latitude");
  });
});
