#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}    Flo POS - Full Rebuild & Restart   ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

echo -e "${BLUE}Step 1: Killing existing processes${NC}"
echo "----------------------------------------"

node kill-ports.js 3000 3001 3002 3088

echo ""
echo -e "${BLUE}Step 2: Clearing caches${NC}"
echo "----------------------------------------"

rm -rf -- "$SCRIPT_DIR/frontend/.next" && echo -e "${GREEN}Next.js cache cleared${NC}"
rm -rf -- "$SCRIPT_DIR/frontend/node_modules/.cache" && echo -e "${GREEN}Node modules cache cleared${NC}"
rm -rf -- "$SCRIPT_DIR/dist" && echo -e "${GREEN}Dist folder cleared${NC}"

echo ""
echo -e "${BLUE}Step 3: Rebuilding TypeScript${NC}"
echo "----------------------------------------"

npm run build 2>&1 | tail -20
echo -e "${GREEN}TypeScript build successful${NC}"

echo ""
echo -e "${BLUE}Step 4: Starting Electron Dev${NC}"
echo "----------------------------------------"
echo -e "${GREEN}Running: npm run dev${NC}"
echo ""

npm run dev
