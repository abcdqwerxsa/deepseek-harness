#!/bin/sh
# Build the platform image with the current source commit embedded in the
# client build environment (the Dockerfile's build does not ship git).
set -e
cd "$(dirname "$0")"
hash=$(git -C .. rev-parse --short=7 HEAD)
exec docker compose build --build-arg DSH_CLIENT_COMMIT_HASH="$hash" "$@" platform
