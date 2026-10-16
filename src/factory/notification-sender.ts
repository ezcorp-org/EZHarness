/**
 * The outbound notification sender (C11 N1–N9, W4H-34).
 *
 * The in-app inbox already delivers `factory_notifications`; "delivered" there
 * means a human can read it in the product. This role carries three of those
 * kinds off this host to each declared webhook destination, through its own
 * C02 queue (`factory_notification_sends`), so a 24-hour approval window is
 * not silent.
 *
 * Exactly-once is logical, not physical: every request carries a stable
 * `Idempotency-Key`, the destination must deduplicate on it (N3), and a sender
 * that stops between the send and the settlement leaves a lease the next claim
 * takes back as a new, bounded attempt (N7). So a re-drive repeats the request
 * and never the notification.
 *
 * Nothing secret leaves this module in a value it returns or throws: errors
 * carry codes only, and the payload is built from an allowlist (N4, N9).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import {
  DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, intervalHeartbeat,
  type DurableDeadLetter, type DurableDeliveryRecord, type DurableDeliveryStore, type LeaseHeartbeat,
} from "../delivery-queue/durable-delivery-queue";
import { assertFactoryIdentity } from "./factory-identity";
import { readPrivatePath, readPrivateText } from "./private-files";
import { decodeNotification, type FactoryNotification, type NotificationRow } from "./releases";
import type { FactoryRoleConfirmation, FactoryRoleDriver } from "./runtime-seams";
import type { FactoryStartupNotificationDestination } from "./startup-config";

export const FACTORY_NOTIFICATION_SCHEMA = "factory.notification.v1";

/** The kinds that leave this host. `release_settled` stays in the inbox. */
export const FACTORY_NOTIFICATION_SENT_KINDS = Object.freeze(["approval_requested", "command_approval_requested", "release_uncertain"] as const);
export type FactoryNotificationSentKind = (typeof FACTORY_NOTIFICATION_SENT_KINDS)[number];

/** C11 N5. */
export const FACTORY_NOTIFICATION_SEND_BOUNDS = Object.freeze({
  leaseMs: 30_000,
  requestTimeoutMs: 10_000,
  maxAttempts: 8,
  expiryMs: 86_400_000,
  payloadMaxBytes: 4_096,
  fanOutBatch: 16,
});

/** C11 N6, by the settlement each code leads to. */
export const FACTORY_NOTIFICATION_SEND_CODES = Object.freeze({
  retry: Object.freeze(["webhook_unreachable", "webhook_timeout", "webhook_status_429", "webhook_status_5xx"] as const),
  deadLetter: Object.freeze(["webhook_rejected_4xx", "attempts_exhausted", "notification_payload_invalid", "notification_payload_too_large", "factory_notification_corrupt"] as const),
  cancelled: Object.freeze(["notification_expired", "destination_removed"] as const),
});

export const FACTORY_NOTIFICATION_HEADERS = Object.freeze({
  signature: "x-ezcorp-signature",
  timestamp: "x-ezcorp-timestamp",
  delivery: "x-ezcorp-delivery-id",
  idempotency: "idempotency-key",
});

export class FactoryNotificationSendError extends Error {
  /** The declared destination's name, when the error is about one; never its URL or secret. */
  destination?: string;
  constructor(readonly code: string, readonly deadLetter = false) {
    super(`Factory notification send failed: ${code}.`);
    this.name = "FactoryNotificationSendError";
  }
}

/** The N3 secret bounds, in bytes. */
const SECRET_MIN_BYTES = 32;
const SECRET_MAX_BYTES = 512;
const CA_MAX_BYTES = 65_536;

/** Why readiness holds a declared, composed sender until a receiver accepts a send (N8). */
export const FACTORY_NOTIFICATION_PENDING_REASON = "a notification destination is declared and the sender runs, but no receiver has confirmed a delivery yet; the role reads running from the first confirmed delivery";

