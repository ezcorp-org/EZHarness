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
  /**
   * How often the host maintenance daemon sweeps orphaned legacy runs.
   *
   * Required, and at most `FACTORY_ORPHAN_DETECTION_BOUND_MS`. It is declared
   * here rather than inferred because the daemon's own default is one hour and
   * an installation that runs factories has agreed to a thirty-second bound.
   */
  readonly orphanSweepIntervalMs: number;
  readonly readinessHeartbeatMs?: number;
  /**
   * How long startup keeps probing a service that is not up yet.
   *
   * Absent means one round. Present, admission stays closed and the private
   * service stays bound while the probes repeat, which is what lets a
   * distributed bring-up converge instead of being decided by start order.
   */
  readonly readinessRetry?: { readonly delayMs: number; readonly windowMs: number };
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
  readonly privateService: {
    readonly hostname: string;
    readonly port: number;
    readonly certificateIdentity: string;
    readonly tls: FactoryStartupTlsMaterial;
    /**
     * Who may command this installation, and with which signing keys.
     *
     * Present only on an installation that runs a Node orchestrator, because
     * the private service is the endpoint that orchestrator calls back on.
     * Absent, the product starts no private listener and the orchestrator's own
     * readiness probe fails — which keeps admission closed rather than opening
     * it for a run nothing can advance. All three fields or none.
     */
    readonly tokens?: { readonly issuer: string; readonly audience: string; readonly publicKeyPaths: Readonly<Record<string, string>> };
  };
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
  /**
   * The runners this installation will dispatch to, and what each one costs.
   *
   * One declaration serves two collaborators, which is why it is one section.
   * `FactoryNativeRunnerPolicy` turns a `dispatch-node` command into a runner
   * request only for a runner named here, and `FactoryTaskAdmission` turns a
   * `request-admission` command into a pool request using the same profile's
   * allocation, keyed by its resource class. Both are deployment facts: nothing
   * in a factory definition can say what a CPU second costs on this host.
   *
   * An installation that declares none cannot admit or dispatch a task, so its
   * private service does not compose and the reason is reported by name.
   */
  readonly runnerProfiles?: {
    /** The audience a guest's broker token is minted for. */
    readonly brokerAudience: string;
    readonly profiles: readonly FactoryStartupRunnerProfile[];
  };
  /**
   * Where a release may publish, and which adapter publishes to which one.
   *
   * The last deployment fact the factory needed and did not have. A release
   * provider binds a destination — `S3FactoryManifestReleaseProvider` refuses
   * any account but its own configured one, `FactoryGitHubReleaseProvider`
   * takes a repository — so with nothing declared there is nowhere to publish
   * and `release-outcome` holds. Nothing in a factory definition can say which
   * bucket or repository this installation owns.
   *
   * Optional, because an installation that publishes nothing needs none, and a
   * default would publish to a place nobody declared. Present, both halves are
   * required: destinations with no profile name nothing, and a profile with no
   * destinations has nowhere to send.
   *
   * Credentials are by REFERENCE only. Every path here is read at composition
   * through the private bounded reader, which refuses a file that is missing,
   * not a regular file, not owned by this process, or readable by anyone else.
   * No credential value appears in this document.
   */
  readonly release?: {
    readonly destinations: readonly FactoryStartupReleaseDestination[];
    readonly profiles: readonly FactoryStartupReleaseProfile[];
  };
  readonly workers?: FactoryWorkerTuning;
}

/**
 * One place a release may publish, named so a profile can point at it.
 *
 * `name` is this document's own handle for the destination and never reaches
 * the wire; what reaches the wire is the provider's account, which is the
 * bucket's account or the repository. Two destinations may not share a name,
 * because a profile naming one of them would then depend on declaration order.
 */
export type FactoryStartupReleaseDestination =
  | {
      readonly name: string;
      readonly kind: "s3";
      readonly endpoint: string;
      readonly bucket: string;
      /** Matched against the operation's `destination.account`. */
      readonly account: string;
      readonly prefix?: string;
      /** The credential SET file, by reference. Read privately, never logged. */
      readonly credentialsPath: string;
    }
  | {
      readonly name: string;
      readonly kind: "github";
      /** `owner/name`, matched against the operation's `destination.account`. */
      readonly repository: string;
      /** The token file, by reference. Read privately per call, never logged. */
      readonly tokenPath: string;
    };

