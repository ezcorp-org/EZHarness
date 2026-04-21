#!/usr/bin/env bash
# Master test runner: executes all test suites and reports unified results.
set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BACKEND_EXIT=0
WEB_EXIT=0
E2E_EXIT=0

echo -e "${YELLOW}======================================${NC}"
echo -e "${YELLOW}  Docker Test Runner — All Suites${NC}"
echo -e "${YELLOW}======================================${NC}"
echo ""

# --- Suite 1: Backend Unit Tests ---
echo -e "${YELLOW}[1/3] Backend unit tests (src/__tests__)${NC}"
START=$(date +%s)
bash scripts/test.sh 2>&1
BACKEND_EXIT=$?
END=$(date +%s)
BACKEND_TIME=$((END - START))
if [ $BACKEND_EXIT -eq 0 ]; then
  echo -e "${GREEN}  ✓ Backend tests passed (${BACKEND_TIME}s)${NC}"
else
  echo -e "${RED}  ✗ Backend tests failed (${BACKEND_TIME}s)${NC}"
fi
echo ""

# --- Suite 2: Web Unit Tests ---
echo -e "${YELLOW}[2/3] Web unit tests (web/src/__tests__)${NC}"
START=$(date +%s)
bash scripts/test-web.sh 2>&1
WEB_EXIT=$?
END=$(date +%s)
WEB_TIME=$((END - START))
if [ $WEB_EXIT -eq 0 ]; then
  echo -e "${GREEN}  ✓ Web unit tests passed (${WEB_TIME}s)${NC}"
else
  echo -e "${RED}  ✗ Web unit tests failed (${WEB_TIME}s)${NC}"
fi
echo ""

# --- Suite 3: E2E Tests ---
echo -e "${YELLOW}[3/3] E2E Playwright tests (web/e2e)${NC}"
START=$(date +%s)
cd web && bunx playwright test 2>&1
E2E_EXIT=$?
cd ..
END=$(date +%s)
E2E_TIME=$((END - START))
if [ $E2E_EXIT -eq 0 ]; then
  echo -e "${GREEN}  ✓ E2E tests passed (${E2E_TIME}s)${NC}"
else
  echo -e "${RED}  ✗ E2E tests failed (${E2E_TIME}s)${NC}"
fi
echo ""

# --- Summary ---
echo -e "${YELLOW}======================================${NC}"
echo -e "${YELLOW}  Summary${NC}"
echo -e "${YELLOW}======================================${NC}"
[ $BACKEND_EXIT -eq 0 ] && echo -e "  Backend:  ${GREEN}PASS${NC} (${BACKEND_TIME}s)" || echo -e "  Backend:  ${RED}FAIL${NC} (${BACKEND_TIME}s)"
[ $WEB_EXIT -eq 0 ]     && echo -e "  Web:      ${GREEN}PASS${NC} (${WEB_TIME}s)"     || echo -e "  Web:      ${RED}FAIL${NC} (${WEB_TIME}s)"
[ $E2E_EXIT -eq 0 ]     && echo -e "  E2E:      ${GREEN}PASS${NC} (${E2E_TIME}s)"     || echo -e "  E2E:      ${RED}FAIL${NC} (${E2E_TIME}s)"
echo -e "${YELLOW}======================================${NC}"

TOTAL_FAIL=$((BACKEND_EXIT + WEB_EXIT + E2E_EXIT))
if [ $TOTAL_FAIL -eq 0 ]; then
  echo -e "${GREEN}  All suites passed!${NC}"
  exit 0
else
  echo -e "${RED}  $TOTAL_FAIL suite(s) failed.${NC}"
  exit 1
fi
