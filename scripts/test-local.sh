#!/bin/bash
# Quick local integration test for Relay LLM
# Prerequisites: server running on localhost:8080 with valid env vars
#
# Usage:
#   1. cp .env.example .env && edit .env with real keys
#   2. pnpm dev (in another terminal)
#   3. ./scripts/test-local.sh <jwt> [admin-secret]
#
# Arguments:
#   $1  JWT token (required for provider proxy tests)
#   $2  Admin secret (optional; falls back to $RELAY_ADMIN_SECRET env var)

set -e

RELAY_URL="${RELAY_URL:-http://localhost:8080}"
PORT="${PORT:-8080}"
JWT="${1:-}"

if [ -z "$JWT" ]; then
  echo "Usage: ./scripts/test-local.sh <jwt> [admin-secret]"
  echo ""
  echo "Generate a test JWT signed with your JWT_SECRET, or get one from your auth provider."
  exit 1
fi

echo "=== Relay LLM Integration Tests ==="
echo "Target: $RELAY_URL"
echo ""

# 1. Health check
echo "--- Health Check ---"
curl -s "$RELAY_URL/health" | jq .
echo ""

# 2. Auth test (no token)
echo "--- Auth: Missing token (expect 401) ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL/v1/google/v1beta/models/gemini-3.8-flash:streamGenerateContent" \
  -X POST -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"hi"}]}]}')
echo "Status: $HTTP_CODE"
[ "$HTTP_CODE" = "401" ] && echo "PASS" || echo "FAIL"
echo ""

# --- Admin API Tests ---
echo ""
echo "=== Admin API Tests ==="

ADMIN_SECRET="${2:-$RELAY_ADMIN_SECRET}"
if [ -z "$ADMIN_SECRET" ]; then
  echo "⚠️  No admin secret provided (pass as \$2 or set RELAY_ADMIN_SECRET). Skipping admin tests."
else
  # Set user budget
  echo ""
  echo "--- Test: Set user budget ---"
  curl -s -X PUT "http://localhost:${PORT}/admin/users/test-user-local/budget" \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"budget":10.00}' | jq .
  echo ""

  # Update budget with spend reset
  echo ""
  echo "--- Test: Update budget + reset spend ---"
  curl -s -X PUT "http://localhost:${PORT}/admin/users/test-user-local/budget" \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"budget":25.00,"reset_spend":true}' | jq .
  echo ""

  # Delete user budget
  echo ""
  echo "--- Test: Delete user budget ---"
  curl -s -X DELETE "http://localhost:${PORT}/admin/users/test-user-local" \
    -H "Authorization: Bearer $ADMIN_SECRET" | jq .
  echo ""

  # Test invalid admin secret
  echo ""
  echo "--- Test: Invalid admin secret rejected ---"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://localhost:${PORT}/admin/users/test-user-local/budget" \
    -H "Authorization: Bearer wrong-secret" \
    -H "Content-Type: application/json" \
    -d '{"budget":1.00}')
  if [ "$HTTP_CODE" = "401" ]; then
    echo "✅ Invalid admin secret correctly rejected with 401"
  else
    echo "❌ Expected 401, got $HTTP_CODE"
  fi
fi

# 3. Google Gemini passthrough (served model)
echo ""
echo "--- Google Gemini: Non-streaming ---"
curl -s "$RELAY_URL/v1/google/v1beta/models/gemini-3.8-flash:generateContent" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Say hello in exactly 3 words."}]}]
  }' | jq '{text: .candidates[0].content.parts[0].text, usage: .usageMetadata}'
echo ""

# 4. Google Gemini streaming
echo "--- Google Gemini: Streaming ---"
curl -s -N "$RELAY_URL/v1/google/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Say hi in 2 words."}]}]
  }' 2>/dev/null | head -20
echo ""
echo ""

# 5. A model Dassi does not offer is refused before reaching the provider
echo "--- Google Gemini: Unserved model (expect 403) ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL/v1/google/v1beta/models/gemini-2.5-pro:generateContent" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"parts": [{"text": "hi"}]}]}')
echo "Status: $HTTP_CODE"
[ "$HTTP_CODE" = "403" ] && echo "PASS" || echo "FAIL"
echo ""

echo "=== Done ==="