/** The one body shape a destination receives (C11 N4). */
export interface FactoryNotificationPayload {
  readonly schema: typeof FACTORY_NOTIFICATION_SCHEMA;
  readonly idempotencyKey: string;
  readonly kind: FactoryNotificationSentKind;
  readonly projectId: string;
  readonly notificationId: string;
  readonly operationId?: string;
  readonly approvalId?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly outcomeCode?: string;
  readonly inboxPath: string;
}

export interface FactoryNotificationSend extends DurableDeliveryRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly notificationId: string;
  readonly destination: string;
  readonly deduplicationId: string;
  readonly inputHash: string;
  readonly expiresAt: number;
  readonly payload: FactoryNotificationPayload;
}

/** One declared destination with its secret already read; never logged or returned. */
export interface FactoryNotificationDestinationRuntime {
  readonly name: string;
  readonly url: string;
  readonly secret: Uint8Array;
  readonly ca?: string;
}

export interface FactoryWebhookRequest {
  readonly url: string;
  readonly ca?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Sends one request and answers its status. The body of the answer is never read. */
export type FactoryWebhookTransport = (request: FactoryWebhookRequest) => Promise<{ readonly status: number }>;

export const fetchFactoryWebhook: FactoryWebhookTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: "manual",
    ...(request.ca === undefined ? {} : { tls: { ca: request.ca } }),
  } as RequestInit);
  await response.body?.cancel();
  return { status: response.status };
};

const OUTCOME_CODE = /^[a-z0-9_]{1,64}$/;

/** Stable for one notification and destination, across every attempt and every sender. */
export function factoryNotificationIdempotencyKey(tenantId: string, projectId: string, notificationId: string, destination: string): string {
  return `fn1-${createHash("sha256").update([tenantId, projectId, notificationId, destination].join("\0")).digest("hex")}`;
}

