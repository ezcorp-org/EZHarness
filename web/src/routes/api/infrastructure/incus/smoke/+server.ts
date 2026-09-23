import { createHash } from "node:crypto";
import { json } from "@sveltejs/kit";
import { requireAdminSession } from "$server/auth/middleware";
import { IncusHostLiveWitness } from "$server/infrastructure/incus-host-live-witness";
import { IncusQualificationFixtureService, type IncusQualificationScope } from "$server/infrastructure/incus-qualification";
import type { LiveFixtureHandle } from "$server/infrastructure/incus-live-cases";
import type { RequestHandler } from "./$types";

type Action = "create" | "start" | "status" | "inspect" | "marker" | "compose" | "stop" | "destroy";
const fields = ["action", "installationId", "releaseId", "connectionId", "presetId", "operationId"];
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const smokeId = /^incus-smoke-[A-Za-z0-9_.:-]{1,96}$/;
const immutableImage = /^[a-z0-9][a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const markerPath = "ezh-smoke-marker";
const composePath = "ezh-smoke-compose.yaml";

function parse(value: unknown): { action: Action; scope: IncusQualificationScope; operationId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action !== "create" && input.action !== "start" && input.action !== "status"
    && input.action !== "inspect" && input.action !== "marker" && input.action !== "compose"
    && input.action !== "stop" && input.action !== "destroy") return null;
  if (Object.keys(input).sort().join(",") !== [...fields].sort().join(",")) return null;
  if (fields.slice(1).some(field => typeof input[field] !== "string" || !identifier.test(input[field]))) return null;
  if (!smokeId.test(input.operationId as string)) return null;
  return { action: input.action, operationId: input.operationId as string,
    scope: { installationId: input.installationId as string, releaseId: input.releaseId as string,
      connectionId: input.connectionId as string, presetId: input.presetId as string } };
}

function operationState(operation: Awaited<ReturnType<IncusQualificationFixtureService["create"]>>) {
  return { id: operation.id, kind: operation.kind, state: operation.state,
    generation: operation.generation, providerOperationId: operation.providerOperationId,
    errorCode: operation.errorCode, createdAt: operation.createdAt, updatedAt: operation.updatedAt };
}

function runningHandle(status: Awaited<ReturnType<IncusQualificationFixtureService["status"]>>,
  operationId: string): LiveFixtureHandle {
  if (status.binding.desiredState !== "RUNNING" || status.binding.observedState !== "RUNNING"
    || status.fixture.bindingId !== status.binding.id) {
    throw new Error("Incus smoke fixture is not running");
  }
  return { sandboxId: status.fixture.bindingId, operationId };
}

async function exactFile(witness: IncusHostLiveWitness, handle: LiveFixtureHandle,
  path: string, expected: Uint8Array): Promise<void> {
  const exists = await witness.run(handle, ["test", "-e", path], 30_000);
  if (exists.exitCode === 1) await witness.writeFile(handle, path, expected);
  else if (exists.exitCode !== 0) throw new Error("Incus smoke guest file check failed");
  const observed = await witness.readFile(handle, path);
  if (!Buffer.from(observed).equals(Buffer.from(expected))) throw new Error("Incus smoke guest file changed");
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "The smoke action must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ code: "invalid_input", message: "Provide a JSON smoke action." }, { status: 400 });
  }
  const input = parse(await request.json().catch(() => null));
  if (!input) return json({ code: "invalid_input", message: "Provide exact smoke fixture scope and operation ID." }, { status: 400 });
  const imageRef = process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF;
  if (input.action === "compose" && !immutableImage.test(imageRef ?? "")) {
    return json({ code: "compose_fixture_unavailable",
      message: "Set a reviewed immutable Compose fixture image on the EZHarness host." }, { status: 503 });
  }
  try {
    const service = new IncusQualificationFixtureService();
    if (input.action === "status") return json(await service.status(input.scope, input.operationId));
    if (input.action === "create" || input.action === "destroy"
      || input.action === "start" || input.action === "stop") {
      const operation = input.action === "create" ? await service.create(input.scope, input.operationId)
        : input.action === "destroy" ? await service.destroy(input.scope, input.operationId)
          : await service.setPower(input.scope, input.operationId,
            input.action === "start" ? "running" : "stopped", `smoke-${input.action}`);
      return json({ operation: operationState(operation) }, { status: 202 });
    }
    const status = await service.status(input.scope, input.operationId);
    const handle: LiveFixtureHandle = { sandboxId: status.fixture.bindingId, operationId: input.operationId };
    const witness = new IncusHostLiveWitness();
    if (input.action === "inspect") return json({ inspection: await witness.inspectFixture(handle) });
    const running = runningHandle(status, input.operationId);
    if (input.action === "marker") {
      const bytes = Buffer.from(`EZHarness Incus smoke ${createHash("sha256")
        .update(JSON.stringify([input.scope, input.operationId])).digest("hex")}\n`);
      await exactFile(witness, running, markerPath, bytes);
      return json({ marker: { path: markerPath, sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") } });
    }
    const yaml = Buffer.from(`services:\n  proof:\n    image: ${imageRef}\n    command: ["sh", "-c", "printf ezh-compose-ok"]\n`);
    await exactFile(witness, running, composePath, yaml);
    const result = await witness.run(running, ["docker", "compose", "-f", composePath,
      "run", "--rm", "proof"], 120_000);
    if (result.exitCode !== 0 || result.stdout.trim() !== "ezh-compose-ok") {
      throw new Error("Incus smoke Compose fixture did not pass");
    }
    return json({ compose: { imageRef, service: "proof", exitCode: 0,
      outputMarker: "ezh-compose-ok" } });
  } catch {
    return json({ code: "smoke_unavailable",
      message: "The Incus smoke fixture is unavailable or its result is unknown. Inspect its saved status before retry." }, { status: 409 });
  }
};
