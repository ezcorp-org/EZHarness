# run12-mutants.py <worktree> <log> [spec.json]: plants each run-12 mutant alone, runs its suite, expects a failure, restores the file.
import subprocess, sys, pathlib
wt, log = sys.argv[1], sys.argv[2]
B = "/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun"
M = [
  ("a socket type", "src/factory/provisioning/kubernetes-profile.ts", 'hostPath: { path: settings.runtimeSocketPath } }', 'hostPath: { path: settings.runtimeSocketPath, type: "Socket" } }', "./src/factory/provisioning/kubernetes-profile.test.ts"),
  ("b bind waits for runner", "src/factory/runner/supervisor-process.ts", 'if (servicesConfigured && services === undefined && seen.hostKeyReady) {', 'if (servicesConfigured && services === undefined && seen.hostKeyReady && seen.runnerReady) {', "./src/factory/runner/supervisor-process.test.ts"),
  ("b held role still routes", "src/factory/runner/supervisor-services.ts", 'const runner = held === undefined ? current() : undefined;', 'const runner = current();', "./src/factory/runner/supervisor-services.test.ts"),
  ("b held answer skips auth", "src/factory/runner/supervisor-services.ts", 'learns nothing about this host\'s runtime.\n      if (!peers.has(request.peerIdentity)) return reply(401, { error: "unauthorized" });', 'learns nothing about this host\'s runtime.\n', "./src/factory/runner/supervisor-services.test.ts"),
  ("c ready without held entry", "src/factory/service-readiness.ts", 'return lifecycle !== "ready" || Object.entries(heldFacts).every(([name, declared]) => facts[name] !== false || roles.has(declared.role));', 'return true;', "./src/factory/service-readiness.test.ts"),
  ("c entry with fact true", "src/factory/service-readiness.ts", 'if (fact === undefined || facts[fact] !== false || roles.has(fields.role as string)) return false;', 'if (fact === undefined || roles.has(fields.role as string)) return false;', "./src/factory/service-readiness.test.ts"),
  ("c record reason fixed", "src/factory/runner/supervisor-process.ts", '{ held: [{ ...FACTORY_CONTAINER_RUNTIME_ROLE, reason: held }] }', '{ held: [{ ...FACTORY_CONTAINER_RUNTIME_ROLE, reason: "runner_unavailable" }] }', "./src/factory/runner/supervisor-process.test.ts"),
  ("d merge dropped", "src/factory/runtime-composition.ts", 'held: [...workerSet.held.map(factoryHeldRoleEntry), ...heldFactoryServiceRoles(results)],', 'held: [...workerSet.held.map(factoryHeldRoleEntry)],', "./src/factory/runtime-composition.test.ts"),
  ("d entry leaks seam", "src/factory/runtime-workers.ts", 'return { role: worker.role, workPackage: worker.workPackage, reason: worker.reason };', 'return { ...worker };', "./src/factory/runtime-composition.test.ts"),
  ("d probe drops host", "src/factory/service-probes.ts", 'return (record.held ?? []).map((entry) => ({ ...entry, host: hostId }));', 'return (record.held ?? []).map((entry) => ({ ...entry }));', "./src/factory/service-probes.test.ts"),
  ("d unavailable contributes", "src/factory/service-probes.ts", 'return results.flatMap((result) => (result.available ? result.held ?? [] : []));', 'return results.flatMap((result) => result.held ?? []);', "./src/factory/service-probes.test.ts"),
  ("ping any status", "src/factory/runner/supervisor-process.ts", r'/^HTTP\/1\.[01] 200 /', r'/^HTTP\/1\.[01] \d{3} /', "./src/factory/runner/supervisor-process.test.ts"),
  ("7 state beside key", "src/factory/runner/supervisor-process.ts", 'const directory = config.stateDirectory ?? dirname(config.hostKeyPath);', 'const directory = dirname(config.hostKeyPath);', "./src/factory/runner/supervisor-process.test.ts ./src/factory/provisioning/host.test.ts"),
  ("7 init omits state", "src/factory/provisioning/kubernetes-profile.ts", ', { volume: "runner-root", subPath: FACTORY_KUBERNETES_SUPERVISOR_STATE }]', ']', "./src/factory/provisioning/kubernetes-profile.test.ts ./src/factory/provisioning/host.test.ts"),
]
# An optional third argument names a JSON list of [name, file, old, new, tests] that replaces the run-12 list (merge prep, W4H-35).
if len(sys.argv) > 3:
    import json
    M = [tuple(entry) for entry in json.load(open(sys.argv[3]))]
bad = 0
with open(log, "w") as out:
  for name, rel, old, new, tests in M:
    p = pathlib.Path(wt, rel); orig = p.read_text()
    if orig.count(old) != 1: out.write(f"{name}: ANCHOR count {orig.count(old)}\n"); bad += 1; continue
    try:
      p.write_text(orig.replace(old, new))
      r = subprocess.run([B, "test", *tests.split()], cwd=wt, capture_output=True, text=True)
      fails = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("(fail)")]
      verdict = "KILLED" if r.returncode != 0 and fails else "SURVIVED"
      if verdict != "KILLED": bad += 1
      out.write(f"{name}: {verdict} rc={r.returncode} fails={len(fails)} first={fails[0][:150] if fails else '-'}\n")
    finally:
      p.write_text(orig)
print(open(log).read()); sys.exit(1 if bad else 0)