/**
 * One definition's release-node adapter, and the destination it publishes to.
 *
 * `FactoryProtectedCommandEffects` keys its profile set by a digest of the
 * adapter reference, so the adapter here is the same five fields a definition's
 * release node names. What the deployment adds is the destination and the cost:
 * neither is a fact a factory definition can state.
 */
export interface FactoryStartupReleaseProfile {
  readonly adapter: {
    readonly package: string;
    readonly manifestName: string;
    readonly version: string;
    readonly digest: string;
    readonly export: string;
  };
  /** The protected action this profile owns, as the definition names it. */
  readonly action: string;
  /** The `name` of a declared destination. An undeclared one is refused. */
  readonly destination: string;
  /** What one release through this adapter is budgeted to cost, in micros. */
  readonly estimatedSpendMicros: number;
}

export interface FactoryStartupRunnerProfile {
  readonly runner: {
    readonly package: string;
    readonly manifestName: string;
    readonly version: string;
    readonly digest: string;
    readonly export: string;
  };
  readonly resourceClass: string;
  readonly allocation: {
    readonly resources: Readonly<Record<string, number>>;
    readonly memoryBytes: number;
    readonly budget: { readonly costMicros: string; readonly tokens: number; readonly computeMs: number };
  };
  readonly allowedCapabilities: readonly string[];
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
  { field: "orphanSweepIntervalMs", kind: "interval" },
  { field: "readinessHeartbeatMs", kind: "interval", optional: true },
  { field: "readinessRetry.delayMs", kind: "interval", optional: true },
  { field: "readinessRetry.windowMs", kind: "interval", optional: true },
  { field: "modelProvider.provider", kind: "identity", optional: true },
  { field: "modelProvider.model", kind: "identity", optional: true },
  { field: "gateway.hostname", kind: "identity" },
  { field: "gateway.port", kind: "port" },
  ...tls("gateway"),
  { field: "privateService.hostname", kind: "identity" },
  { field: "privateService.port", kind: "port" },
  { field: "privateService.certificateIdentity", kind: "identity" },
  ...tls("privateService"),
  { field: "privateService.tokens.issuer", kind: "statement", optional: true },
  { field: "privateService.tokens.audience", kind: "statement", optional: true },
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

/** A signing key map: one key id to one file, at least one entry. */
function wellFormedKeyPaths(value: unknown): boolean {
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length >= 1 && entries.length <= 32
    && entries.every(([kid, path]) => wellFormed("identity", kid) && wellFormed("path", path));
}

/** One runner this installation dispatches to, with its allocation. */
function wellFormedRunnerProfile(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["runner", "resourceClass", "allocation", "allowedCapabilities"])) return false;
  const runner = value.runner;
  const runnerKeys = ["package", "manifestName", "version", "digest", "export"];
  if (!record(runner) || !exactKeys(runner, runnerKeys)
    || runnerKeys.some((key) => typeof runner[key] !== "string" || (runner[key] as string).length === 0 || (runner[key] as string).length > 512)
    || !/^sha256:[a-f0-9]{64}$/.test(runner.digest as string)) return false;
  if (!wellFormed("identity", value.resourceClass)) return false;
  if (!Array.isArray(value.allowedCapabilities) || value.allowedCapabilities.length > 64
    || value.allowedCapabilities.some((capability) => !wellFormed("identity", capability))
    || new Set(value.allowedCapabilities).size !== value.allowedCapabilities.length) return false;
  return wellFormedResourceProfile(value.allocation);
}

/**
 * An S3 prefix, which is a key path and not an identity.
 *
 * The same rules `factoryS3PublicationDirectory` enforces when it builds the
 * key, so a prefix this document accepts is one the provider will also accept:
 * no empty segment, no `.` or `..`, no leading or trailing slash. Validating it
 * as an identity refused every realistic prefix, which a real startup found.
 */
function wellFormedS3Prefix(value: unknown): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}$/.test(value)) return false;
  return !value.includes("//") && !value.endsWith("/") && !value.split("/").some((part) => part === "." || part === "..");
}

