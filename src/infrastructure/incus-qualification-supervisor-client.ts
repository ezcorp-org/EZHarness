import { createConnection } from "node:net";
import type { IncusQualificationScope } from "./incus-qualification";
import type { SignedRestartHandoff } from "./incus-qualification-checkpoint";
import type { LostDestroyReplyArm } from "./incus-destroy-reply-fault";

/** The socket authenticates the actual managed process with Linux SO_PEERCRED. */
export interface SupervisorRestartRequest {
  version: 1;
  action: "restart";
  runId: string;
  nonce: string;
  deadlineMs: number;
  scope: IncusQualificationScope;
  fixtureOperationId: string;
  bindingId: string;
  generation: number;
  connectionRevision: number;
  lastOperationId: string;
  beforeDigest: string;
}

const RESTART_ACK_TIMEOUT_MS = 5_000;
const RECEIPT_TIMEOUT_MS = 40_000;
const FAULT_TIMEOUT_MS = 20_000;

async function exchange(socketPath: string, message: unknown, timeoutMs: number): Promise<unknown> {
  if (!socketPath.startsWith("/") || !socketPath.length) throw new Error("Incus supervisor socket is unavailable");
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => socket.destroy(new Error("Incus supervisor timed out")), timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", chunk => {
      received += chunk.toString("utf8");
      if (received.length > 16384) return finish(new Error("Incus supervisor response is too large"));
      const end = received.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end)) as { error?: unknown };
        if (typeof response.error === "string") finish(new Error(response.error));
        else finish(undefined, response);
      } catch { finish(new Error("Incus supervisor response is invalid")); }
    });
    socket.once("error", error => finish(error));
    socket.once("end", () => finish(new Error("Incus supervisor closed the response")));
  });
}

export async function requestIncusSupervisorRestart(socketPath: string,
  request: SupervisorRestartRequest): Promise<void> {
  const response = await exchange(socketPath, request, RESTART_ACK_TIMEOUT_MS) as { accepted?: unknown };
  if (response.accepted !== true) throw new Error("Incus supervisor refused restart");
}

export async function requestIncusSupervisorReceipt(socketPath: string, runId: string,
  nonce: string, afterDigest: string, deadlineMs: number): Promise<SignedRestartHandoff> {
  const remainingMs = deadlineMs - Date.now();
  if (!Number.isSafeInteger(deadlineMs) || remainingMs <= 0) {
    throw new Error("Incus supervisor receipt deadline expired");
  }
  const response = await exchange(socketPath, {
    version: 1, action: "receipt", runId, nonce, afterDigest,
  }, Math.min(remainingMs, RECEIPT_TIMEOUT_MS)) as { receipt?: SignedRestartHandoff };
  if (!response.receipt?.payload || typeof response.receipt.signature !== "string") {
    throw new Error("Incus supervisor receipt is invalid");
  }
  return response.receipt;
}

/** Operator supervisor checks SO_PEERCRED, claimed run and exact fault arm. */
export async function requestIncusSupervisorFault(socketPath: string,
  phase: "presence" | "arm" | "readback", arm?: LostDestroyReplyArm): Promise<void> {
  if (phase !== "presence" && !arm) throw new Error("Incus fault authorization arm is unavailable");
  const remaining = arm ? arm.deadlineMs - Date.now() : FAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new Error("Incus fault authorization deadline expired");
  }
  const response = await exchange(socketPath, { version: 1, action: "fault", phase,
    ...(arm ? { arm } : {}) }, Math.min(remaining, FAULT_TIMEOUT_MS)) as { authorized?: unknown };
  if (response.authorized !== true) throw new Error("Incus operator supervisor denied fault authorization");
}
