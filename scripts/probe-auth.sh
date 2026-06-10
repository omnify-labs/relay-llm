#!/usr/bin/env bash
# Auth drift probe for relay-llm.
#
# Why: the relay validates HS256 JWTs signed by Supabase. If the relay's
# JWT_SECRET ever diverges from Supabase's signing secret (a bad deploy, or a
# Supabase secret rotation the relay didn't pick up), EVERY managed-credit
# request is rejected with 401 before it reaches the provider — a total managed
# outage. The /health endpoint does NOT go through auth, so it stays green and
# hides this. This probe is the only check that actually exercises the secret.
#
# How: mint a short-lived HS256 token signed with the EXPECTED Supabase signing
# secret (passed in via env, kept out of the repo) and confirm the relay accepts
# the signature. A signature-valid token for a non-existent user yields a budget
# rejection (HTTP 403), which still proves auth passed. Only a 401 means drift.
#
# Usage:
#   PROBE_SIGNING_SECRET=<supabase-jwt-secret> probe-auth.sh <relay-base-url>
#
# Exit codes:
#   0  relay accepted the signature (HTTP != 401) — auth is healthy
#   1  relay rejected the signature (HTTP 401) — JWT_SECRET drift
#   2  relay unreachable / unexpected error
# Reason: -e so a broken openssl/date (malformed JWT) aborts loudly instead of
# silently sending a bad token and reporting a false "drift" 401.
set -euo pipefail

URL="${1:?usage: probe-auth.sh <relay-base-url>}"
SECRET="${PROBE_SIGNING_SECRET:?set PROBE_SIGNING_SECRET to the Supabase JWT secret}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

now=$(date +%s)
exp=$((now + 60))
hdr=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
# Reason: relay only checks signature + a non-empty `sub`; the user need not
# exist (a real user would just route to a budget check). Use a sentinel sub.
pl=$(printf '%s' "{\"sub\":\"auth-drift-probe\",\"role\":\"authenticated\",\"aud\":\"authenticated\",\"iat\":$now,\"exp\":$exp}" | b64url)
sig=$(printf '%s' "$hdr.$pl" | openssl dgst -sha256 -hmac "$SECRET" -binary | b64url)
tok="$hdr.$pl.$sig"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
  "$URL/v1/openai/v1/chat/completions" \
  -H "Authorization: Bearer $tok" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[]}') || {
    echo "PROBE ERROR: could not reach $URL (curl failed)"
    exit 2
  }

case "$code" in
  401)
    echo "PROBE FAIL: $URL rejected a token signed with the expected Supabase secret (HTTP 401) -> JWT_SECRET drift"
    exit 1
    ;;
  000)
    echo "PROBE ERROR: no HTTP response from $URL (timeout/unreachable)"
    exit 2
    ;;
  *)
    echo "PROBE OK: $URL accepted the signature (HTTP $code, non-401)"
    exit 0
    ;;
esac