/** A repository this installation may publish to, as `owner/name`. */
function wellFormedRepository(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
}

/**
 * One declared destination, by kind.
 *
 * `exactKeys` per kind rather than a shared optional bag: an S3 destination
 * carrying a `tokenPath`, or a GitHub one carrying a `bucket`, is an operator
 * who edited the wrong entry, and reading past it would compose a provider
 * against half a declaration.
 */
function wellFormedReleaseDestination(value: unknown): boolean {
  if (!record(value) || !wellFormed("identity", value.name)) return false;
  if (value.kind === "s3") {
    const required = ["name", "kind", "endpoint", "bucket", "account", "credentialsPath"];
    if (!exactKeys(value, required) && !exactKeys(value, [...required, "prefix"])) return false;
    return httpsUrl(value.endpoint) && wellFormed("identity", value.bucket) && wellFormed("identity", value.account)
      && (value.prefix === undefined || wellFormedS3Prefix(value.prefix)) && wellFormed("path", value.credentialsPath);
  }
  if (value.kind === "github") {
    return exactKeys(value, ["name", "kind", "repository", "tokenPath"])
      && wellFormedRepository(value.repository) && wellFormed("path", value.tokenPath);
  }
  return false;
}

/** One adapter reference, its action, its destination, and its cost. */
function wellFormedReleaseProfile(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["adapter", "action", "destination", "estimatedSpendMicros"])) return false;
  const adapter = value.adapter;
  const adapterKeys = ["package", "manifestName", "version", "digest", "export"];
  if (!record(adapter) || !exactKeys(adapter, adapterKeys)
    || adapterKeys.some((key) => typeof adapter[key] !== "string" || (adapter[key] as string).length === 0 || (adapter[key] as string).length > 512)
    || !/^sha256:[a-f0-9]{64}$/.test(adapter.digest as string)) return false;
  // A micro-denominated release cost is bounded well above a runner budget and
  // well below a safe integer, so the policy ledger's addition cannot overflow.
  return wellFormed("identity", value.action) && wellFormed("identity", value.destination)
    && Number.isSafeInteger(value.estimatedSpendMicros) && (value.estimatedSpendMicros as number) >= 0
    && (value.estimatedSpendMicros as number) <= 1_000_000_000_000;
}

/** A task's pool vector, its memory, and the budget it may spend. */
function wellFormedResourceProfile(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["resources", "memoryBytes", "budget"])) return false;
  const resources = value.resources;
  if (!record(resources) || Object.keys(resources).length === 0
    || Object.entries(resources).some(([name, amount]) => !wellFormed("identity", name) || !Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > 1_000_000)) return false;
  if (!Number.isSafeInteger(value.memoryBytes) || (value.memoryBytes as number) < 1) return false;
  const budget = value.budget;
  // `costMicros` is decimal TEXT rather than a number: a micro-denominated cost
  // can exceed a safe integer, and the budget ledger stores it as text for
  // exactly that reason.
  return record(budget) && exactKeys(budget, ["costMicros", "tokens", "computeMs"])
    && typeof budget.costMicros === "string" && /^[0-9]{1,30}$/.test(budget.costMicros)
    && Number.isSafeInteger(budget.tokens) && (budget.tokens as number) >= 0
    && Number.isSafeInteger(budget.computeMs) && (budget.computeMs as number) >= 0;
}

