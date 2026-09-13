import { apiRegistry, type ApiRouteEntry } from "../api-registry";
import type { FactoryServiceScope } from "./factory-service-token";
import { isFactoryServiceScope } from "./factory-service-token";

type RoutePolicy = ReadonlyMap<string, FactoryServiceScope | "factory-session">;

function svelteRouteId(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "[$1]");
}

function key(method: string, routeId: string): string {
  return `${method.toUpperCase()} ${routeId}`;
}

/** Build once from the same registry used by docs and route parity checks. */
export function buildFactoryServiceRoutePolicy(entries: readonly ApiRouteEntry[] | undefined): RoutePolicy {
  const policy = new Map<string, FactoryServiceScope | "factory-session">();
  if (!entries) return policy;
  for (const route of entries) {
    if (route.category !== "factories" || !route.path.startsWith("/api/factories/")) continue;
    const routeKey = key(route.method, svelteRouteId(route.path));
    if (policy.has(routeKey)) throw new Error(`Duplicate factory route policy: ${routeKey}`);
    policy.set(routeKey, isFactoryServiceScope(route.scope) ? route.scope : "factory-session");
  }
  return policy;
}

const factoryRoutes = buildFactoryServiceRoutePolicy(apiRegistry);

export function isRegisteredFactoryRoute(method: string, routeId: string | null | undefined): boolean {
  return typeof routeId === "string" && factoryRoutes.has(key(method, routeId));
}

/** Unknown, session-only, and unregistered routes fail closed. */
export function factoryServiceRouteScope(method: string, routeId: string | null | undefined): FactoryServiceScope | null {
  if (typeof routeId !== "string") return null;
  const scope = factoryRoutes.get(key(method, routeId));
  return scope && scope !== "factory-session" ? scope : null;
}
