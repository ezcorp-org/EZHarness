import { describe, expect, test } from "bun:test";
import { FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS, factoryTemporalNamespaceArguments, FactoryTemporalHttpPositions, FactoryTemporalRetentionError, factoryTemporalPositionMoved, verifyFactoryTemporalRetention } from "./temporal-retention";

type Handler = (url: URL, init: RequestInit & { tls?: unknown }) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; tls?: unknown }[] = [];
  const fetcher = (async (input: URL, init: RequestInit & { tls?: unknown }) => { calls.push({ url: input.toString(), tls: init.tls }); return handler(input, init); }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const ready = { config: { workflowExecutionRetentionTtl: `${30 * 86_400}s`, historyArchivalState: "ARCHIVAL_STATE_ENABLED", historyArchivalUri: "file:///archive/history", visibilityArchivalState: "ARCHIVAL_STATE_ENABLED" } };

describe("Temporal history retention and archival", () => {
  test("a namespace with thirty days of history and both archivals enabled is ready", async () => {
    const { fetcher, calls } = fakeFetch(() => Response.json(ready));
    const report = await verifyFactoryTemporalRetention({ endpoint: "https://temporal.internal:7243", namespace: "tenant-a", fetch: fetcher, tls: { cert: "c", key: "k", ca: "a" } });
    expect(report).toEqual({ namespace: "tenant-a", retentionSeconds: 2_592_000, historyArchival: "ARCHIVAL_STATE_ENABLED", historyArchiveUri: "file:///archive/history", visibilityArchival: "ARCHIVAL_STATE_ENABLED", ready: true, unmet: [] });
    expect(calls).toEqual([{ url: "https://temporal.internal:7243/api/v1/namespaces/tenant-a", tls: { cert: "c", key: "k", ca: "a" } }]);
  });

  test("every unmet criterion is named, and nothing is changed", async () => {
    const { fetcher } = fakeFetch(() => Response.json({ config: { workflowExecutionRetentionTtl: "86400s", historyArchivalState: "ARCHIVAL_STATE_DISABLED" } }));
    const report = await verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "tenant-a", fetch: fetcher });
    expect(report.ready).toBe(false);
    expect(report.unmet).toEqual(["history-retention-below-30-days", "history-archival-disabled", "visibility-archival-disabled"]);
    const noConfig = fakeFetch(() => Response.json({}));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "tenant-a", fetch: noConfig.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
  });

  test("an unreachable, refusing, or malformed server is an error, never a pass", async () => {
    const unreachable = fakeFetch(() => { throw new Error("connection refused"); });
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: unreachable.fetcher })).rejects.toMatchObject({ code: "factory_temporal_unreachable" });
    const refusing = fakeFetch(() => Response.json({ message: "no" }, { status: 403 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: refusing.fetcher })).rejects.toMatchObject({ code: "factory_temporal_unreachable" });
    const empty = fakeFetch(() => new Response("", { status: 200 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: empty.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    const garbage = fakeFetch(() => new Response("{not json", { status: 200 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: garbage.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    await expect(verifyFactoryTemporalRetention({ endpoint: "not a url", namespace: "n" })).rejects.toMatchObject({ code: "factory_temporal_invalid" });
    await expect(verifyFactoryTemporalRetention({ endpoint: "ftp://temporal", namespace: "n" })).rejects.toMatchObject({ code: "factory_temporal_invalid" });
  });

  test("positions come from the visibility list, newest run first; an unknown workflow reads as not found", async () => {
    const running = { execution: { workflowId: "tenant/run-live", runId: "run-7" }, status: "WORKFLOW_EXECUTION_STATUS_RUNNING", startTime: "2026-09-02T00:00:00Z" };
    const earlier = { execution: { workflowId: "tenant/run-live", runId: "run-6" }, status: "WORKFLOW_EXECUTION_STATUS_TERMINATED", historyLength: "9", startTime: "2026-09-01T00:00:00Z" };
    const { fetcher, calls } = fakeFetch(url => url.searchParams.get("query")!.includes("run-missing")
      ? Response.json({ executions: [] })
      : url.searchParams.get("query")!.includes("run-closed")
        ? Response.json({ executions: [{ execution: { runId: "run-3" }, status: "WORKFLOW_EXECUTION_STATUS_COMPLETED", historyLength: "12" }] })
        : Response.json({ executions: [earlier, running] }));
    const positions = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fetcher });
    expect(positions.namespace).toBe("tenant-ns");
    expect(await positions.positions(["tenant/run-live", "tenant/run-missing", "tenant/run-closed"], new AbortController().signal)).toEqual([
      { workflowId: "tenant/run-live", runId: "run-7", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: null },
      { workflowId: "tenant/run-missing", runId: null, status: "not_found", historyLength: null },
      { workflowId: "tenant/run-closed", runId: "run-3", status: "WORKFLOW_EXECUTION_STATUS_COMPLETED", historyLength: 12 },
    ]);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/api/v1/namespaces/tenant-ns/workflows");
    expect(first.searchParams.get("query")).toBe('WorkflowId="tenant/run-live"');
    await positions.positions(['odd"id\\x']);
    expect(new URL(calls.at(-1)!.url).searchParams.get("query")).toBe('WorkflowId="odd\\"id\\\\x"');
    for (const body of [{ executions: [{ status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: "-1" }] }, { executions: [{ historyLength: "1" }] }, { executions: {} }]) {
      const bad = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => Response.json(body)).fetcher });
      await expect(bad.positions(["w"])).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    }
    const refused = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => Response.json({ message: "denied" }, { status: 403 })).fetcher });
    await expect(refused.positions(["w"])).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    const empty = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => new Response("", { status: 200 })).fetcher });
    expect(await empty.positions(["w"])).toEqual([{ workflowId: "w", runId: null, status: "not_found", historyLength: null }]);
    const anonymous = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => Response.json({ executions: [{ status: "WORKFLOW_EXECUTION_STATUS_RUNNING" }] })).fetcher });
    expect(await anonymous.positions(["w"])).toEqual([{ workflowId: "w", runId: null, status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: null }]);
    expect(() => new FactoryTemporalHttpPositions({ endpoint: "http://x", namespace: "bad namespace" })).toThrow(FactoryTemporalRetentionError);
  });

  test("a tenant restore counts only forward movement; a cluster restore counts any difference", () => {
    const at = (runId: string | null, status: string, historyLength: number | null) => ({ workflowId: "w", runId, status, historyLength });
    const running = at("r1", "WORKFLOW_EXECUTION_STATUS_RUNNING", null);
    const closed = at("r1", "WORKFLOW_EXECUTION_STATUS_COMPLETED", 10);
    // Tenant: nothing to compare, or not found live.
    expect(factoryTemporalPositionMoved("tenant", undefined, running)).toBe(false);
    expect(factoryTemporalPositionMoved("tenant", running, undefined)).toBe(false);
    expect(factoryTemporalPositionMoved("tenant", running, at(null, "not_found", null))).toBe(false);
    // Tenant: a new run, a close since the checkpoint, or a longer history moved forward.
    expect(factoryTemporalPositionMoved("tenant", running, at("r2", "WORKFLOW_EXECUTION_STATUS_RUNNING", null))).toBe(true);
    expect(factoryTemporalPositionMoved("tenant", running, closed)).toBe(true);
    expect(factoryTemporalPositionMoved("tenant", running, running)).toBe(false);
    expect(factoryTemporalPositionMoved("tenant", closed, at("r1", "WORKFLOW_EXECUTION_STATUS_COMPLETED", 11))).toBe(true);
    expect(factoryTemporalPositionMoved("tenant", closed, closed)).toBe(false);
    expect(factoryTemporalPositionMoved("tenant", closed, at("r1", "WORKFLOW_EXECUTION_STATUS_COMPLETED", null))).toBe(false);
    // Cluster: every field must be equal, and both positions must exist.
    expect(factoryTemporalPositionMoved("cluster", closed, closed)).toBe(false);
    expect(factoryTemporalPositionMoved("cluster", undefined, closed)).toBe(true);
    expect(factoryTemporalPositionMoved("cluster", closed, undefined)).toBe(true);
    expect(factoryTemporalPositionMoved("cluster", closed, at("r2", "WORKFLOW_EXECUTION_STATUS_COMPLETED", 10))).toBe(true);
    expect(factoryTemporalPositionMoved("cluster", closed, at("r1", "WORKFLOW_EXECUTION_STATUS_TERMINATED", 10))).toBe(true);
    expect(factoryTemporalPositionMoved("cluster", closed, at("r1", "WORKFLOW_EXECUTION_STATUS_COMPLETED", 9))).toBe(true);
  });

  test("the provisioner's namespace arguments carry the thirty-day retention and both archive URIs", () => {
    expect(factoryTemporalNamespaceArguments("tenant-a", "file:///archive/history", "file:///archive/visibility")).toEqual([
      "--namespace", "tenant-a", "--retention", `${FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * 24}h`,
      "--history-archival-state", "enabled", "--history-uri", "file:///archive/history",
      "--visibility-archival-state", "enabled", "--visibility-uri", "file:///archive/visibility",
    ]);
    for (const [namespace, history, visibility] of [["", "s3://a", "s3://b"], ["ok", "not-a-uri", "s3://b"], ["ok", "s3://a", ""]] as const) {
      expect(() => factoryTemporalNamespaceArguments(namespace, history, visibility)).toThrow(FactoryTemporalRetentionError);
    }
  });
});
