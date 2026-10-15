import { afterEach, describe, expect, test } from "vitest";
import type { FactoryApplication } from "$server/factory/application";
import type { FactoryPrincipal } from "$server/factory/grants";
import type { FactoryApiRequest, FactoryApiResponse } from "@ezcorp/factory-sdk";
import { FactoryGrantError } from "$server/factory/grants";
import { answer as errorAnswer, dispatchRegisteredFactoryRequest, mappedFactoryError, registerFactoryDispatcher, registerFactoryErrorFamily, type FactoryRequestDispatcher } from "./route-kit";

const application = {} as FactoryApplication;
const principal: FactoryPrincipal = { kind: "user", id: "route-kit-user", authentication: "session" };
const request = { kind: "run.get", path: { projectId: "project-1", runId: "run-1" } } as unknown as FactoryApiRequest;
const answer = (id: string) => ({ schemaVersion: "factory.api.response.v1", kind: "run.details", resource: { runId: id } }) as unknown as FactoryApiResponse;

const removals: (() => void)[] = [];
function register(dispatcher: FactoryRequestDispatcher): () => void {
  const remove = registerFactoryDispatcher(dispatcher);
  removals.push(remove);
  return remove;
}
afterEach(() => { for (const remove of removals.splice(0)) remove(); });

describe("the factory dispatcher extension point", () => {
  test("answers null when no dispatcher is registered", async () => {
    expect(await dispatchRegisteredFactoryRequest(application, principal, request)).toBeNull();
  });

  test("passes the request to each dispatcher in registration order, and the first answer wins", async () => {
    const seen: string[] = [];
    register(async (app, who, req) => { seen.push(`first:${who.id}:${req.kind}:${app === application}`); return null; });
    register(async () => { seen.push("second"); return answer("second"); });
    register(async () => { seen.push("third"); return answer("third"); });
    expect(await dispatchRegisteredFactoryRequest(application, principal, request)).toEqual(answer("second"));
    expect(seen).toEqual(["first:route-kit-user:run.get:true", "second"]);
  });

  test("a removed dispatcher is no longer asked, and removing it twice changes nothing", async () => {
    const remove = register(async () => answer("removed"));
    register(async () => answer("kept"));
    remove();
    remove();
    expect(await dispatchRegisteredFactoryRequest(application, principal, request)).toEqual(answer("kept"));
  });

  test("a dispatcher's error reaches the caller unchanged", async () => {
    const failure = new Error("dispatcher failed");
    register(async () => { throw failure; });
    await expect(dispatchRegisteredFactoryRequest(application, principal, request)).rejects.toBe(failure);
  });
});

class ConsoleProbeError extends Error { constructor(readonly code: string) { super(code); } }

describe("the factory error family extension point", () => {
  test("a registered family maps its codes, falls back to its storage answer, and stops after removal", async () => {
    const remove = registerFactoryErrorFamily({ type: ConsoleProbeError, storage: "Probe storage is unavailable.", answers: [errorAnswer(410, "The probe expired.", "probe_expired")] });
    const expired = mappedFactoryError(new ConsoleProbeError("probe_expired"));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ kind: "error", error: { code: "probe_expired", message: "The probe expired.", retryable: false } });
    const unknown = mappedFactoryError(new ConsoleProbeError("probe_other"));
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toMatchObject({ error: { code: "probe_other", message: "Probe storage is unavailable.", retryable: true } });
    remove();
    remove();
    const failure = new ConsoleProbeError("probe_expired");
    expect(() => mappedFactoryError(failure)).toThrow(failure);
  });

  test("a family without a storage answer rethrows an unknown code", () => {
    const remove = registerFactoryErrorFamily({ type: ConsoleProbeError, storage: null, answers: [] });
    const failure = new ConsoleProbeError("probe_other");
    expect(() => mappedFactoryError(failure)).toThrow(failure);
    remove();
  });

  test("a family that repeats, extends, or is extended by another family's class is refused by name", () => {
    expect(() => registerFactoryErrorFamily({ type: FactoryGrantError, storage: null, answers: [] })).toThrow("The factory error family for FactoryGrantError overlaps the one for FactoryGrantError.");
    class GrantSubclassError extends FactoryGrantError {}
    expect(() => registerFactoryErrorFamily({ type: GrantSubclassError, storage: null, answers: [] })).toThrow("The factory error family for GrantSubclassError overlaps the one for FactoryGrantError.");
    const remove = registerFactoryErrorFamily({ type: ConsoleProbeError, storage: null, answers: [] });
    expect(() => registerFactoryErrorFamily({ type: ConsoleProbeError, storage: null, answers: [] })).toThrow("The factory error family for ConsoleProbeError overlaps the one for ConsoleProbeError.");
    class ProbeSubclassError extends ConsoleProbeError {}
    expect(() => registerFactoryErrorFamily({ type: ProbeSubclassError, storage: null, answers: [] })).toThrow("overlaps the one for ConsoleProbeError");
    remove();
    // A superclass of a registered family's class is refused too.
    const removeSub = registerFactoryErrorFamily({ type: ProbeSubclassError, storage: null, answers: [] });
    expect(() => registerFactoryErrorFamily({ type: ConsoleProbeError, storage: null, answers: [] })).toThrow("The factory error family for ConsoleProbeError overlaps the one for ProbeSubclassError.");
    removeSub();
  });
});
