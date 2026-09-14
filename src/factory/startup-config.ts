/**
 * The one validated document the factory composition is built from.
 *
 * C09 requires that a missing required dependency fails startup by name. A
 * parser that throws on the first bad field satisfies the letter of that and
 * not its point: an operator with three unset paths restarts three times. So
 * this collects every absent and every malformed field and names them all in
 * one error.
 *
 * The shape is a table walked by one validator rather than a hand-written
 * predicate per field. Adding a dependency is a row, so a new dependency
 * cannot arrive with a weaker check than its neighbours, and the validator has
 * one set of branches to prove instead of one per field.
 *
 * The document carries references — paths, endpoints, identities — and never a
 * credential value, matching `parseFactoryOrchestratorProcessConfig`.
 */
import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded } from "./private-files";

export const FACTORY_STARTUP_CONFIG_SCHEMA = "factory.startup.v1";
const MAX_CONFIG_BYTES = 64 * 1024;

export interface FactoryStartupTlsMaterial {
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
}

export interface FactoryStartupStorage {
  readonly endpoint: string;
  readonly bucket: string;
  readonly prefix: string;
  /** Credential set NAME, for the failure-domain record. Never a value. */
  readonly credentialSet: string;
  /** File holding the credential set. Read at composition, never logged. */
  readonly credentialsPath: string;
}

export interface FactoryStartupConfig {
  readonly schemaVersion: typeof FACTORY_STARTUP_CONFIG_SCHEMA;
  readonly installationId: string;
  readonly tenantId: string;
  readonly poolId: string;
  readonly temporalNamespace: string;
  readonly orchestrationReadinessFilePath: string;
  readonly poolReadinessFilePath: string;
  readonly supervisorReadinessFilePath: string;
  readonly hostId: string;
  readonly readinessHeartbeatMs?: number;
  /**
   * The model this installation pins for a guest's reverse broker call.
   *
   * Optional, because an installation that runs no model-calling guest needs
   * none, and inventing a default would be the substitute the provider
   * readiness rule forbids. When present, both halves are required: a provider
   * with no model, or a model with no provider, is a half-configured pin and is
   * refused at parse rather than resolved at the first guest call.
   */
  readonly modelProvider?: { readonly provider: string; readonly model: string };
  readonly gateway: { readonly hostname: string; readonly port: number; readonly tls: FactoryStartupTlsMaterial };
  readonly privateService: { readonly hostname: string; readonly port: number; readonly certificateIdentity: string; readonly tls: FactoryStartupTlsMaterial };
  readonly pool: { readonly baseUrl: string; readonly serviceTokenPath: string; readonly tls: FactoryStartupTlsMaterial };
  readonly storage: { readonly ordinary: FactoryStartupStorage; readonly archive: FactoryStartupStorage };
  readonly keys: { readonly masterKeyFilePath: string; readonly masterKeyId: string; readonly wrappedKeyFilePath: string; readonly grantableRoots: readonly string[] };
  /**
   * Where the host launch service listens, for the process that holds no runner.
   *
   * Optional, because an installation whose runner lives in the product process
   * uses the in-process runtime and needs no transport. When present, every
   * part is required: a base URL with no client material cannot open a mutual
   * TLS connection, and half a transport is not a transport.
   */
  readonly hostLaunch?: {
    readonly baseUrl: string;
    readonly serverName: string;
    readonly attemptTokenSecretPath: string;
    readonly tls: FactoryStartupTlsMaterial & { readonly serviceTokenPath: string };
  };
  /**
   * The host PUBLIC keys a physical-stop receipt is verified against.
   *
   * By reference, never by value, and never a private key: each entry names a
   * host, a key id, and a file to read the PUBLIC key from. The product process
   * verifies signatures with these; only the host itself holds the private half,
   * and `loadFactoryHostSigningKey` on the host is the only thing that reads it.
   */
  readonly hostStopKeys?: readonly { readonly hostId: string; readonly hostKeyId: string; readonly publicKeyPath: string }[];
  /** An operator's verified replication statement. Absent on a development host. */
  readonly archiveReplicationEvidence?: string;
  readonly workers?: FactoryWorkerTuning;
}

export interface FactoryWorkerTuning {
  readonly batch?: number;
  readonly idleDelayMs?: number;
  readonly errorDelayMs?: number;
  readonly maxErrorDelayMs?: number;
}

export class FactoryStartupConfigError extends Error {
  readonly code = "factory-configuration-invalid";
  constructor(readonly missing: readonly string[], readonly invalid: readonly string[]) {
    super(`Factory startup configuration is incomplete.${missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""}${invalid.length > 0 ? ` Invalid: ${invalid.join(", ")}.` : ""}`);
    this.name = "FactoryStartupConfigError";
  }
}