/** The set of leaf fields a valid document may carry, derived from the table. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion", "hostStopKeys", "privateService.tokens.publicKeyPaths", "runnerProfiles",
  "release.destinations", "release.profiles",
  ...FACTORY_STARTUP_FIELDS.map((spec) => spec.field),
]);

/** One adapter reference as a comparable string, for the duplicate scan. */
function canonicalAdapter(value: unknown): string {
  if (!record(value)) return JSON.stringify(value);
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

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
    // Three branches are maps whose KEYS are data — a key id, a resource class
    // — so recursing into them would name a value as a field. Each is checked
    // by shape below instead.
    if (field === "hostStopKeys" || field === "runnerProfiles" || field === "privateService.tokens.publicKeyPaths"
      || field === "release.destinations" || field === "release.profiles") { found.push(field); continue; }
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
  // The private service's token verifier is all three fields or none: an issuer
  // with no keys verifies nothing, and a key map with no audience would accept
  // a token minted for another service.
  // Both halves or neither: a delay with no window would retry forever and a
  // window with no delay would spin.
  const retryFields = ["readinessRetry.delayMs", "readinessRetry.windowMs"];
  const retryPresent = retryFields.filter((field) => read(value, field).present);
  if (retryPresent.length === 1) missing.push(retryFields.find((field) => !retryPresent.includes(field))!);

  const tokenFields = ["privateService.tokens.issuer", "privateService.tokens.audience", "privateService.tokens.publicKeyPaths"];
  const tokensPresent = tokenFields.filter((field) => read(value, field).present);
  if (tokensPresent.length > 0 && tokensPresent.length < tokenFields.length) {
    for (const field of tokenFields) if (!tokensPresent.includes(field)) missing.push(field);
  }
  const publicKeyPaths = read(value, "privateService.tokens.publicKeyPaths");
  if (publicKeyPaths.present && !wellFormedKeyPaths(publicKeyPaths.value)) invalid.push("privateService.tokens.publicKeyPaths");

  const runners = read(value, "runnerProfiles");
  if (runners.present) {
    const section = runners.value;
    if (!record(section) || !exactKeys(section, ["brokerAudience", "profiles"]) || !wellFormed("identity", section.brokerAudience)
      || !Array.isArray(section.profiles) || section.profiles.length === 0 || section.profiles.length > 64) {
      invalid.push("runnerProfiles");
    } else {
      for (const [index, profile] of section.profiles.entries()) {
        if (!wellFormedRunnerProfile(profile)) invalid.push(`runnerProfiles.profiles[${index}]`);
      }
      // A resource class named twice would make the admission profile map
      // depend on declaration order, which is not a fact an operator states.
      const classes = section.profiles.map((profile) => (profile as { resourceClass?: unknown }).resourceClass);
      if (new Set(classes).size !== classes.length) invalid.push("runnerProfiles.profiles");
    }
  }
  // Where a release may publish. Both halves or neither: destinations nothing
  // points at publish nothing, and a profile with no destinations has nowhere
  // to send — and either half alone reads as configured while refusing at the
  // first release.
  const releaseHalves = ["release.destinations", "release.profiles"];
  const releasePresent = releaseHalves.filter((field) => read(value, field).present);
  if (releasePresent.length === 1) missing.push(releaseHalves.find((field) => !releasePresent.includes(field))!);
  if (releasePresent.length === 2) {
    const destinations = read(value, "release.destinations").value;
    const profiles = read(value, "release.profiles").value;
    let names: string[] | undefined;
    if (!Array.isArray(destinations) || destinations.length === 0 || destinations.length > 64) invalid.push("release.destinations");
    else {
      for (const [index, entry] of destinations.entries()) {
        if (!wellFormedReleaseDestination(entry)) invalid.push(`release.destinations[${index}]`);
      }
      names = destinations.map((entry) => (entry as { name?: unknown }).name).filter((name): name is string => typeof name === "string");
      // A name declared twice makes "which destination" depend on declaration
      // order, which is not a fact an operator stated.
      if (new Set(names).size !== names.length) invalid.push("release.destinations");
    }
    if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 64) invalid.push("release.profiles");
    else {
      const declared = new Set(names ?? []);
      for (const [index, entry] of profiles.entries()) {
        if (!wellFormedReleaseProfile(entry)) { invalid.push(`release.profiles[${index}]`); continue; }
        // A profile pointing at a destination nobody declared would compose a
        // profile with nowhere to publish, and `requestRelease` would refuse it
        // at the first release instead of at boot.
        if (names !== undefined && !declared.has((entry as { destination: string }).destination)) invalid.push(`release.profiles[${index}].destination`);
      }
      // Two profiles for one adapter make the trusted set depend on order, and
      // `FactoryProtectedCommandEffects` refuses the second at construction.
      const adapters = profiles.map((entry) => canonicalAdapter((entry as { adapter?: unknown }).adapter));
      if (new Set(adapters).size !== adapters.length) invalid.push("release.profiles");
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
