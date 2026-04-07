#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/proxy.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "Proxy is not running (no pid file)"
  exit 1
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm -f "$PID_FILE"
  echo "Proxy stopped (PID: $PID)"
else
  rm -f "$PID_FILE"
  echo "Proxy was not running (stale pid file removed)"
fi
