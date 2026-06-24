---
description: Create or refresh a docs/features/ feature doc from the current source, then self-review for accuracy
argument-hint: <slug> | new <feature description> | changed
---

You maintain EZCorp's feature documentation under `docs/features/`. The whole
point of these docs is that **every claim is grounded in the code as it exists
right now** — so verification against source is mandatory, not optional.

**Read `docs/features/MAINTAINING.md` FIRST.** It is the source of truth for: the
8-section template (`# Title` + `> _tagline_`, then Intent / How it works / Usage
/ Key files / Features it touches / Related docs / Notes & gotchas), the six
domain folders (`chat` `composer` `orchestration` `extensions` `tools`
`platform`), the kebab-case slug + `[[slug]]` wiki-link convention, and the
accuracy rules. Follow it exactly. Open one existing doc (e.g.
`docs/features/chat/conversations.md`) as a quality exemplar.

Argument: `$ARGUMENTS`

Dispatch on the argument:

### (A) A doc slug (e.g. `streaming-runtime`) — REFRESH an existing doc
1. Locate `docs/features/<domain>/<slug>.md` across the domain folders.
2. Read it, then **read every path in its `## Key files` section** and grep the
   current source for each route (`METHOD /path`), exported symbol, env var,
   settings key, table/column, default, and described behavior it asserts.
3. Update the doc so every claim matches the code **as it is now**: fix changed
   routes, renamed/moved/deleted files, added or removed behavior, stale counts.
   Preserve the 8-section structure and the `[[wiki-links]]`. Keep all paths
   repo-relative (never `/home/...`).
4. Be conservative — change only what the code proves wrong; don't rewrite good
   prose for taste.

### (B) `new <feature description>` — CREATE a doc
1. Find the feature's source (grep the routes / runtime / SDK). Pick the right
   domain folder per MAINTAINING.md.
2. Choose a kebab-case `<slug>` (it becomes the wiki-link target). Create
   `docs/features/<domain>/<slug>.md` from the template, grounded entirely in the
   real source — read the files before you describe them.
3. Wire the graph: add reciprocal `[[<slug>]]` links in the related docs'
   *Features it touches*, and add the index entry to `docs/features/README.md`
   under the right domain heading as
   `- [Title](<domain>/<slug>.md) — one-line summary.`.

### (C) `changed` — REFRESH everything this branch touched
1. `git diff --name-only origin/main...HEAD` → the changed source files.
2. For each `docs/features/**/*.md`, parse its `## Key files`; if any changed file
   is referenced, the doc is a refresh candidate. List the candidates, then
   refresh each per (A). If a brand-new capability has no doc, flag it for (B).

### (D) no argument — print the three usages above and stop.

---

**Always finish with a self-review:** re-read every doc you wrote or changed and
re-verify EVERY factual claim against the source one more time — never leave an
invented path, route, or symbol. Then report which docs you created/updated and
the substantive changes (and anything you were unsure about).

For a full independent re-validation of the *entire* doc set, run the saved
workflow instead: `Workflow({ name: "feature-docs-review" })`.
