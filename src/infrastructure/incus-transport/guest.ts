import { createHash } from "node:crypto";
import { IncusTransportError, type IncusTransport, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { decodeGuestResponse, encodeGuestRequest, guestHelperSha256, GUEST_HELPER_PATH, GUEST_HELPER_VERSION, GuestProtocolError, type GuestAction } from "../incus-guest/protocol";
import { metadata, resourceName, withSession, type Session } from "./lifecycle";
import { openPinnedWebSocket, type PinnedWebSocket } from "./pinned-websocket";
import { object, verifiedHttpsRequest, type HostConnectionResolver, type HostConnectionScope, type PinnedFetch } from "./transport";

const actions = new Map<string, GuestAction>([
  ["helper.file.stat", "file.stat"], ["helper.file.list", "file.list"], ["helper.file.readRange", "file.readRange"],
  ["helper.file.writeAtomic", "file.writeAtomic"], ["helper.file.remove", "file.remove"],
  ["helper.process.start", "process.start"], ["helper.process.inspect", "process.inspect"],
  ["helper.process.readOutput", "process.readOutput"], ["helper.process.cancel", "process.cancel"],
]);
const mutationKinds = new Map<string, "fileRemove" | "processCancel">([
  ["helper.file.remove", "fileRemove"], ["helper.process.cancel", "processCancel"],
]);
const mutations = new Set(["helper.file.writeAtomic", "helper.file.remove", "helper.process.start", "helper.process.cancel"]);

function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function unexpected(message: string): never { throw new IncusTransportError("unavailable", message); }
function denied(message: string): never { throw new IncusTransportError("permission", message); }
function helperFailure(error: unknown): IncusTransportError {
  if (error instanceof IncusTransportError) return error;
  if (error instanceof GuestProtocolError) return new IncusTransportError(error.kind, "Guest helper rejected the request");
  return new IncusTransportError("unavailable", "Guest helper request failed");
}
function stableId(command: IncusTransportRequest): string {
  const seed = `${command.connectionId}\0${command.tags.sandboxId}\0${command.action}\0${command.idempotency?.requestId}\0${command.idempotency?.key}`;
  return `ezh-guest-${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}
function receipt(command: IncusTransportRequest, kind: "fileRemove" | "processCancel") {
  return { ok: true as const, receipt: { operationId: stableId(command), kind, requestId: command.idempotency!.requestId,
    idempotencyKey: command.idempotency!.key, sandboxId: command.tags.sandboxId!, acceptedAt: new Date().toISOString() } };
}
function operation(reply: Record<string, unknown>, sandboxName: string): { id: string; fds: Record<string, unknown> } {
  const value = object(reply.metadata);
  const operationId = value.id;
  if (typeof operationId !== "string" || !/^[a-f0-9-]{36}$/.test(operationId)) unexpected("Invalid Incus exec operation");
  const resources = object(value.resources);
  const instances = resources.instances;
  if (!Array.isArray(instances) || !instances.some(item => typeof item === "string" && new URL(item, "https://incus.invalid").pathname === `/1.0/instances/${sandboxName}`)) denied("Incus exec operation escaped sandbox scope");
  const fds = object(object(value.metadata).fds);
  for (const channel of ["0", "1", "2", "control"]) if (typeof fds[channel] !== "string" || !/^[a-f0-9]{64}$/.test(fds[channel])) unexpected("Invalid Incus exec channel");
  return { id: operationId, fds };
}

/** Runs only the fixed, versioned guest helper in a verified Incus instance. */
export class HostIncusGuestTransport implements IncusTransport {
  constructor(private readonly connections: HostConnectionResolver, private readonly scope: HostConnectionScope,
    private readonly http: PinnedFetch = verifiedHttpsRequest,
    private readonly websocket: (session: Session, operationId: string, secret: string) => Promise<PinnedWebSocket> = openPinnedWebSocket) {}

  async request(command: Readonly<IncusTransportRequest>): Promise<unknown> {
    const action = actions.get(command.action);
    if (!action) throw new IncusTransportError("unsupported", "Incus guest action is unavailable");
    const approved = this.scope.approvedGuest;
    if (!approved || !id(approved.user) || approved.user !== command.pins.guestUser || command.pins.helperVersion !== GUEST_HELPER_VERSION
      || approved.helperSha256 !== guestHelperSha256() || !Number.isSafeInteger(approved.uid) || approved.uid < 1 || approved.uid > 65535
      || !Number.isSafeInteger(approved.gid) || approved.gid < 1 || approved.gid > 65535) denied("Incus guest helper is not approved");
    if (!command.tags.sandboxId || command.sandboxName !== resourceName(command.connectionId, command.tags.sandboxId)) denied("Incus sandbox identity changed");
    const input = object(command.payload);
    let request: Buffer;
    try { request = encodeGuestRequest({ ...input, action, sandboxId: command.tags.sandboxId, user: approved.user,
      ...(command.idempotency ? { requestId: command.idempotency.requestId, idempotencyKey: command.idempotency.key } : {}) }); }
    catch (error) { throw helperFailure(error); }
    const operationIdentity = mutations.has(command.action) ? stableId(command) : undefined;
    let execAttempted = false;
    try {
      return await withSession(this.connections, this.scope, this.http, command, async session => {
        const project = encodeURIComponent(session.connection.project);
        const instancePath = `/1.0/instances/${command.sandboxName}`;
        const found = object(metadata(await session.request("GET", `${instancePath}?project=${project}`)));
        const config = object(found.config);
        if (found.name !== command.sandboxName || found.status !== "Running"
          || config["user.ezharness.managed_by"] !== "ezharness-incus-sandbox"
          || config["user.ezharness.connection_id"] !== command.connectionId
          || config["user.ezharness.sandbox_id"] !== command.tags.sandboxId
          || config["volatile.base_image"] !== this.scope.approvedPreset?.imageFingerprint
          || !Array.isArray(found.profiles) || !found.profiles.includes(this.scope.approvedPreset?.incusProfile)) denied("Incus guest instance is not ready or owned");
        execAttempted = true;
        const posted = await session.request("POST", `${instancePath}/exec?project=${project}`, {
          command: [GUEST_HELPER_PATH], user: approved.uid, group: approved.gid, cwd: "/workspace",
          environment: { HOME: "/workspace", PATH: "/usr/local/bin:/usr/bin:/bin" },
          "wait-for-websocket": true, interactive: false, "record-output": false,
        });
        if (posted.status !== 202 || posted.envelope.type !== "async") unexpected("Incus guest exec was not accepted");
        const exec = operation(posted.envelope, command.sandboxName!);
        const sockets = await Promise.all(["0", "1", "2", "control"].map(channel => this.websocket(session, exec.id, exec.fds[channel] as string)));
        try {
          const [stdin, stdout, stderr] = sockets;
          const stdoutPromise = stdout!.readAll();
          const stderrPromise = stderr!.readAll();
          stdin!.send(request);
          stdin!.finish();
          const [output, errors] = await Promise.all([stdoutPromise, stderrPromise]);
          if (errors.length > 8 * 1024) unexpected("Incus helper stderr is too large");
          const wait = object(metadata(await session.request("GET", `/1.0/operations/${exec.id}/wait?timeout=30&project=${project}`)));
          if (wait.id !== exec.id) denied("Incus exec operation identity changed");
          const result = object(wait.metadata);
          if (wait.status !== "Success" || result.return !== 0) throw new IncusTransportError("unsupported", "Incus guest helper could not run");
          let decoded: Record<string, unknown>;
          try { decoded = decodeGuestResponse(output); }
          catch (error) { throw helperFailure(error); }
          const { version: _version, ok: _ok, ...response } = decoded;
          const kind = mutationKinds.get(command.action);
          return kind ? receipt(command, kind) : { ok: true, ...response };
        } finally { for (const socket of sockets) socket.close(); }
      });
    } catch (error) {
      const failure = helperFailure(error);
      if (operationIdentity && execAttempted) throw new IncusTransportError(failure.kind, "Guest mutation outcome is unknown", { effect: "unknown", operationId: operationIdentity });
      throw failure;
    }
  }
}
