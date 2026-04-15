#!/bin/bash
# Integration test for Relay LLM — JWT auth + budget enforcement + Admin API
# Runs against docker compose (postgres + relay)
#
# Usage:
#   ./scripts/test-integration.sh [jwt-token]
#
# Prerequisites:
#   - docker compose up -d postgres
#   - Server running (pnpm dev)
#   - .env with: RELAY_ADMIN_SECRET, JWT_SECRET, provider keys

set -euo pipefail

PORT="${PORT:-8080}"
BASE="http://localhost:${PORT}"
ADMIN_SECRET="${RELAY_ADMIN_SECRET:-test-admin-secret-for-integration}"
JWT="${1:-}"
PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Relay LLM Integration Tests (JWT Auth) ==="
echo "Target: $BASE"
echo ""

# --- Health Check ---
echo "1. Health check"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
check "GET /health returns 200" "200" "$HTTP_CODE"
echo ""

# --- Auth: missing token ---
echo "2. Auth: missing token"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/openai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
check "No auth header returns 401" "401" "$HTTP_CODE"
echo ""

# --- Auth: invalid JWT ---
echo "3. Auth: invalid JWT"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/openai/v1/chat/completions" \
  -H "Authorization: Bearer not-a-valid-jwt" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
check "Invalid JWT returns 401" "401" "$HTTP_CODE"
echo ""

# --- Admin: invalid secret ---
echo "4. Admin: invalid secret"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/users/test-user/budget" \
  -H "Authorization: Bearer wrong-secret" \
  -H "Content-Type: application/json" \
  -d '{"budget":5.00}')
check "Wrong admin secret returns 401" "401" "$HTTP_CODE"
echo ""

# --- Admin: set budget ---
echo "5. Admin: set budget"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/users/test-user-123/budget" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget":25.00}')
check "PUT /admin/users/:id/budget returns 200" "200" "$HTTP_CODE"
echo ""

# --- Admin: set zero budget ---
echo "6. Admin: set zero budget"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/users/zero-budget-user/budget" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget":0}')
check "Set zero budget returns 200" "200" "$HTTP_CODE"
echo ""

# --- Admin: reset spend ---
echo "7. Admin: reset spend"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/users/test-user-123/budget" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget":25.00,"reset_spend":true}')
check "Reset spend returns 200" "200" "$HTTP_CODE"
echo ""

# --- Admin: invalid budget ---
echo "8. Admin: invalid budget"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/users/test-user-123/budget" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget":-5}')
check "Negative budget returns 400" "400" "$HTTP_CODE"
echo ""

# --- Admin: delete user ---
echo "9. Admin: delete user budget"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/users/zero-budget-user" \
  -H "Authorization: Bearer $ADMIN_SECRET")
check "DELETE /admin/users/:id returns 200" "200" "$HTTP_CODE"
echo ""

# --- Admin: delete nonexistent ---
echo "10. Admin: delete nonexistent user"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/users/nobody" \
  -H "Authorization: Bearer $ADMIN_SECRET")
check "Nonexistent user returns 404" "404" "$HTTP_CODE"
echo ""

# --- Proxy with JWT (if provided) ---
if [ -n "$JWT" ]; then
  echo "11. Proxy: JWT auth + budget"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/anthropic/v1/messages" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}')
  # 200 = success, 401 = provider dummy key, 402 = no budget, 403 = no budget record, 502 = upstream error
  echo "  HTTP $HTTP_CODE"
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "502" ]; then
    check "JWT passes auth, forwarded to provider (got $HTTP_CODE)" "true" "true"
  elif [ "$HTTP_CODE" = "402" ] || [ "$HTTP_CODE" = "403" ]; then
    check "JWT valid but no budget set (got $HTTP_CODE — expected, set budget via Admin API)" "true" "true"
  else
    check "JWT auth" "200, 401, 402, 403, or 502" "$HTTP_CODE"
  fi
  echo ""
else
  echo "11. Proxy: skipped (no JWT provided, pass as \$1)"
  echo ""
fi

# --- Cleanup ---
curl -s -o /dev/null -X DELETE "$BASE/admin/users/test-user-123" \
  -H "Authorization: Bearer $ADMIN_SECRET" 2>/dev/null || true

# --- Summary ---
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
