# W4H-35 (integrator-5, 2026-10-23; team-lead F1 after the hold REJECT 140d80ad6e954716; a named copy of W4H-34's extra-legs.sh
# 1e33e813998a66fb): the Kubernetes hosted profile, GPU/CPU-only profiles and wrapped keys, merge b701cf0e2 onto integ/w00 802d46288.
# hold-w4f.sh runs its standard legs plus leg (b) lane-forms and leg (e) sdk-digest (mandatory). Beyond those (file_leg: a listed file
# that is missing fails by name); no price-chart line (team-lead's ruling for every later extra-legs file):
NOTEST=1 leg build-packages bun run build:packages
tc_leg typecheck-all bun run typecheck
NOTEST=1 leg lint bun run lint
NOTEST=1 leg check-boundaries bun scripts/check-boundaries.ts
NOTEST=1 leg factory-boundaries bun scripts/check-factory-boundaries.ts
NOTEST=1 leg schema-drift bun scripts/check-schema-generate-drift.ts
# - hold leg (a) (team-lead's ruling): the isolated release build of every bundled extension (the bootstrap's path), BINDING with the
#   folder's expected-red set, EMPTY (W4H-33b fixed D1; all 28 must build).
NOTEST=1 file_leg bundle-build src/__tests__/helpers/first-party-release.ts bun evidence/w00/bundle-build-leg.ts --expected "$D/expected-bundle-findings.txt"
# - hold leg (c) (team-lead's ruling; validator OK by hash 08f67ac75a1ba3e9): the owner's freeze leg 1 (D3), the hosted job's own command
#   (ci.yml "Mutation (changed files)": BASE_REF=origin/main bun scripts/mutation.ts --changed --report-only), PLUS the check that every
#   mutant had tests run (w00/mutation-tested-check.ts); it replaces the bare mutation-changed line (the same Stryker run, once).
NOTEST=1 file_leg mutation-lane scripts/mutation.ts bash evidence/w00/mutation-lane-leg.sh
# - the LANE-BOUND pg suite of this merge (w00/pg-class.py: lane-pg.txt = alert-evaluator.integration; the factory-real lane; Podman +
#   PostgreSQL + the pinned Prometheus image), taken OUT of unit.txt and run here explicitly through pg (the hold's own pg15), evidence under the folder:
mkdir -p "$D/w4h35-evidence"
# - the Prometheus evaluator (team-lead's PROMETHEUS RULING): the pinned image is on the host by digest (checked 2026-10-23, no pull)
#   and STAYS on the host. NO pull and NO rmi in the hold: a presence check by digest first, then the evaluator under
#   the folder's pull-never.conf (podman pull_policy "never"; an absent image fails, it is not pulled).
PROM=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["prometheus"])' scripts/test-images.json)
NOTEST=1 leg w4h35-prom-present bash -c 'echo "image $1"; got=$(podman image inspect --format "{{.Digest}}" "$1") || { echo "ABSENT: refused, no pull"; exit 1; }; echo "digest $got"; [ "$got" = "${1#*@}" ] || { echo "DIGEST DIFFERS from the pin"; exit 1; }' _ "$PROM"
file_leg w4h35-evaluator src/factory/observability/alert-evaluator.integration.test.ts pg env CONTAINERS_CONF_OVERRIDE="$D/pull-never.conf" W4H34_EVIDENCE_DIR="$D/w4h35-evidence" bun test --timeout <PID> ./src/factory/observability/alert-evaluator.integration.test.ts
# - the preview-isolation proof with the merge's own production image (W4H-33b's v4 form), image built and removed by name:
PIMG=localhost/integrator3-img-production:${M:0:12}
NOTEST=1 leg preview-image bash evidence/w00/image-leg.sh "$M" full
file_leg preview-isolation-proof scripts/verify-shipping-preview-isolation.sh env EZ_PRODUCTION_IMAGE="$PIMG" EZ_PRODUCTION_RECEIPT_DIR="$D/preview-receipt" timeout 2400 bash scripts/verify-shipping-preview-isolation.sh
# - hold leg (d) (team-lead's ruling; validator OK by hash 8e7840962c70b77c): the same proof under the HOSTED conmon form (the pinned static
#   conmon 2.2.1 without journald, log_driver journald, a leg-private override), with the same image; its own receipt dir.
file_leg preview-hosted-conmon scripts/lib/extension-runner-conmon.sh bash evidence/w00/preview-hosted-conmon-leg.sh "$PIMG" "$D/preview-hosted-conmon-receipt"
NOTEST=1 leg preview-image-rm podman rmi "$PIMG"