export function signFactoryNotification(secret: Uint8Array, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** The release store's own identity rule (`assertFactoryIdentity`), so every identifier it stored can be sent. */
function identifier(value: unknown): string {
  try { assertFactoryIdentity(value as string); } catch { throw new FactoryNotificationSendError("notification_payload_invalid", true); }
  return value as string;
}

function isSentKind(kind: string): kind is FactoryNotificationSentKind {
  return (FACTORY_NOTIFICATION_SENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The payload and expiry of one notification for one destination, or null for
 * a kind that does not leave this host. Every field is named here; nothing is
 * copied from the stored record as a whole, so a field added to a notification
 * later cannot ride out unreviewed.
 */
export function factoryNotificationPayload(
  notification: FactoryNotification,
  destination: string,
  commandDeadlineMs?: number,
): { readonly payload: FactoryNotificationPayload; readonly expiresAt: number } | null {
  if (!isSentKind(notification.kind)) return null;
  const stored = (notification.payload ?? {}) as Record<string, unknown>;
  const fallbackExpiry = notification.createdAt + FACTORY_NOTIFICATION_SEND_BOUNDS.expiryMs;
  let expiresAt = fallbackExpiry;
  const subject: { operationId?: string; approvalId?: string; outcomeCode?: string } = {};
  if (notification.kind === "command_approval_requested") {
    subject.approvalId = identifier(notification.approvalId);
    if (Number.isSafeInteger(commandDeadlineMs)) expiresAt = commandDeadlineMs!;
  } else {
    subject.operationId = identifier(notification.operationId);
    if (notification.kind === "approval_requested") {
      subject.approvalId = identifier(stored.approvalId);
      if (Number.isSafeInteger(stored.expiresAtMs)) expiresAt = stored.expiresAtMs as number;
    } else if (typeof stored.code === "string" && OUTCOME_CODE.test(stored.code)) {
      subject.outcomeCode = stored.code;
    }
  }
  const projectId = identifier(notification.projectId);
  const payload: FactoryNotificationPayload = {
    schema: FACTORY_NOTIFICATION_SCHEMA,
    idempotencyKey: factoryNotificationIdempotencyKey(notification.tenantId, projectId, notification.id, destination),
    kind: notification.kind,
    projectId,
    notificationId: identifier(notification.id),
    ...(subject.operationId === undefined ? {} : { operationId: subject.operationId }),
    ...(subject.approvalId === undefined ? {} : { approvalId: subject.approvalId }),
    createdAt: new Date(notification.createdAt).toISOString(),
    ...(notification.kind === "release_uncertain" ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
    ...(subject.outcomeCode === undefined ? {} : { outcomeCode: subject.outcomeCode }),
    inboxPath: `/api/factories/projects/${encodeURIComponent(projectId)}/release/notifications`,
  };
  // Identifiers of up to 512 characters each can, escaped, pass 4 KiB together; such a
  // notification is refused rather than truncated, and the fan-out records the refusal.
  if (Buffer.byteLength(canonicalJson(payload)) > FACTORY_NOTIFICATION_SEND_BOUNDS.payloadMaxBytes) throw new FactoryNotificationSendError("notification_payload_too_large", true);
  return { payload, expiresAt };
}

/** The keys a send is recorded under; a decoded notification has them, and so does a refused row. */
type RefusedNotification = Pick<FactoryNotification, "tenantId" | "projectId" | "id" | "createdAt"> & { readonly kind: FactoryNotification["kind"] };

/**
 * What a refused notification's dead-letter send records: the keys an operator
 * looks it up by, never sent anywhere. The kind is the stored one, which the
 * fan-out's filter has already limited to the kinds that leave this host.
 */
function refusedPayload(notification: RefusedNotification, destination: string): FactoryNotificationPayload {
  return {
    schema: FACTORY_NOTIFICATION_SCHEMA,
    idempotencyKey: factoryNotificationIdempotencyKey(notification.tenantId, notification.projectId, notification.id, destination),
    kind: notification.kind as FactoryNotificationSentKind,
    projectId: notification.projectId,
    notificationId: notification.id,
    createdAt: new Date(notification.createdAt).toISOString(),
    inboxPath: "",
  };
}

/** The settlement a webhook answer leads to; null means delivered. */
export function classifyFactoryWebhookStatus(status: number): FactoryNotificationSendError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 408) return new FactoryNotificationSendError("webhook_timeout");
  if (status === 429) return new FactoryNotificationSendError("webhook_status_429");
  if (status >= 500 && status < 600) return new FactoryNotificationSendError("webhook_status_5xx");
  return new FactoryNotificationSendError("webhook_rejected_4xx", true);
}

function retryCode(error: unknown): string | DurableDeadLetter | null {
  if (!(error instanceof FactoryNotificationSendError)) return null;
  return error.deadLetter ? { deadLetter: error.code } : error.code;
}

type SendRow = {
  project_id: string; send_id: string; notification_id: string; destination: string; deduplication_id: string; input_hash: string;
  state: FactoryNotificationSend["state"]; attempts: number | string; max_attempts: number | string; available_at: number | string;
  lease_until: number | string; lease_token: string | null; failure_code: string | null; expires_at: number | string; payload: string; created_at: number | string;
};

const SEND_COLUMNS = sql.raw("project_id,send_id,notification_id,destination,deduplication_id,input_hash,state,attempts,max_attempts,available_at,lease_until,lease_token,failure_code,expires_at,payload,created_at");

function decodeSend(row: SendRow, tenantId: string): FactoryNotificationSend {
  let payload: FactoryNotificationPayload;
  try { payload = JSON.parse(row.payload) as FactoryNotificationPayload; } catch { throw new FactoryNotificationSendError("notification_send_corrupt"); }
  if (durableInputHash(payload) !== row.input_hash || payload.notificationId !== row.notification_id || payload.projectId !== row.project_id) throw new FactoryNotificationSendError("notification_send_corrupt");
  return {
    id: row.send_id, tenantId, projectId: row.project_id, notificationId: row.notification_id, destination: row.destination,
    deduplicationId: row.deduplication_id, inputHash: row.input_hash, state: row.state, attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
    availableAt: Number(row.available_at), leaseUntil: Number(row.lease_until), ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }), expiresAt: Number(row.expires_at), payload, createdAt: Number(row.created_at),
  };
}

