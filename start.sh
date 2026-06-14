#!/bin/bash
# WC 2026 — The Pulse
# Production startup script

set -e

WC_DIR="/opt/data/wc-app"
CADDY="/opt/data/caddy"

echo "⚽ Starting World Cup 2026 — The Pulse"
echo "========================================="

# Kill any existing processes
pkill -f "node server.mjs" 2>/dev/null || true
pkill -f "caddy run" 2>/dev/null || true
sleep 1

# Build if needed
if [ ! -d "$WC_DIR/dist" ] || [ "$1" = "--rebuild" ]; then
  echo "🔨 Building..."
  cd "$WC_DIR" && npm run build 2>&1
fi

# Start Node.js server
echo "🚀 Starting Node server on :4321..."
cd "$WC_DIR" && node server.mjs &
NODE_PID=$!
sleep 1

# Check node server
if curl -s -o /dev/null -w "%{http_code}" http://localhost:4321 | grep -q "200"; then
  echo "  ✅ Node server running (PID: $NODE_PID)"
else
  echo "  ❌ Node server failed!"
  exit 1
fi

# Start Caddy reverse proxy
echo "🔒 Starting Caddy reverse proxy on :80..."
cd "$WC_DIR" && $CADDY run --config Caddyfile &
CADDY_PID=$!
sleep 2

# Check Caddy
if curl -s -o /dev/null -w "%{http_code}" http://localhost:80 | grep -q "200"; then
  echo "  ✅ Caddy proxy running (PID: $CADDY_PID)"
else
  echo "  ❌ Caddy proxy failed!"
  exit 1
fi

echo ""
echo "========================================="
echo "⚽ WC 2026 — The Pulse is LIVE"
echo "   http://localhost:80"
echo "   http://3.7.69.99"
echo "   https://wc.wedevs.site (once DNS is set)"
echo "========================================="
echo ""
echo "Node PID: $NODE_PID | Caddy PID: $CADDY_PID"
echo "To stop: kill $NODE_PID $CADDY_PID"

wait
