// bundle-build-leg.ts (integrator-5, 2026-10-16; team-lead's ruling after hosted ci 38974581371 D1): the ISOLATED RELEASE BUILD of every bundled
// extension, by the product's own path, as the bundled bootstrap of the production image runs it: resolveBundledExtensions() (the
// shipped list, its disable flags honoured) and, for each, buildFirstPartyRelease(name) = snapshotFirstPartyExtension + PodmanRunner.build
// with buildLimits (the runner runs the package's feature tests in the build container: a failed, skipped or missing test fails the build).
// Run from the repo root of the tree under test, with bun, ONLY in the heavy lock (rootless Podman).
// Usage: bun bundle-build-leg.ts [--only a,b] [--expected <file>]
// --expected (team-lead's ruling option 1, 2026-10-16): an EXACT expected-red set, one line per bundle: '<name><TAB><fixed text>[<TAB><fixed text>...]';
// '#' and blank lines ignored. A listed bundle must FAIL with every listed text in its diagnostics ('EXPECTED <name>: matched');
// a listed bundle that builds ('RED <name>: EXPECTED failure missing'), fails without the texts ('RED <name>: EXPECTED failure unmatched'),
// or any unlisted failure ('RED <name>: unexpected failure') is red by name. Without --expected, every failure is red.
// Prints "BUNDLE-BUILD <name>: succeeded <manifest name>" (the product helper returns the manifest, not the artifact digest) or "BUNDLE-BUILD <name>: FAILED <diagnostics>"; exit 1 on any failure, 2 when no
// extension was built (an empty list is a red, never a pass).
const root = process.cwd();
const only = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? new Set(process.argv[i + 1].split(",")) : undefined; })();
const { resolveBundledExtensions } = await import(`${root}/src/extensions/bundled.ts`);
const { buildFirstPartyRelease } = await import(`${root}/src/__tests__/helpers/first-party-release.ts`);
const expected = new Map<string, string[]>();
{ const i = process.argv.indexOf("--expected"); if (i > 0) for (const line of (await Bun.file(process.argv[i + 1]).text()).split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue; const [name, ...texts] = line.split("\t"); expected.set(name, texts.filter(Boolean)); } }
const names: string[] = resolveBundledExtensions().map((entry: { name: string }) => entry.name).filter((name: string) => !only || only.has(name));
let failed = 0, built = 0, red = 0;
for (const name of names) {
  try {
    const release = await buildFirstPartyRelease(name);
    try { console.log(`BUNDLE-BUILD ${name}: succeeded ${release.manifest?.name ?? name}`); built++; } finally { await release.close(); }
    if (expected.has(name)) { red++; console.log(`RED ${name}: EXPECTED failure missing (it built)`); }
  } catch (error) {
    const text = String((error as Error)?.message ?? error); failed++; console.log(`BUNDLE-BUILD ${name}: FAILED ${text.slice(0, 2000)}`);
    const want = expected.get(name);
    if (!want) { red++; console.log(`RED ${name}: unexpected failure`); }
    else if (want.length === 0 || !want.every((t) => text.includes(t))) { red++; console.log(`RED ${name}: EXPECTED failure unmatched (needs: ${JSON.stringify(want)})`); }
    else console.log(`EXPECTED ${name}: matched`);
  }
}
for (const name of expected.keys()) if (!names.includes(name)) { red++; console.log(`RED ${name}: EXPECTED bundle not in the list`); }
console.log(`bundle-build: ${names.length} bundled extension(s), ${built} succeeded, ${failed} failed, ${expected.size} expected, ${red} red`);
process.exit(names.length === 0 ? 2 : red > 0 ? 1 : 0);
