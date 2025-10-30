#!/bin/bash
set -e

MODE=${1:-cli}
shift || true


if [ "$MODE" = "cli" ]; then
  exec node dist/src/cli.js "$@"
elif [ "$MODE" = "api" ]; then
  exec node dist/src/apiServer.js "$@"
elif [ "$MODE" = "bash" ]; then
  exec bash
else
  echo "Unknown mode: $MODE"
  exit 1
fi
