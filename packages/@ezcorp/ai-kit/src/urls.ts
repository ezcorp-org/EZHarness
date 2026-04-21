/** Canonical URL builder for EZCorp entities.
 *
 *  Pure module — no I/O, no globals. Given a `base` origin and an
 *  `EntityRef`, returns the canonical public URL a user can click to
 *  open the entity in the EZCorp web UI.
 *
 *  Routes mirror `web/src/routes/(app)/` and are the single source of
 *  truth for ai-kit tool responses. If the web app renames a route,
 *  update this file (and its unit test) — every tool response follows.
 */

export type EntityRef =
  | { kind: "conversation"; id: string; projectId: string }
  | { kind: "agent"; name: string }
  | { kind: "run"; id: string }
  | { kind: "project"; id: string };

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

export function entityUrl(base: string, ref: EntityRef): string {
  const b = stripTrailingSlash(base);
  switch (ref.kind) {
    case "conversation":
      return `${b}/project/${encodeURIComponent(ref.projectId)}/chat/${encodeURIComponent(ref.id)}`;
    case "agent":
      return `${b}/agents/${encodeURIComponent(ref.name)}`;
    case "run":
      return `${b}/runs/${encodeURIComponent(ref.id)}`;
    case "project":
      return `${b}/project/${encodeURIComponent(ref.id)}`;
  }
}
