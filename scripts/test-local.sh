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
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL/v1/openai/v1/chat/completions" \
  -X POST -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
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

# 3. OpenAI passthrough
echo ""
echo "--- OpenAI: Non-streaming ---"
curl -s "$RELAY_URL/v1/openai/v1/chat/completions" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}],
    "max_tokens": 20
  }' | jq '{model: .model, content: .choices[0].message.content, usage: .usage}'
echo ""

# 4. OpenAI streaming
echo "--- OpenAI: Streaming ---"
curl -s -N "$RELAY_URL/v1/openai/v1/chat/completions" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hi in 2 words."}],
    "max_tokens": 10,
    "stream": true,
    "stream_options": {"include_usage": true}
  }' 2>/dev/null | head -20
echo ""
echo ""

# 5. Anthropic passthrough
echo "--- Anthropic: Non-streaming ---"
curl -s "$RELAY_URL/v1/anthropic/v1/messages" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 20,
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}]
  }' | jq '{model: .model, content: .content[0].text, usage: .usage}'
echo ""

# 6. Google Gemini passthrough
echo "--- Google Gemini: Non-streaming ---"
curl -s "$RELAY_URL/v1/google/v1beta/models/gemini-2.0-flash:generateContent" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Say hello in exactly 3 words."}]}]
  }' | jq '{text: .candidates[0].content.parts[0].text, usage: .usageMetadata}'
echo ""

# 7. Tool call test (OpenAI)
echo "--- OpenAI: Tool Call Passthrough ---"
curl -s "$RELAY_URL/v1/openai/v1/chat/completions" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is the weather in San Francisco?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 100
  }' | jq '{model: .model, tool_calls: .choices[0].message.tool_calls, usage: .usage}'
echo ""

# 8. Tool call test (Anthropic)
echo "--- Anthropic: Tool Call Passthrough ---"
curl -s "$RELAY_URL/v1/anthropic/v1/messages" \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "What is the weather in San Francisco?"}],
    "tools": [{
      "name": "get_weather",
      "description": "Get the current weather",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        },
        "required": ["location"]
      }
    }],
    "tool_choice": {"type": "auto"}
  }' | jq '{model: .model, content: .content, usage: .usage}'
echo ""

echo "=== Done ==="
