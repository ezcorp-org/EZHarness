import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, sep } from "node:path";
import { checkProjectRole } from "../auth/middleware";
import { getProject } from "../db/queries/projects";
import { getUserById } from "../db/queries/users";
import { resolveGrantPrefixCanonical } from "./permissions";
import { getExtensionProjectBinding } from "./project-binding";
import { getReleaseRuntime, resolveActiveRelease } from "./release-process";

export interface FileOrganizerEffect {
  readonly action: string;
  /** Proposal/manifest identity and version captured by the host. */
  readonly subject: string;
  readonly paths: readonly string[];
  /** Exact virtual private companion path, if this effect has one. */
  readonly privatePath?: string;
}

export interface FileOrganizerActionAuthority {
  readonly installationId: string;
  readonly userId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly bindingId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly dataDirRoot: string;
  readonly effects: readonly FileOrganizerEffect[];
}

type ActionState = {
  authority: FileOrganizerActionAuthority;
  publicEffects: Set<FileOrganizerEffect>;
  privateEffects: Set<FileOrganizerEffect>;
  admitting: boolean;
};

// Neither JSON nor a copied object can carry host action authority. Each
// frozen effect has separate, single-use public and private admissions.
const actions = new WeakMap<object, ActionState>();

export function issueFileOrganizerActionAuthority(input: FileOrganizerActionAuthority): FileOrganizerActionAuthority {
  const authority = Object.freeze({ ...input, effects: Object.freeze(input.effects.map(effect => Object.freeze({ ...effect, paths: Object.freeze([...effect.paths]) }))) });
  actions.set(authority, { authority, publicEffects: new Set(), privateEffects: new Set(), admitting: false });
  return authority;
}

function actionState(proof: unknown): ActionState | undefined {
  return proof !== null && typeof proof === "object" ? actions.get(proof) : undefined;
}

/** The PDP also matches the requested capability against the selected effect. */
export function matchesFileOrganizerActionContext(proof: unknown, extensionId: string, neededPaths: readonly string[]): boolean {
  const state = actionState(proof);
  return Boolean(state && state.authority.installationId === extensionId && neededPaths.length === 1
    && state.authority.effects.some(effect => effect.paths.includes(neededPaths[0]!) || effect.privatePath === neededPaths[0]));
}

function isWithin(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Resolve parent links without following the mutable leaf itself. */
export async function canonicalFileOrganizerPath(path: string): Promise<string | null> {
  try {
    const parent = await resolveGrantPrefixCanonical(dirname(path));
    return parent === null ? null : join(parent, basename(path));
  } catch {
    return null;
  }
}

async function canonicalScope(projectRoot: string, scope: string): Promise<{ path: string; directory: boolean } | null> {
  if (!scope) return null;
  const path = await resolveGrantPrefixCanonical(join(projectRoot, scope.replace(/\/$/, "")));
  return path !== null && isWithin(projectRoot, path) ? { path, directory: scope.endsWith("/") } : null;
}

function sealedEffect(authority: FileOrganizerActionAuthority, effect: FileOrganizerEffect): FileOrganizerEffect | undefined {
  return authority.effects.find(candidate => candidate.action === effect.action && candidate.subject === effect.subject
    && candidate.privatePath === effect.privatePath && candidate.paths.length === effect.paths.length
    && candidate.paths.every((path, index) => path === effect.paths[index]));
}

/** Both admissions recheck the same current authority. A private write cannot
 * reuse the result of an earlier check across revocation or a path change. */
async function hasLiveAuthority(authority: FileOrganizerActionAuthority, effect: FileOrganizerEffect): Promise<boolean> {
  const [active, binding, user, project, projectRoot, dataRoot, paths] = await Promise.all([
    resolveActiveRelease(authority.installationId, getReleaseRuntime()),
    getExtensionProjectBinding(authority.installationId),
    getUserById(authority.userId),
    getProject(authority.projectId),
    realpath(authority.projectRoot),
    resolveGrantPrefixCanonical(authority.dataDirRoot),
    Promise.all(effect.paths.map(canonicalFileOrganizerPath)),
  ]);
  if (user?.status !== "active" || !project?.path || projectRoot !== authority.projectRoot || dataRoot === null) return false;
  if (await realpath(project.path) !== projectRoot || await checkProjectRole({ user }, authority.projectId, "member") instanceof Response) return false;
  const installation = active.installation;
  if (installation.ownerId !== authority.userId || !installation.enabled || installation.uninstalled
    || installation.generation !== authority.generation || installation.activeReleaseId !== authority.releaseId
    || active.release.id !== authority.releaseId
    || (installation.scope !== "global" && installation.scope !== `project:${authority.projectId}`)) return false;
  if (!binding || binding.id !== authority.bindingId || binding.ownerId !== authority.userId
    || binding.projectId !== authority.projectId || binding.releaseId !== authority.releaseId
    || binding.generation !== authority.generation) return false;
  const scopes = await Promise.all(binding.writePaths.map(scope => canonicalScope(projectRoot, scope)));
  if (scopes.some(scope => scope === null)) return false;
  return paths.every((path, index) => path !== null && path === effect.paths[index] && !isWithin(dataRoot, path)
    && scopes.some(scope => scope !== null && (scope.directory ? isWithin(scope.path, path) : scope.path === path)));
}

async function admitEffect(proof: unknown, userId: string | null, effect: FileOrganizerEffect, privatePath?: string): Promise<boolean> {
  const state = actionState(proof);
  if (!state || state.admitting || userId === null || state.authority.userId !== userId) return false;
  const sealed = sealedEffect(state.authority, effect);
  if (!sealed) return false;
  const privateWrite = privatePath !== undefined;
  const used = privateWrite ? state.privateEffects : state.publicEffects;
  if (used.has(sealed)) return false;
  if (privateWrite && (sealed.privatePath !== privatePath
    || !(privatePath === "/data" || privatePath.startsWith("/data/")) || posix.normalize(privatePath) !== privatePath
    || (sealed.paths.length > 0 && !state.publicEffects.has(sealed)))) return false;
  state.admitting = true;
  try {
    if (!await hasLiveAuthority(state.authority, sealed)) return false;
    used.add(sealed);
    return true;
  } catch {
    return false;
  } finally {
    state.admitting = false;
  }
}

export function admitFileOrganizerEffect(proof: unknown, userId: string | null, effect: FileOrganizerEffect): Promise<boolean> {
  return admitEffect(proof, userId, effect);
}

export function admitFileOrganizerPrivateEffect(proof: unknown, userId: string | null, effect: FileOrganizerEffect, path: string): Promise<boolean> {
  return admitEffect(proof, userId, effect, path);
}
