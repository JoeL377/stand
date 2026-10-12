#!/usr/bin/env bash
# Start an isolated Stand instance for verification: production build, its own
# port and data dir, audio in mock mode. Prints the run dir on the last line.
#   launch.sh [port]        (default 3911)
set -euo pipefail
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
PORT="${1:-3911}"
ROOT="${STAND_VERIFY_ROOT:-${TMPDIR:-/tmp}/stand-verify}"
RUN="$ROOT/run-$(date +%Y%m%d-%H%M%S)-$PORT"
mkdir -p "$RUN/data" "$RUN/evidence"

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
  echo "Port $PORT is already taken. Pick another: launch.sh <port>" >&2; exit 1
fi

cd "$REPO"
[ -d node_modules ] || npm ci --no-audit --no-fund >"$RUN/install.log" 2>&1
npm run build >"$RUN/build.log" 2>&1 || { echo "Build failed, see $RUN/build.log" >&2; exit 1; }

# No --env-file: a developer's .env (LiveKit, Google, allowlists) would turn on real
# audio and Google-only sign-in, which an agent can't drive. Notes use Claude when a
# key is present (ANTHROPIC_API_KEY, or STAND_ANTHROPIC_API_KEY in cloud sessions).
KEY="${ANTHROPIC_API_KEY:-${STAND_ANTHROPIC_API_KEY:-}}"
env -u LIVEKIT_URL -u LIVEKIT_API_KEY -u LIVEKIT_API_SECRET -u DEEPGRAM_API_KEY \
    -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u ALLOWED_EMAILS -u ALLOWED_EMAIL_DOMAINS \
    -u PUBLIC_URL -u LINEAR_API_KEY -u CONXT_DESTINATIONS \
    NODE_ENV=production PORT="$PORT" DATA_DIR="$RUN/data" ANTHROPIC_API_KEY="$KEY" \
    nohup node --import tsx src/server/index.ts >"$RUN/server.log" 2>&1 &
echo $! >"$RUN/pid"
echo "$PORT" >"$RUN/port"
git rev-parse --short HEAD >"$RUN/commit"

for _ in $(seq 1 60); do
  grep -q "standup server on" "$RUN/server.log" && break
  kill -0 "$(cat "$RUN/pid")" 2>/dev/null || { echo "Server exited, see $RUN/server.log" >&2; exit 1; }
  sleep 0.5
done
grep -q "standup server on" "$RUN/server.log" || { echo "Server never got ready, see $RUN/server.log" >&2; exit 1; }
grep -E "audio:|standup server on" "$RUN/server.log"
echo "$RUN"
