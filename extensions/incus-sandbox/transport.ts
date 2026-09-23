import type { JsonValue } from "@ezcorp/extension-contract";
import type { IncusConnectionConfig } from "./config";

export type IncusTransportAction =
  | "probe"
  | "instance.create"
  | "instance.inspect"
  | "instance.list"
  | "instance.setPower"
  | "instance.destroy"
  | "operation.inspect"
  | "helper.file.stat"
  | "helper.file.list"
  | "helper.file.readRange"
  | "helper.file.writeAtomic"
  | "helper.file.remove"
  | "helper.process.start"
  | "helper.process.inspect"
  | "helper.process.readOutput"
  | "helper.process.cancel"
  | "endpoint.open"
  | "endpoint.close";

export interface IncusResourceTags {
  managedBy: "ezharness-incus-sandbox";
  connectionId: string;
  sandboxId?: string;
}

export interface IncusTransportRequest {
  action: IncusTransportAction;
  connectionId: string;
  deadlineMs: number;
  pins: IncusConnectionConfig;
  tags: IncusResourceTags;
  sandboxName?: string;
  idempotency?: { requestId: string; key: string };
  payload: JsonValue;
}

export interface IncusTransport {
  request(command: Readonly<IncusTransportRequest>): Promise<unknown>;
}

export type IncusTransportErrorKind =
  | "invalid"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "unsupported"
  | "deadline"
  | "unavailable"
  | "permission"
  | "resource_exhausted"
  | "internal";

export class IncusTransportError extends Error {
  readonly kind: IncusTransportErrorKind;
  readonly effect: "none" | "unknown";
  readonly operationId?: string;

  constructor(
    kind: IncusTransportErrorKind,
    message: string,
    options: { effect?: "none" | "unknown"; operationId?: string } = {},
  ) {
    super(message);
    this.name = "IncusTransportError";
    this.kind = kind;
    this.effect = options.effect ?? (
      kind === "deadline" || kind === "unavailable" || kind === "internal" ? "unknown" : "none"
    );
    this.operationId = options.operationId;
  }
}

export interface IncusProbeResult {
  serverCertificateSha256: string;
  project: string;
  profile: string;
  helperVersion: string;
  backendApi: string;
  backendVersion: string;
  architecture: "amd64" | "arm64";
  storageDriver: string;
  isolation: "container" | "virtual-machine";
  nestedCompose: boolean;
  controls: {
    restrictedProject: boolean;
    unprivileged: boolean;
    projectLimits: boolean;
    privateNetwork: boolean;
    workspaceRoot: "/workspace";
    explicitGuestUser: boolean;
    atomicFileReplace: boolean;
    durableProcesses: boolean;
    boundedOutput: boolean;
    endpointProxy: boolean;
  };
}
