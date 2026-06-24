export const meta = {
  name: 'feature-docs-review',
  description: 'Re-verify every docs/features doc against current source; fix confirmed inaccuracies, flag uncertainties, audit structure + cross-links',
  whenToUse: 'After changing features, before merging a docs PR, or any time you want to confirm docs/features/ has not drifted from the code.',
  phases: [
    { title: 'Discover', detail: 'resolve repo root + enumerate feature docs' },
    { title: 'Review', detail: 'one verifier per doc (gentle batches), fixes confirmed errors in place' },
    { title: 'Audit', detail: 'structure + cross-link integrity across the set' },
  ],
}

// Pass args = ["chat/conversations.md", ...] (relative to docs/features) to review only those; omit to review all.

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string' },
    verdict: { type: 'string', enum: ['accurate', 'fixed', 'needs-human'] },
    issuesFound: { type: 'array', items: { type: 'string' } },
    issuesFixed: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'array', items: { type: 'string' } },
  },
  required: ['path', 'verdict', 'issuesFound', 'issuesFixed'],
}
const DISCOVER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { root: { type: 'string' }, docs: { type: 'array', items: { type: 'string' } } },
  required: ['root', 'docs'],
}
const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { area: { type: 'string' }, ok: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } },
  required: ['area', 'ok', 'findings'],
}

phase('Discover')
const disc = await agent([
  'You are bootstrapping an EZCorp docs review. Print two things by running shell:',
  '1. The absolute repo root: `git rev-parse --show-toplevel`.',
  '2. The feature-doc list, paths RELATIVE TO docs/features/: from the repo root run',
  '   `cd docs/features && find . -name "*.md" ! -name README.md ! -name MAINTAINING.md | sed "s#^\\./##" | sort`.',
  'Return { root: <absolute repo root>, docs: [<e.g. "chat/conversations.md">, ...] }.',
].join('\n'), { label: 'discover', phase: 'Discover', schema: DISCOVER_SCHEMA })

if (!disc || !disc.root) {
  log('Discovery failed — could not resolve repo root / docs.')
  return { error: 'discovery-failed' }
}
const ROOT = disc.root
const FDIR = `${ROOT}/docs/features`
const DOCS = (Array.isArray(args) && args.length) ? args : disc.docs
log(`Reviewing ${DOCS.length} feature docs under ${FDIR}`)

const reviewPrompt = (rel) => [
  `You are an INDEPENDENT, skeptical verifier for EZCorp's feature docs. The repo is at ${ROOT}. Assume nothing — verify every claim against the real code.`,
  ``,
  `DOC: ${FDIR}/${rel}`,
  ``,
  `Procedure:`,
  `1. Read the doc. (Read ${FDIR}/MAINTAINING.md once if you need the template/convention.)`,
  `2. For EVERY factual claim, verify it against the actual source at ${ROOT}: read the files in the doc's "## Key files" section, and grep/glob for any asserted route (METHOD /path), exported symbol/function, env var, settings key, table/column, default value, or described behavior. Confirm each is real and accurately described.`,
  `3. Confirm every "Key files" path exists (ls/test) — flag any that does not.`,
  `4. FIX confirmed inaccuracies IN PLACE with the Edit tool — wrong/nonexistent paths, invented symbols, wrong route methods, incorrect behavior, stale counts. Keep edits SURGICAL and factual; keep paths repo-relative (no /home/... absolutes).`,
  `   BE CONSERVATIVE: only change something you can PROVE wrong from the code. If unsure, do NOT edit — list it under "uncertain". Never rewrite prose for style.`,
  `5. Do not touch the 8-section structure unless a section is genuinely missing.`,
  ``,
  `Note: some referenced files (e.g. the gitignored tasks/ dir, or uninstalled node_modules packages) may legitimately be absent from this checkout — treat those as "uncertain", not errors.`,
  ``,
  `Return: path (=${rel}), verdict (accurate = no inaccuracies; fixed = you corrected at least one; needs-human = a real problem you could not safely fix), issuesFound, issuesFixed, uncertain.`,
].join('\n')

const reviewOne = (rel) => agent(reviewPrompt(rel), { label: `verify:${rel}`, phase: 'Review', schema: REVIEW_SCHEMA })

// Gentle batched review with sequential retry sweep (rides under transient API throttle).
phase('Review')
const BATCH = 4
const results = []
for (let i = 0; i < DOCS.length; i += BATCH) {
  const batch = DOCS.slice(i, i + BATCH)
  const res = await parallel(batch.map(rel => () =>
    reviewOne(rel).then(r => ({ rel, r: r || null })).catch(() => ({ rel, r: null }))
  ))
  results.push(...res.filter(Boolean))
  log(`batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(DOCS.length / BATCH)} · ${results.filter(x => x.r).length}/${DOCS.length} reviewed`)
}
for (const rel of results.filter(x => !x.r).map(x => x.rel)) {
  const r = await reviewOne(rel)
  const idx = results.findIndex(x => x.rel === rel)
  if (r) results[idx] = { rel, r }
  log(`retry verify:${rel} → ${r ? (r.verdict || 'ok') : 'still-failing'}`)
}

const reviewed = results.filter(x => x.r).map(x => x.r)
const fixed = reviewed.filter(r => r.verdict === 'fixed')
const needsHuman = reviewed.filter(r => r.verdict === 'needs-human')
const unreviewable = results.filter(x => !x.r).map(x => x.rel)
log(`Reviewed ${reviewed.length}/${DOCS.length} · ${fixed.length} fixed · ${needsHuman.length} needs-human · ${unreviewable.length} unreviewable`)

// Structure + cross-link integrity audit across the set.
phase('Audit')
const audit = await agent([
  `STRUCTURE + CROSS-LINK audit of ${FDIR} (repo ${ROOT}).`,
  `Valid wiki-link slugs = the basenames (minus .md) of the feature docs. Grep all docs for [[...]] and confirm each target is a real slug (ignore literal template examples inside MAINTAINING.md).`,
  `Confirm every feature doc has the 8 sections in order (title+tagline, Intent, How it works, Usage, Key files, Features it touches, Related docs, Notes & gotchas).`,
  `Confirm no /home/ absolute paths leaked (except MAINTAINING.md's own rule text); confirm relative .md links resolve; confirm every feature doc is linked once from README.md.`,
  `Report every violation with file + problem (do not edit — report).`,
].join('\n'), { label: 'audit:structure', phase: 'Audit', schema: AUDIT_SCHEMA })

return {
  reviewed: reviewed.length,
  totalDocs: DOCS.length,
  fixed: fixed.map(r => ({ path: r.path, issuesFixed: r.issuesFixed })),
  needsHuman: needsHuman.map(r => ({ path: r.path, issuesFound: r.issuesFound, uncertain: r.uncertain || [] })),
  uncertainByDoc: reviewed.filter(r => (r.uncertain || []).length).map(r => ({ path: r.path, uncertain: r.uncertain })),
  unreviewable,
  audit,
}
