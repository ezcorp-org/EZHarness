import { createConnection } from "node:net";
import type { IncusQualificationScope } from "./incus-qualification";
import type { SignedRestartHandoff } from "./incus-qualification-checkpoint";

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

async function exchange(socketPath: string, message: unknown, timeoutMs = 5000): Promise<unknown> {
  if (!socketPath.startsWith("/") || !socketPath.length) throw new Error("Incus supervisor socket is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Incus supervisor deadline expired");
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
  const response = await exchange(socketPath, request) as { accepted?: unknown };
  if (response.accepted !== true) throw new Error("Incus supervisor refused restart");
}

export function supervisorReceiptTimeoutMs(deadlineMs: number, nowMs: number): number {
  const remainingMs = deadlineMs - nowMs;
  if (!Number.isSafeInteger(deadlineMs) || !Number.isSafeInteger(nowMs) || remainingMs <= 0) {
    throw new Error("Incus supervisor deadline expired");
  }
  return Math.min(remainingMs, 20_000);
}

export async function requestIncusSupervisorReceipt(socketPath: string, runId: string,
  nonce: string, afterDigest: string, deadlineMs: number): Promise<SignedRestartHandoff> {
  const timeoutMs = supervisorReceiptTimeoutMs(deadlineMs, Date.now());
  const response = await exchange(socketPath, {
    version: 1, action: "receipt", runId, nonce, afterDigest,
  }, timeoutMs) as { receipt?: SignedRestartHandoff };
  if (!response.receipt?.payload || typeof response.receipt.signature !== "string") {
    throw new Error("Incus supervisor receipt is invalid");
  }
  return response.receipt;
}