/** The C02 store over `factory_notification_sends`, for one tenant (one scope). */
export function factoryNotificationSendStore(database: MigrationDb, tenantId: string): DurableDeliveryStore<FactoryNotificationSend> {
  const check = (scope: string | null): void => { if (scope !== tenantId) throw new FactoryNotificationSendError("notification_send_scope"); };
  const one = async (query: ReturnType<typeof sql>): Promise<FactoryNotificationSend | null> => {
    const row = rows<SendRow>(await database.execute(query))[0];
    return row ? decodeSend(row, tenantId) : null;
  };
  return {
    async findDuplicate(scope, deduplicationId) { check(scope); return one(sql`SELECT ${SEND_COLUMNS} FROM factory_notification_sends WHERE tenant_id=${tenantId} AND deduplication_id=${deduplicationId}`); },
    async insert(record) {
      return rows(await database.execute(sql`INSERT INTO factory_notification_sends (tenant_id,project_id,send_id,notification_id,destination,deduplication_id,input_hash,state,attempts,max_attempts,available_at,lease_until,failure_code,expires_at,payload,created_at)
        VALUES (${tenantId},${record.projectId},${record.id},${record.notificationId},${record.destination},${record.deduplicationId},${record.inputHash},${record.state},${record.attempts},${record.maxAttempts},${record.availableAt},${record.leaseUntil},${record.failureCode ?? null},${record.expiresAt},${canonicalJson(record.payload)},${record.createdAt})
        ON CONFLICT (tenant_id,deduplication_id) DO NOTHING RETURNING send_id`)).length === 1;
    },
    async claimCandidate(scope, now) {
      check(scope);
      return one(sql`SELECT ${SEND_COLUMNS} FROM factory_notification_sends WHERE tenant_id=${tenantId} AND ((state='queued' AND available_at<=${now}) OR (state='leased' AND lease_until<=${now})) ORDER BY available_at,send_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    },
    async findById(scope, id) { check(scope); return one(sql`SELECT ${SEND_COLUMNS} FROM factory_notification_sends WHERE tenant_id=${tenantId} AND send_id=${id} FOR UPDATE`); },
    async write(record) {
      await database.execute(sql`UPDATE factory_notification_sends SET state=${record.state},attempts=${record.attempts},available_at=${record.availableAt},lease_until=${record.leaseUntil},lease_token=${record.leaseToken ?? null},failure_code=${record.failureCode ?? null},updated_at=NOW() WHERE tenant_id=${tenantId} AND send_id=${record.id}`);
    },
    async inspect(scope, id) { check(scope); return one(sql`SELECT ${SEND_COLUMNS} FROM factory_notification_sends WHERE tenant_id=${tenantId} AND send_id=${id}`); },
  };
}

const sendQueue = new DurableDeliveryQueue<FactoryNotificationSend>((code) => new FactoryNotificationSendError(code), randomUUID);

type FanOutRow = NotificationRow & { project_id: string; notification_id: string; kind: FactoryNotificationSentKind; created_ms: number | string; deadline_at_ms: number | string | null };

export interface FactoryNotificationSenderOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly destinations: readonly FactoryNotificationDestinationRuntime[];
  readonly transport?: FactoryWebhookTransport;
  readonly now?: () => number;
  /** Tests shorten the lease and the request timeout to observe them; production keeps the N5 bounds. */
  readonly leaseMs?: number;
  readonly requestTimeoutMs?: number;
  readonly heartbeat?: LeaseHeartbeat<FactoryNotificationSend>["start"];
}

/**
 * The `notification-send` role's driver. `confirmed()` answers whether any
 * receiver has ever accepted a send for this tenant, from the durable table,
 * so readiness keeps the role held until a delivery is proven (N8) and a
 * restart does not forget one.
 */
export class FactoryNotificationSender implements FactoryRoleDriver {
  private readonly database: TransactionalDb;
  private readonly tenantId: string;
  private readonly destinations: ReadonlyMap<string, FactoryNotificationDestinationRuntime>;
  private readonly transport: FactoryWebhookTransport;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeat: LeaseHeartbeat<FactoryNotificationSend>["start"];
  private isConfirmed = false;
  private readonly listeners = new Set<() => void>();
  readonly confirmation: FactoryRoleConfirmation = {
    confirmed: () => this.isConfirmed,
    onConfirmed: (listener) => this.onConfirmed(listener),
    pendingReason: FACTORY_NOTIFICATION_PENDING_REASON,
  };

  constructor(options: FactoryNotificationSenderOptions) {
    if (options.destinations.length === 0) throw new FactoryNotificationSendError("notification_destination_missing");
    this.database = options.database;
    this.tenantId = options.tenantId;
    this.destinations = new Map(options.destinations.map((destination) => [destination.name, destination]));
    this.transport = options.transport ?? fetchFactoryWebhook;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? FACTORY_NOTIFICATION_SEND_BOUNDS.leaseMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? FACTORY_NOTIFICATION_SEND_BOUNDS.requestTimeoutMs;
    this.heartbeat = options.heartbeat ?? intervalHeartbeat(this.leaseMs);
  }

  /** Reads the durable confirmation once; a sender built before it sees none until `refreshConfirmation`. */
  async refreshConfirmation(): Promise<boolean> {
    if (this.isConfirmed) return true;
    const found = rows(await this.database.execute(sql`SELECT 1 FROM factory_notification_sends WHERE tenant_id=${this.tenantId} AND state='delivered' LIMIT 1`)).length === 1;
    if (found) this.markConfirmed();
    return this.isConfirmed;
  }

  confirmed(): boolean { return this.isConfirmed; }

  /** Called once, when the first durable delivery is seen. Returns the unsubscribe. */
  onConfirmed(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private markConfirmed(): void {
    if (this.isConfirmed) return;
    this.isConfirmed = true;
    for (const listener of this.listeners) listener();
  }

  /** One bounded pass: fan out new notifications, then send at most one. */
  async step(signal: AbortSignal): Promise<boolean> {
    // The durable answer, so a restart does not forget an earlier delivery.
    if (!this.isConfirmed) await this.refreshConfirmation();
    const fannedOut = await this.fanOut(signal);
    const sent = await this.sendOne(signal);
    return fannedOut || sent;
  }

  /** Adds the missing send rows, at most one batch per destination. */
  async fanOut(signal: AbortSignal): Promise<boolean> {
    let added = false;
    for (const destination of this.destinations.keys()) {
      signal.throwIfAborted();
      const found = rows<FanOutRow>(await this.database.execute(sql`
        SELECT n.project_id,n.notification_id,n.payload,n.state,n.input_hash,(n.payload::jsonb->>'kind') AS kind,
          (EXTRACT(EPOCH FROM n.created_at) * 1000)::bigint AS created_ms,ca.deadline_at_ms
        FROM factory_notifications n
        LEFT JOIN factory_command_approvals ca ON (n.payload::jsonb->>'kind')='command_approval_requested'
          AND ca.tenant_id=n.tenant_id AND ca.project_id=n.project_id AND ca.approval_id=(n.payload::jsonb->>'approvalId')
        WHERE n.tenant_id=${this.tenantId} AND n.state='delivered'
          AND (n.payload::jsonb->>'kind') IN ('approval_requested','command_approval_requested','release_uncertain')
          AND NOT EXISTS (SELECT 1 FROM factory_notification_sends s WHERE s.tenant_id=n.tenant_id AND s.project_id=n.project_id AND s.notification_id=n.notification_id AND s.destination=${destination})
        ORDER BY n.available_at,n.notification_id LIMIT ${FACTORY_NOTIFICATION_SEND_BOUNDS.fanOutBatch}`));
      for (const row of found) {
        // The keys a refusal is recorded under come from the row itself, so a
        // stored notification that no longer decodes is recorded too.
        const keys: RefusedNotification = { tenantId: this.tenantId, projectId: row.project_id, id: row.notification_id, kind: row.kind, createdAt: Number(row.created_ms) };
        let notification: FactoryNotification;
        let built: ReturnType<typeof factoryNotificationPayload>;
        try {
          notification = decodeNotification(row, this.tenantId, row.project_id);
          built = factoryNotificationPayload(notification, destination, row.deadline_at_ms === null ? undefined : Number(row.deadline_at_ms));
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (!(error instanceof FactoryNotificationSendError) && code !== "factory_notification_corrupt") throw error;
          // Recorded once, in dead letter, so one unsendable notification never
          // occupies the fan-out's batch again and the ones behind it still go.
          await this.enqueue(keys, destination, refusedPayload(keys, destination), keys.createdAt, code as string);
          added = true;
          continue;
        }
        if (built === null) continue;
        await this.enqueue(notification, destination, built.payload, built.expiresAt);
        added = true;
      }
    }
    return added;
  }

  private async enqueue(notification: RefusedNotification, destination: string, payload: FactoryNotificationPayload, expiresAt: number, refused?: string): Promise<void> {
    const now = this.now();
    const inputHash = durableInputHash(payload);
    const expired = expiresAt <= now;
    const settled = refused !== undefined ? { state: "dead_letter" as const, failureCode: refused }
      : expired ? { state: "cancelled" as const, failureCode: "notification_expired" } : { state: "queued" as const };
    await this.database.transaction((transaction) => sendQueue.enqueue(factoryNotificationSendStore(transaction, this.tenantId), {
      scope: this.tenantId,
      deduplicationId: `${notification.projectId}:${notification.id}:${destination}`,
      inputHash,
      hashExisting: (record) => record.inputHash,
      create: () => ({
        id: randomUUID(), tenantId: this.tenantId, projectId: notification.projectId, notificationId: notification.id, destination,
        deduplicationId: `${notification.projectId}:${notification.id}:${destination}`, inputHash, payload, expiresAt,
        // One that cannot be sent is recorded in dead letter, and one that expired
        // before it could be sent as cancelled: the fan-out never visits either again.
        ...settled,
        attempts: 0, maxAttempts: FACTORY_NOTIFICATION_SEND_BOUNDS.maxAttempts, availableAt: now, leaseUntil: 0, createdAt: now,
      }),
    }));
  }

  private transact<Result>(work: (store: DurableDeliveryStore<FactoryNotificationSend>) => Promise<Result>): Promise<Result> {
    return this.database.transaction((transaction) => work(factoryNotificationSendStore(transaction, this.tenantId)));
  }

  /** Claims one send and settles it. True when a send was claimed, whatever its outcome. */
  async sendOne(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    let claimedAny = false;
    const claim = async (): Promise<FactoryNotificationSend | null> => {
      const claimed = await this.transact((store) => sendQueue.claim(store, this.tenantId, this.now(), this.leaseMs, { expiredLease: "reclaim" }));
      if (claimed === null) return null;
      claimedAny = true;
      // Expired, or its destination is no longer declared: cancelled under the
      // lease just taken, so the settlement is fenced like any other.
      const cancel = claimed.expiresAt <= this.now() ? "notification_expired" : this.destinations.has(claimed.destination) ? null : "destination_removed";
      if (cancel === null) return claimed;
      await this.transact((store) => sendQueue.settle(store, this.tenantId, claimed, this.now(), "cancelled", cancel));
      return null;
    };
    const settled = await dispatchDurableDelivery<FactoryNotificationSend, "dead_letter">(
      claim,
      (record, outcome, code) => this.transact((store) => sendQueue.settle(store, this.tenantId, record, this.now(), outcome, code)),
      (record) => this.deliver(record, signal),
      retryCode,
      { start: this.heartbeat, renew: (record) => this.transact((store) => sendQueue.renew(store, this.tenantId, record, this.now(), this.leaseMs)) },
    );
    if (settled?.state === "delivered") this.markConfirmed();
    return claimedAny;
  }

  private async deliver(record: FactoryNotificationSend, signal: AbortSignal): Promise<void> {
    const destination = this.destinations.get(record.destination)!;
    const body = canonicalJson(record.payload);
    const timestamp = Math.floor(this.now() / 1000);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    let status: number;
    try {
      ({ status } = await this.transport({
        url: destination.url,
        ...(destination.ca === undefined ? {} : { ca: destination.ca }),
        headers: {
          "content-type": "application/json",
          [FACTORY_NOTIFICATION_HEADERS.signature]: signFactoryNotification(destination.secret, timestamp, body),
          [FACTORY_NOTIFICATION_HEADERS.timestamp]: String(timestamp),
          [FACTORY_NOTIFICATION_HEADERS.delivery]: record.id,
          [FACTORY_NOTIFICATION_HEADERS.idempotency]: record.payload.idempotencyKey,
        },
        body,
        signal: AbortSignal.any([signal, timeout]),
      }));
    } catch {
      // The transport's own error can quote the URL; only the code leaves.
      throw new FactoryNotificationSendError(timeout.aborted ? "webhook_timeout" : "webhook_unreachable");
    }
    const failure = classifyFactoryWebhookStatus(status);
    if (failure !== null) throw failure;
  }
}

/**
 * Every declared destination with its secret and CA read, or a typed refusal
 * naming the destination. All or nothing: a sender that silently dropped one
 * destination would read as configured while that destination hears nothing.
 */
export async function loadFactoryNotificationDestinations(declared: readonly FactoryStartupNotificationDestination[]): Promise<FactoryNotificationDestinationRuntime[]> {
  const loaded: FactoryNotificationDestinationRuntime[] = [];
  for (const destination of declared) {
    const refuse = (code: string): never => {
      const error = new FactoryNotificationSendError(code);
      error.destination = destination.name;
      throw error;
    };
    let secret: Uint8Array;
    try { secret = await readPrivatePath(destination.secretPath, SECRET_MAX_BYTES); } catch { return refuse("factory_notification_secret_unreadable"); }
    if (secret.byteLength < SECRET_MIN_BYTES) refuse("factory_notification_secret_invalid");
    let ca: string | undefined;
    if (destination.caPath !== undefined) {
      try { ca = await readPrivateText(destination.caPath, CA_MAX_BYTES); } catch { return refuse("factory_notification_ca_unreadable"); }
    }
    loaded.push({ name: destination.name, url: destination.url, secret, ...(ca === undefined ? {} : { ca }) });
  }
  return loaded;
}

/**
 * The installation's sender, or why `notification-send` holds. Undeclared is
 * neither: the role's own reason names the missing declaration.
 */
export async function composeFactoryNotificationSender(
  declared: readonly FactoryStartupNotificationDestination[] | undefined,
  database: TransactionalDb,
  tenantId: string,
  report: (role: string, error: unknown) => void,
): Promise<{ readonly sender?: FactoryNotificationSender; readonly held?: string }> {
  if (declared === undefined) return {};
  try {
    const destinations = await loadFactoryNotificationDestinations(declared);
    return { sender: new FactoryNotificationSender({ database, tenantId, destinations }) };
  } catch (error) {
    report("notification-sender", error);
    const { code, destination } = error as FactoryNotificationSendError;
    return { held: `notification destination '${destination}' did not compose (${code}); the role holds until its secret and CA can be read` };
  }
}
