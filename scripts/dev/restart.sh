#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

echo "FloCafe - restarting development app"

# kill-ports.js scopes termination to FloCafe listeners; do not kill by generic
# process names such as electron, next, or node.
node kill-ports.js 3000 3001 3002 3003 3088

rm -rf -- "$ROOT_DIR/frontend/.next" "$ROOT_DIR/dist"

# Use the current documented development entry point. The former script
# referenced a deleted server.js and mutated source to change its port.
exec npm run dev
