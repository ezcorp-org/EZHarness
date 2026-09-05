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
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { discoverFirstPartyManifest as loadManifest, withFirstPartyExecution } from "./helpers/first-party-manifest";
import { validateManifest } from "@ezcorp/extension-contract";
import { getProjectRoot, resolveBundledExtensions } from "../extensions/bundled";
import { BUNDLED_CEILING, clampToBundledCeiling } from "../extensions/bundled-ceiling";
import { loadExtensionWorkflows } from "../runtime/workflow-extension-loader";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { validateWorkflow } from "../runtime/workflow-validator";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";
import type { ToolCallResult } from "../extensions/types";
import type { AgentEvents, WorkflowDefinition, WorkflowStep } from "../types";
import {
  _resetGooglePollenKeyResolverForTests,
  tools,
} from "../../docs/extensions/examples/city-conditions/index";
import {
  _resetBindingsForTests,
  _setFetchImplForTests,
} from "../../docs/extensions/examples/city-conditions/lib/open-meteo";

const EXT_NAME = "city-conditions";
const EXT_DIR = join(getProjectRoot(), "docs/extensions/examples/city-conditions");

const CONDITIONS_HOSTS = [
  "air-quality-api.open-meteo.com",
  "api.open-meteo.com",
  "geocoding-api.open-meteo.com",
  "pollen.googleapis.com",
  "www.atlantaallergy.com",
];

beforeEach(() => _resetGooglePollenKeyResolverForTests());

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
    time: "2026-07-28T15:00",
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
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(4);
  });

  test("the declared entrypoint exists (the install path checksums it)", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.entrypoint).toBe("./extension.ts");
    expect(existsSync(join(EXT_DIR, "extension.ts"))).toBe(true);
  });

  test("declares a smokeTest naming one of its own tools", async () => {
    const manifest = await loadManifest(EXT_DIR);
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(manifest.smokeTest).toBeDefined();
    expect(names).toContain(manifest.smokeTest!.tool);
  });

  test("the declared smokeTest round-trips through the actual v4 worker without host capabilities", async () => {
    await withFirstPartyExecution(EXT_DIR, async (manifest, execution) => {
      const smoke = manifest.smokeTest!;
      const expectedText = smoke.expect?.textIncludes;
      if (!expectedText) throw new Error("City smoke test must declare expected response text");
      const result = await execution.request("extension/invoke", {
        name: smoke.tool,
        input: smoke.input,
        context: { invocationId: "city-smoke", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "fixture", deadline: Date.now() + 5000 },
      }) as ToolCallResult;
      expect(result.isError).toBe(smoke.expect?.isError);
      expect(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")).toContain(expectedText);
    });
  }, 30_000);

  test("stores the Google key as a secret instead of a credential-shaped env grant", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.permissions?.env).toBeUndefined();
    expect(manifest.permissions?.storage).toBe(true);
    expect(manifest.settings?.google_pollen_api_key).toMatchObject({
      type: "secret",
      storageKey: "google-pollen-api-key",
    });
  });
});

// ── Bundled registration + ceiling ──────────────────────────────────

describe("bundled registration", () => {
  const entry = resolveBundledExtensions({}).find((e) => e.name === EXT_NAME);

  test("is registered in bundled.ts and points at a real directory", () => {
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("docs/extensions/examples/city-conditions");
    expect(existsSync(join(getProjectRoot(), entry!.path))).toBe(true);
  });

  test("grants only provider network access plus encrypted-key Storage", () => {
    expect([...(entry!.permissions.network ?? [])].sort()).toEqual(CONDITIONS_HOSTS);
    expect(entry!.permissions.storage).toBe(true);
    expect(entry!.permissions.shell).toBeUndefined();
    expect(entry!.permissions.filesystem).toBeUndefined();
    expect(entry!.permissions.env).toBeUndefined();
  });

  test("has a ceiling row mirroring the grant", () => {
    const ceiling = BUNDLED_CEILING[EXT_NAME];
    expect(ceiling).toBeDefined();
    expect([...(ceiling!.network ?? [])].sort()).toEqual(CONDITIONS_HOSTS);
    expect(ceiling!.storage).toBe(true);
    expect(ceiling!.workflows).toEqual({ names: ["conditions"], maxRunsPerHour: 12 });
  });

  test("the ceiling carries the FULL workflows field set, so the clamp is lossless", () => {
    // The full-field-set rule: `intersectPermissions` does
    // `Math.min(a.maxRunsPerHour, b.maxRunsPerHour)`, so a ceiling row
    // missing the numeric would yield NaN and silently kill the grant at
    // boot. Assert the clamp is a no-op instead of trusting the comment.
    const { effective, clamped } = clampToBundledCeiling(EXT_NAME, entry!.permissions);
    expect(clamped).toBe(false);
    expect(effective.workflows).toEqual({ names: ["conditions"], maxRunsPerHour: 12 });
    expect(Number.isFinite(effective.workflows!.maxRunsPerHour)).toBe(true);
    expect(effective.storage).toBe(true);
    expect([...(effective.network ?? [])].sort()).toEqual(CONDITIONS_HOSTS);
  });

  test("the manifest declares the workflow name the grant carries", async () => {
    const manifest = await loadManifest(EXT_DIR);
    expect(manifest.permissions?.workflows?.names).toEqual(["conditions"]);
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
      expect(String(out.summary)).toContain("Mold status:");
    } finally {
      _resetBindingsForTests();
    }
  });

  test("an allergen outage keeps the workflow green with explicit unavailable fields", async () => {
    _setFetchImplForTests((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geocoding-api")) return json(GEO_BODY);
      if (url.includes("air-quality-api")) return json({}, 503);
      return json(FORECAST_BODY);
    }) as typeof fetch);
    try {
      const run = await executor().runWorkflow(await loadConditionsWorkflow(), { city: "Austin" });
      expect(run.status).toBe("success");
      const out = run.result!.output as Record<string, unknown>;
      expect((out.pollen as { available: boolean }).available).toBe(false);
      expect((out.pollen as { reason: string }).reason).toContain("HTTP 503");
      expect((out.mold as { available: boolean }).available).toBe(false);
      expect(String(out.summary)).toContain("Pollen status: none");
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
