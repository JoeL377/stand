#!/usr/bin/env bash
# Stop the instance this run started and drop its data. Evidence stays.   cleanup.sh <run dir>
set -uo pipefail
RUN="${1:?usage: cleanup.sh <run dir>}"
PID="$(cat "$RUN/pid" 2>/dev/null)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"; for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
fi
rm -rf "$RUN/data" "$RUN/pid"
echo "Stopped. Evidence kept in $RUN/evidence (server log: $RUN/server.log)"
ls "$RUN/evidence"
