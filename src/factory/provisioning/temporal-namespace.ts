/**
 * The retention and archival every tenant namespace is created with (C06, W15).
 *
 * W15 owns the settings: `factoryTemporalNamespaceArguments` in
 * `src/factory/temporal-retention.ts` returns the arguments for `temporal
 * operator namespace create`. The provisioner registers namespaces over gRPC,
 * so `factoryTemporalRegisterRequest` translates exactly those arguments into
 * the RegisterNamespace request, and an argument it does not recognise is
 * refused rather than dropped.
 *
 * Until W15 lands in the integration branch, the arguments come from the
 * stand-in below, which has W15's name, signature, and output. At that merge
 * the stand-in's body is replaced by a re-export of W15's function.
 */
import { FactoryProvisioningError } from "./steps";

export const FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS = 30;
const DAY_SECONDS = 86_400;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const URI = /^[a-z][a-z0-9+.-]*:\/\/\S+$/;
/** Temporal's ArchivalState enum. */
const ARCHIVAL_ENABLED = 2;

/** W15's contract, pending its merge: arguments for `temporal operator namespace create`. */
export function factoryTemporalNamespaceArguments(namespace: string, historyArchiveUri: string, visibilityArchiveUri: string): readonly string[] {
  if (!NAMESPACE.test(namespace) || !URI.test(historyArchiveUri) || !URI.test(visibilityArchiveUri)) throw new FactoryProvisioningError("temporal_namespace_arguments_invalid", "The namespace or an archive URI is malformed.");
  return Object.freeze([
    "--namespace", namespace,
    "--retention", `${FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * 24}h`,
    "--history-archival-state", "enabled", "--history-uri", historyArchiveUri,
    "--visibility-archival-state", "enabled", "--visibility-uri", visibilityArchiveUri,
  ]);
}

export interface FactoryTemporalRegisterRequest {
  readonly namespace: string;
  readonly description: string;
  readonly workflowExecutionRetentionPeriod: { readonly seconds: number };
  readonly historyArchivalState: number;
  readonly historyArchivalUri: string;
  readonly visibilityArchivalState: number;
  readonly visibilityArchivalUri: string;
}

/** The RegisterNamespace request those arguments describe. Every argument must be known and present once. */
export function factoryTemporalRegisterRequest(args: readonly string[], description: string): FactoryTemporalRegisterRequest {
  const refuse = (detail: string): never => { throw new FactoryProvisioningError("temporal_namespace_arguments_invalid", `Namespace arguments are not translatable: ${detail}.`); };
  if (args.length % 2 !== 0) refuse("an option has no value");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index]!, args[index + 1]!];
    if (!["--namespace", "--retention", "--history-archival-state", "--history-uri", "--visibility-archival-state", "--visibility-uri"].includes(flag)) refuse(`unknown option ${flag}`);
    if (values.has(flag)) refuse(`${flag} is repeated`);
    values.set(flag, value);
  }
  const retention = /^(\d+)h$/.exec(values.get("--retention") ?? "");
  if (!retention) refuse("the retention is not whole hours");
  for (const flag of ["--history-archival-state", "--visibility-archival-state"]) if (values.get(flag) !== "enabled") refuse(`${flag} is not enabled`);
  const namespace = values.get("--namespace"), history = values.get("--history-uri"), visibility = values.get("--visibility-uri");
  if (!namespace || !history || !visibility) refuse("the namespace or an archive URI is missing");
  return Object.freeze({
    namespace: namespace!, description,
    workflowExecutionRetentionPeriod: { seconds: Number(retention![1]) * 3_600 },
    historyArchivalState: ARCHIVAL_ENABLED, historyArchivalUri: history!,
    visibilityArchivalState: ARCHIVAL_ENABLED, visibilityArchivalUri: visibility!,
  });
}

/**
 * Where a namespace's archive lives. The local platform's Temporal writes a
 * file-store archive inside its own container (`temporal-archival-local`
 * readiness row: it does not survive the container). A hosted Temporal names
 * durable URIs instead.
 */
export function factoryTemporalLocalArchiveUris(namespace: string): { readonly history: string; readonly visibility: string } {
  return Object.freeze({ history: `file:///tmp/factory-temporal-archival/history/${namespace}`, visibility: `file:///tmp/factory-temporal-archival/visibility/${namespace}` });
}

export const FACTORY_TEMPORAL_RETENTION_SECONDS = FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * DAY_SECONDS;
