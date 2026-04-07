#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/proxy.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Proxy already running (PID: $OLD_PID)"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

nohup node "$SCRIPT_DIR/proxy.js" > "$SCRIPT_DIR/proxy.log" 2>&1 &
echo $! > "$PID_FILE"
echo "Proxy started (PID: $(cat "$PID_FILE")), log: $SCRIPT_DIR/proxy.log"
