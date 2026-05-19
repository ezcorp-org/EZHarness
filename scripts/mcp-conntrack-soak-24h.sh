#!/usr/bin/env bash
# Phase 58 / MCP-05 — Plan 58-03 — Operator-run 24h conntrack soak validation.
# Backs the documented manual-verification fallback for ROADMAP RC#2:
#   "20 concurrent MCPs × 1000 requests, 24h, count < 50% of max, zero
#    'nf_conntrack: table full' in dmesg."
#
# Usage:  ./scripts/mcp-conntrack-soak-24h.sh [duration_seconds]
# Default duration: 86400 (24h). Override for shorter local runs:
#   ./scripts/mcp-conntrack-soak-24h.sh 300   # 5-minute smoke test
#
# Exit: 0 if max(count) < 0.5 * max AND zero `nf_conntrack: table full`
#       in dmesg AFTER baseline; 1 otherwise.
#
# Requirements: bash 4+, Linux, CAP_NET_ADMIN (host or container with
# --cap-add=NET_ADMIN), bun on PATH, ~2 GB free RAM for 20 concurrent
# fixtures.
set -euo pipefail

DURATION="${1:-86400}"
MAX_FILE="/proc/sys/net/netfilter/nf_conntrack_max"
COUNT_FILE="/proc/sys/net/netfilter/nf_conntrack_count"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="/tmp/mcp-conntrack-soak-${TIMESTAMP}.log"
MCP_COUNT=20
REQ_PER_MCP=1000

if [ ! -r "${MAX_FILE}" ]; then
  echo "FAIL: ${MAX_FILE} unreadable; is /proc/sys/net/netfilter mounted?" >&2
  exit 1
fi

CONNTRACK_MAX="$(cat "${MAX_FILE}")"

echo "Starting MCP conntrack soak validation"
echo "  duration:        ${DURATION}s ($(( DURATION / 3600 ))h $(( (DURATION / 60) % 60 ))m)"
echo "  MCPs:            ${MCP_COUNT} concurrent"
echo "  requests/MCP:    ${REQ_PER_MCP}"
echo "  conntrack_max:   ${CONNTRACK_MAX}"
echo "  log root:        ${LOG_FILE}"
echo ""

DMESG_BASELINE="$(dmesg | wc -l)"
SAMPLES_FILE="$(mktemp -t mcp-conntrack-samples.XXXXXX)"
trap 'rm -f "${SAMPLES_FILE}"' EXIT

# Background sampler: every 30s snapshot count → samples file.
(while true; do
  ts="$(date -u +%s)"
  count="$(cat "${COUNT_FILE}" 2>/dev/null || echo 0)"
  echo "${ts} ${count}" >> "${SAMPLES_FILE}"
  sleep 30
done) &
SAMPLER_PID=$!

# Spawn ${MCP_COUNT} concurrent fixture MCPs in parallel.
PIDS=()
for i in $(seq 1 "${MCP_COUNT}"); do
  bun tests/fixtures/synthetic-mcp/loop.ts "${REQ_PER_MCP}" \
    > "${LOG_FILE}.${i}.out" 2> "${LOG_FILE}.${i}.err" &
  PIDS+=("$!")
done

# Wait for duration OR all children exit, whichever first.
SECONDS=0
while [ "${SECONDS}" -lt "${DURATION}" ]; do
  ALIVE=0
  for pid in "${PIDS[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      ALIVE=1
      break
    fi
  done
  [ "${ALIVE}" -eq 0 ] && break
  sleep 10
done

# Teardown: kill any leftover fixtures + sampler.
for pid in "${PIDS[@]}"; do
  kill "${pid}" 2>/dev/null || true
done
kill "${SAMPLER_PID}" 2>/dev/null || true
wait 2>/dev/null || true

# Compute results.
MAX_COUNT="$(awk '{print $2}' "${SAMPLES_FILE}" | sort -n | tail -1)"
MAX_COUNT="${MAX_COUNT:-0}"
RATIO="$(awk -v c="${MAX_COUNT}" -v m="${CONNTRACK_MAX}" \
  'BEGIN{ if (m > 0) printf "%.2f", c / m * 100; else printf "0.00" }')"
TABLE_FULL_LINES="$(dmesg | tail -n "+$((DMESG_BASELINE + 1))" \
  | grep -c 'nf_conntrack:.*table full' || true)"
TABLE_FULL_LINES="${TABLE_FULL_LINES:-0}"

echo ""
echo "===== Results ====="
echo "  peak conntrack count: ${MAX_COUNT}"
echo "  conntrack_max:        ${CONNTRACK_MAX}"
echo "  peak ratio:           ${RATIO}%"
echo "  dmesg table-full:     ${TABLE_FULL_LINES}"
echo "  per-fixture logs:     ${LOG_FILE}.<i>.{out,err} (i = 1..${MCP_COUNT})"

HALF=$(( CONNTRACK_MAX / 2 ))
if [ "${MAX_COUNT}" -lt "${HALF}" ] && [ "${TABLE_FULL_LINES}" -eq 0 ]; then
  echo "  RESULT: PASS — RC#2 criterion satisfied"
  exit 0
else
  echo "  RESULT: FAIL — RC#2 criterion VIOLATED"
  exit 1
fi
