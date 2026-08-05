/**
 * Naming rules for forking a workflow into an editable DB row.
 *
 * Pure and dependency-light so the route, the tests and any later caller
 * share one definition of what a fork is called — a second copy of the
 * suffix rule is how two forks end up fighting over the same name.
 */
import { EXTENSION_WORKFLOW_SEPARATOR, isValidWorkflowName } from "./workflow-name";

/**
 * The bare half of a possibly-namespaced workflow name.
 *
 * `WORKFLOW_NAME_RE` excludes `:` and the extension loader rejects a
 * declared name containing it, which is precisely what makes namespacing
 * structural — so a fork **cannot** keep its source name. It takes the
 * bare half: `ez-factory:docs-factory` → `docs-factory`.
 *
 * An extension name can never contain the separator either, so there is
 * always exactly one, and this split is unambiguous.
 */
export function bareWorkflowName(fullName: string): string {
  const idx = fullName.indexOf(EXTENSION_WORKFLOW_SEPARATOR);
  return idx === -1 ? fullName : fullName.slice(idx + EXTENSION_WORKFLOW_SEPARATOR.length);
}

/**
 * Longest bare name that still leaves room for a `-NN` suffix inside the
 * 64-character grammar. Truncating BEFORE suffixing is what stops a fork
 * of an already-maximal name from producing an invalid one.
 */
const MAX_BASE_LENGTH = 60;

/** Bare, then truncate — the order the suffix rule depends on. */
function forkBase(name: string): string {
  return bareWorkflowName(name).slice(0, MAX_BASE_LENGTH);
}

/**
 * May `requested` be used as the base for a fork's name?
 *
 * The single copy verb lets the author NAME the copy before the row
 * exists, so {@link pickForkName} is now handed a name it did not
 * derive. The question is asked HERE, in the module that owns the naming
 * rule, and not at the route: `pickForkName` bares and truncates and only
 * *then* consults the grammar, so a second copy of that order would drift
 * — and without the check the route answers a bad name with a **409**
 * ("could not find a free name") after 1000 identical rejections, when
 * the honest answer is a 400 the author can act on.
 */
export function isForkNameRequestable(requested: string): boolean {
  return isValidWorkflowName(forkBase(requested));
}

/**
 * Pick the fork's name: the bare source name, or the first free
 * `-2`, `-3`, … variant.
 *
 * `workflow_definitions.name` is globally unique and deliberately stays
 * that way — ownership authorizes a workflow, it never namespaces one —
 * so two projects genuinely cannot both hold `deploy`. Fork is where
 * per-project names actually arise, so this is where the collision is
 * absorbed, and the route returns the final name so the UI can show it
 * before saving rather than surprising the user afterwards.
 *
 * A fork OF A FORK is an ordinary DB→DB clone through this same
 * function: `docs-factory` → `docs-factory-2` → `docs-factory-2-2`.
 * Depth is unbounded and uninteresting; each fork is an independent row.
 */
export function pickForkName(sourceName: string, isTaken: (name: string) => boolean): string {
  const bare = forkBase(sourceName);
  if (!isTaken(bare) && isValidWorkflowName(bare)) return bare;
  // Bounded: 999 same-named forks is already pathological, and an
  // unbounded loop here would be a trivially reachable hang.
  for (let n = 2; n <= 999; n++) {
    const candidate = `${bare}-${n}`;
    if (!isTaken(candidate) && isValidWorkflowName(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name for a fork of "${sourceName}"`);
}
