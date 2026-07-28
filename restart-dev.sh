#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Flo POS - restarting development app"

# kill-ports.js scopes termination to FloCafe listeners; do not kill by generic
# process names such as electron, next, or node.
node kill-ports.js 3000 3001 3002 3088

rm -rf -- "$SCRIPT_DIR/frontend/.next" "$SCRIPT_DIR/dist"

# Use the current documented development entry point. The former script
# referenced a deleted server.js and mutated source to change its port.
exec npm run dev
