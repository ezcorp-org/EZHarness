import { describe, expect, test, vi } from "vitest";
import type { FactoryApiRequest } from "@ezcorp/factory-sdk";
import type { FactoryApplication } from "$server/factory/application";
import type { FactoryPrincipal } from "$server/factory/grants";
import { dispatchFactoryConsoleRequest, factoryArtifactDownloadPath, factoryRunKey } from "./console-dispatch";

const principal: FactoryPrincipal = { kind: "user", id: "dispatch-user", authentication: "session" };

describe("the console dispatcher", () => {
	test("leaves every kind it does not own to the next dispatcher, without composing the console", async () => {
		const console = vi.fn();
		const application = { console } as unknown as FactoryApplication;
		const request = { schemaVersion: "factory.api.request.v1", kind: "run.get", path: { projectId: "p", runId: "r" } } as unknown as FactoryApiRequest;
		expect(await dispatchFactoryConsoleRequest(application, principal, request)).toBeNull();
		expect(console).not.toHaveBeenCalled();
	});

	test("an artifact path names its run and its download path exactly, encoded", () => {
		const path = { projectId: "p/1", runId: "r 1", artifactId: "a?1" };
		expect(factoryRunKey(path)).toEqual({ projectId: "p/1", runId: "r 1" });
		expect(factoryArtifactDownloadPath(path)).toBe("/api/factories/projects/p%2F1/runs/r%201/artifacts/a%3F1/download");
	});
});
