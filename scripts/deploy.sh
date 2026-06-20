#!/usr/bin/env bash
# Zero-downtime deployment for Relay LLM.
#
# How it works:
#   - "relay" is always the active container
#   - New version starts as "relay-new" on an alternate port
#   - After health check passes, nginx switches to the new port
#   - Old connections drain, then old container is stopped
#   - "relay-new" is renamed to "relay"
#
# Usage: ./deploy.sh <docker-image>
# Example: ./deploy.sh ghcr.io/your-org/relay-llm:abc123

set -euo pipefail

IMAGE="${1:?Usage: deploy.sh <docker-image>}"
STATE_FILE="/srv/relay-llm/.active-port"
NGINX_CONF="/etc/nginx/sites-available/relay"
ENV_FILE="/srv/relay-llm/.env"
HEALTH_RETRIES=15
DRAIN_SECONDS=10

# --- Determine current and next port ---

CURRENT_PORT=$(cat "$STATE_FILE" 2>/dev/null || echo "")

# Migration from blue-green naming scheme
if [[ -z "$CURRENT_PORT" ]]; then
  OLD_SLOT_FILE="/srv/relay-llm/.active-slot"
  OLD_SLOT=$(cat "$OLD_SLOT_FILE" 2>/dev/null || echo "")

  if [[ "$OLD_SLOT" == "green" ]]; then
    CURRENT_PORT=8081
  else
    CURRENT_PORT=8080
  fi

  # Rename old container to "relay"
  for name in relay-blue relay-green relay-llm; do
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      echo "[deploy] Migrating container $name → relay"
      docker rename "$name" relay 2>/dev/null || true
      break
    fi
  done

  echo "$CURRENT_PORT" > "$STATE_FILE"
  rm -f "$OLD_SLOT_FILE"
fi

# Validate
if [[ "$CURRENT_PORT" != "8080" && "$CURRENT_PORT" != "8081" ]]; then
  echo "[deploy] FAILED: invalid port '$CURRENT_PORT' in $STATE_FILE"
  exit 1
fi

if [[ "$CURRENT_PORT" == "8080" ]]; then
  NEXT_PORT=8081
else
  NEXT_PORT=8080
fi

echo "[deploy] relay (:$CURRENT_PORT) → relay-new (:$NEXT_PORT)"

# --- 0. Sync nginx config from repo ---

NGINX_SRC="/srv/relay-llm/nginx.conf"
if [[ -f "$NGINX_SRC" ]]; then
  echo "[deploy] Syncing nginx config from repo..."
  cp "$NGINX_SRC" "$NGINX_CONF"
  # Set the current active port in the config
  sed -i "s|proxy_pass http://127.0.0.1:[0-9]\+|proxy_pass http://127.0.0.1:${CURRENT_PORT}|" "$NGINX_CONF"
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/relay
  nginx -t || { echo "[deploy] FAILED: new nginx config is invalid"; exit 1; }
  nginx -s reload
  echo "[deploy] Nginx config updated"
fi

# --- 1. Start new container ---

docker rm -f relay-new 2>/dev/null || true

echo "[deploy] Starting relay-new on port $NEXT_PORT..."
docker run -d \
  --name relay-new \
  --env-file "$ENV_FILE" \
  -p "127.0.0.1:$NEXT_PORT:8080" \
  --restart unless-stopped \
  "$IMAGE"

# --- 2. Health check ---

echo "[deploy] Waiting for health check on :$NEXT_PORT..."
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -sf "http://localhost:$NEXT_PORT/health" > /dev/null 2>&1; then
    echo "[deploy] Health check passed (attempt $i)"
    break
  fi
  if [[ "$i" -eq "$HEALTH_RETRIES" ]]; then
    echo "[deploy] FAILED: health check did not pass after $HEALTH_RETRIES attempts"
    echo "[deploy] Rolling back — removing relay-new"
    docker logs relay-new --tail 20
    docker rm -f relay-new
    exit 1
  fi
  sleep 1
done

# --- 3. Switch nginx upstream ---

echo "[deploy] Switching nginx upstream to :$NEXT_PORT..."
sed -i "s|proxy_pass http://127.0.0.1:[0-9]\+|proxy_pass http://127.0.0.1:${NEXT_PORT}|" "$NGINX_CONF"
nginx -t || {
  echo "[deploy] FAILED: nginx config test failed, reverting"
  sed -i "s|proxy_pass http://127.0.0.1:[0-9]\+|proxy_pass http://127.0.0.1:${CURRENT_PORT}|" "$NGINX_CONF"
  docker rm -f relay-new
  exit 1
}
nginx -s reload

# --- 4. Drain old connections ---

echo "[deploy] Draining old connections (${DRAIN_SECONDS}s)..."
sleep "$DRAIN_SECONDS"

# --- 5. Stop old, rename new → relay ---

echo "[deploy] Stopping old relay..."
docker stop relay 2>/dev/null || true
docker rm relay 2>/dev/null || true

docker rename relay-new relay
echo "$NEXT_PORT" > "$STATE_FILE"

# --- 6. Cleanup ---

docker image prune -f > /dev/null 2>&1

echo "[deploy] Done. relay (:$NEXT_PORT)"
