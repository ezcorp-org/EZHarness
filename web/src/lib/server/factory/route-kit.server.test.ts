import { afterEach, describe, expect, test } from "vitest";
import type { FactoryApplication } from "$server/factory/application";
import type { FactoryPrincipal } from "$server/factory/grants";
import type { FactoryApiRequest, FactoryApiResponse } from "@ezcorp/factory-sdk";
import { dispatchRegisteredFactoryRequest, registerFactoryDispatcher, type FactoryRequestDispatcher } from "./route-kit";

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