type FieldKind = "identity" | "path" | "port" | "interval" | "url" | "roots" | "statement" | "count";

interface FieldSpec {
  readonly field: string;
  readonly kind: FieldKind;
  readonly optional?: boolean;
}

const TLS_FIELDS = ["caPath", "certificatePath", "privateKeyPath"] as const;

function tls(prefix: string): FieldSpec[] {
  return TLS_FIELDS.map((name) => ({ field: `${prefix}.tls.${name}`, kind: "path" as const }));
}

function storage(prefix: string): FieldSpec[] {
  return [
    { field: `${prefix}.endpoint`, kind: "url" },
    { field: `${prefix}.bucket`, kind: "identity" },
    { field: `${prefix}.prefix`, kind: "identity" },
    { field: `${prefix}.credentialSet`, kind: "identity" },
    { field: `${prefix}.credentialsPath`, kind: "path" },
  ];
}

/** Every dependency the composition needs, in one place. */
export const FACTORY_STARTUP_FIELDS: readonly FieldSpec[] = Object.freeze([
  { field: "installationId", kind: "identity" },
  { field: "tenantId", kind: "identity" },
  { field: "poolId", kind: "identity" },
  { field: "temporalNamespace", kind: "identity" },
  { field: "orchestrationReadinessFilePath", kind: "path" },
  { field: "poolReadinessFilePath", kind: "path" },
  { field: "supervisorReadinessFilePath", kind: "path" },
  { field: "hostId", kind: "identity" },
  { field: "readinessHeartbeatMs", kind: "interval", optional: true },
  { field: "modelProvider.provider", kind: "identity", optional: true },
  { field: "modelProvider.model", kind: "identity", optional: true },
  { field: "gateway.hostname", kind: "identity" },
  { field: "gateway.port", kind: "port" },
  ...tls("gateway"),
  { field: "privateService.hostname", kind: "identity" },
  { field: "privateService.port", kind: "port" },
  { field: "privateService.certificateIdentity", kind: "identity" },
  ...tls("privateService"),
  { field: "pool.baseUrl", kind: "url" },
  { field: "pool.serviceTokenPath", kind: "path" },
  ...tls("pool"),
  ...storage("storage.ordinary"),
  ...storage("storage.archive"),
  { field: "keys.masterKeyFilePath", kind: "path" },
  { field: "keys.masterKeyId", kind: "identity" },
  { field: "keys.wrappedKeyFilePath", kind: "path" },
  { field: "keys.grantableRoots", kind: "roots" },
  { field: "hostLaunch.baseUrl", kind: "url", optional: true },
  { field: "hostLaunch.serverName", kind: "identity", optional: true },
  { field: "hostLaunch.attemptTokenSecretPath", kind: "path", optional: true },
  { field: "hostLaunch.tls.caPath", kind: "path", optional: true },
  { field: "hostLaunch.tls.certificatePath", kind: "path", optional: true },
  { field: "hostLaunch.tls.privateKeyPath", kind: "path", optional: true },
  { field: "hostLaunch.tls.serviceTokenPath", kind: "path", optional: true },
  { field: "archiveReplicationEvidence", kind: "statement", optional: true },
  { field: "workers.batch", kind: "count", optional: true },
  { field: "workers.idleDelayMs", kind: "interval", optional: true },
  { field: "workers.errorDelayMs", kind: "interval", optional: true },
  { field: "workers.maxErrorDelayMs", kind: "interval", optional: true },
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read(root: Record<string, unknown>, field: string): { readonly present: boolean; readonly value: unknown } {
  let current: unknown = root;
  for (const segment of field.split(".")) {
    if (!record(current) || !Object.hasOwn(current, segment)) return { present: false, value: undefined };
    current = current[segment];
  }
  return { present: current !== undefined, value: current };
}

function wellFormed(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case "identity":
      return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
    case "path":
      return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0");
    case "port":
      return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
    case "interval":
      return Number.isSafeInteger(value) && (value as number) >= 10 && (value as number) <= 600_000;
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_024;
    case "statement":
      return typeof value === "string" && value.length >= 1 && value.length <= 512 && !value.includes("\0");
    case "roots":
      return Array.isArray(value) && value.length >= 1 && value.length <= 32
        && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4_096 && !item.includes("\0"));
    default:
      return httpsUrl(value);
  }
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** The set of leaf fields a valid document may carry, derived from the table. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(["schemaVersion", "hostStopKeys", ...FACTORY_STARTUP_FIELDS.map((spec) => spec.field)]);

/** Exactly these keys, no more and no fewer. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function leaves(value: unknown, prefix = ""): string[] {
  if (!record(value)) return [prefix];
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const field = prefix === "" ? key : `${prefix}.${key}`;
    // `grantableRoots` is an array leaf, and `hostStopKeys` an array of
    // records; recursing into either would name its indices. Both are checked
    // by shape below instead.
    if (field === "hostStopKeys") { found.push(field); continue; }
    found.push(...(record(nested) ? leaves(nested, field) : [field]));
  }
  return found;
}

/**
 * Validate one startup document, naming every problem at once.
 *
 * An unknown field is an error rather than a warning: a renamed dependency
 * that is silently ignored composes an application missing the thing the
 * operator thought they had configured.
 */
export function parseFactoryStartupConfig(value: unknown): FactoryStartupConfig {
  if (!record(value)) throw new FactoryStartupConfigError(["schemaVersion"], []);
  const missing: string[] = [];
  const invalid: string[] = [];
  if (value.schemaVersion !== FACTORY_STARTUP_CONFIG_SCHEMA) invalid.push("schemaVersion");

  for (const spec of FACTORY_STARTUP_FIELDS) {
    const { present, value: field } = read(value, spec.field);
    if (!present) {
      if (!spec.optional) missing.push(spec.field);
      continue;
    }
    if (!wellFormed(spec.kind, field)) invalid.push(spec.field);
  }
  for (const field of leaves(value)) {
    if (!KNOWN_FIELDS.has(field)) invalid.push(field);
  }
  // A model pin is both halves or neither. Half a pin is the shape that would
  // otherwise be resolved at the first guest call, which is where a missing
  // provider becomes a substitute rather than a refusal.
  const pinned = ["modelProvider.provider", "modelProvider.model"].filter((field) => read(value, field).present);
  if (pinned.length === 1) invalid.push(pinned[0] === "modelProvider.provider" ? "modelProvider.model" : "modelProvider.provider");

  // A host launch transport is every part or none. A base URL with no client
  // material cannot open a mutual TLS connection, and half a transport would
  // fail at the first dispatch rather than at boot.
  const transport = FACTORY_STARTUP_FIELDS.filter((spec) => spec.field.startsWith("hostLaunch."));
  const supplied = transport.filter((spec) => read(value, spec.field).present);
  if (supplied.length > 0 && supplied.length < transport.length) {
    for (const spec of transport) if (!supplied.includes(spec)) missing.push(spec.field);
  }

  // Host PUBLIC keys, by reference. Each entry names a host, a key id, and a
  // file; a private key never appears in this document and an empty list is a
  // list that verifies nothing.
  const hostStopKeys = read(value, "hostStopKeys");
  if (hostStopKeys.present) {
    const entries = hostStopKeys.value;
    if (!Array.isArray(entries) || entries.length === 0) invalid.push("hostStopKeys");
    else for (const [index, entry] of entries.entries()) {
      if (!record(entry) || !exactKeys(entry, ["hostId", "hostKeyId", "publicKeyPath"])
        || !wellFormed("identity", entry.hostId) || !wellFormed("identity", entry.hostKeyId) || !wellFormed("path", entry.publicKeyPath)) {
        invalid.push(`hostStopKeys[${index}]`);
      }
    }
  }
  if (missing.length > 0 || invalid.length > 0) throw new FactoryStartupConfigError(missing, invalid);

  const config = value as unknown as FactoryStartupConfig;
  // A cap below the first delay it caps would silently shorten the backoff.
  if ((config.workers?.maxErrorDelayMs ?? Number.MAX_SAFE_INTEGER) < (config.workers?.errorDelayMs ?? 0)) {
    throw new FactoryStartupConfigError([], ["workers.maxErrorDelayMs"]);
  }
  // The key material must sit outside every root an extension can be granted,
  // the same boundary `assertFactoryBootConfiguration` enforces for the secrets
  // directory. `readOperatorMasterKey` refuses it later; refusing here names it.
  for (const root of config.keys.grantableRoots) {
    const within = resolve(root);
    if (resolve(config.keys.masterKeyFilePath).startsWith(`${within}/`)) throw new FactoryStartupConfigError([], ["keys.masterKeyFilePath"]);
  }
  return Object.freeze(config);
}

/** Read the document through the private bounded reader, as the process entries do. */
export async function loadFactoryStartupConfig(path: string): Promise<FactoryStartupConfig> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  let bytes: Uint8Array;
  try {
    bytes = await readPrivateBounded(directory, basename(absolute), MAX_CONFIG_BYTES);
  } finally {
    await directory.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FactoryStartupConfigError([], ["schemaVersion"]);
  }
  return parseFactoryStartupConfig(parsed);
}
