#!/bin/sh
# Build on the build server (heavy CPU/memory work stays off this machine):
# rsync the source tree, docker build there, and bring the stack up directly
# from the built image. Requires passwordless ssh to the build server.
set -e
cd "$(dirname "$0")"
REMOTE="${PLATFORM_BUILD_HOST:-root@192.168.28.165}"
REMOTE_PORT="${PLATFORM_BUILD_HOST_PORT:-2225}"
SRC_DIR="${PLATFORM_BUILD_SRC_DIR:-/opt/dsh-src}"

# The rsynced tree carries no .git (build.sh cannot derive the commit there),
# so this machine's HEAD travels as the build argument.
hash=$(git -C .. rev-parse --short=7 HEAD)

ssh -p "$REMOTE_PORT" "$REMOTE" "mkdir -p '$SRC_DIR'"
rsync -az --delete -e "ssh -p $REMOTE_PORT" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '**/node_modules' \
  --exclude '**/lib' \
  --exclude '**/dist' \
  --exclude '**/*.tsbuildinfo' \
  --exclude 'docs' \
  --exclude 'plans' \
  .. "$REMOTE:$SRC_DIR/"

ssh -p "$REMOTE_PORT" "$REMOTE" "
  if [ -f /opt/dsh-platform/.env ]; then
    cp /opt/dsh-platform/.env '$SRC_DIR/deploy/.env'
  elif [ ! -f '$SRC_DIR/deploy/.env' ]; then
    cp '$SRC_DIR/deploy/.env.example' '$SRC_DIR/deploy/.env'
  fi
  cd '$SRC_DIR/deploy' && DSH_CLIENT_COMMIT_HASH='$hash' docker compose build platform
"
ssh -p "$REMOTE_PORT" "$REMOTE" "cd /opt/dsh-platform && docker compose up -d"
echo "remote stack updated from $hash"
