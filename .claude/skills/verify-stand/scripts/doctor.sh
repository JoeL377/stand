#!/usr/bin/env bash
# Read-only: is this instance worth driving?   doctor.sh <run dir>
set -uo pipefail
RUN="${1:?usage: doctor.sh <run dir>}"
PID="$(cat "$RUN/pid" 2>/dev/null)"; PORT="$(cat "$RUN/port" 2>/dev/null)"
ok=1
if kill -0 "$PID" 2>/dev/null; then echo "process: up (pid $PID)"; else echo "process: DOWN"; ok=0; fi
if [ "$(curl -s "http://127.0.0.1:$PORT/api/health")" = '{"ok":true}' ]; then echo "health: ok on :$PORT"; else echo "health: NO ANSWER on :$PORT"; ok=0; fi
if command -v lsof >/dev/null; then
  owner="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  [ -z "$owner" ] || [ "$owner" = "$PID" ] && echo "port: ours" || { echo "port: owned by pid $owner, not ours"; ok=0; }
fi
echo "built from: $(cat "$RUN/commit") (checkout now at $(git -C "$(dirname "$0")" rev-parse --short HEAD))"
grep -m1 "audio:" "$RUN/server.log" | sed 's/^ */modes: /'
[ "$(curl -s "http://127.0.0.1:$PORT/api/auth/me")" = '{"error":"Not signed in"}' ] && echo "auth: stand-in sign-in available" || { echo "auth: unexpected /api/auth/me answer"; ok=0; }
grep -iE "error|unhandled" "$RUN/server.log" | grep -v ExperimentalWarning | tail -3 | sed 's/^/log: /'
[ $ok = 1 ] && echo "DOCTOR OK" || { echo "DOCTOR FAILED"; exit 1; }
