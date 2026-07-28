#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Error: nuclear-reset.sh must run from a FloCafe checkout." >&2
  exit 1
fi

clear_path() {
  local target=$1
  local label=$2
  if [ -e "$target" ]; then
    rm -rf -- "$target"
    echo -e "${GREEN}Cleared: ${label}${NC}"
  fi
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CONFIRMED=false
for arg in "$@"; do
  case $arg in
    -y|--yes)
      CONFIRMED=true
      ;;
  esac
done

if [ "${FORCE:-}" = "1" ] || [ "${CI:-}" = "true" ]; then
  CONFIRMED=true
fi

if [ "$CONFIRMED" = "false" ]; then
  if [ -t 0 ]; then
    read -p "WARNING: This will stop Flo processes, clear build/app caches, and rebuild. Continue? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Nuclear reset cancelled."
      exit 0
    fi
  else
    echo -e "${RED}Error: Non-interactive shell detected. Use -y or --yes flag or set FORCE=1 to confirm nuclear reset.${NC}"
    exit 1
  fi
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}    Flo POS - Nuclear Reset             ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

echo -e "${BLUE}Step 1: Killing Flo processes${NC}"
echo "----------------------------------------"

node kill-ports.js 3000 3001 3002 3088
sleep 1

echo -e "${GREEN}Flo processes stopped${NC}"

echo ""
echo -e "${BLUE}Step 2: Clearing ALL caches${NC}"
echo "----------------------------------------"

# Project caches
clear_path "$SCRIPT_DIR/frontend/.next" "frontend/.next"
clear_path "$SCRIPT_DIR/frontend/node_modules/.cache" "frontend/node_modules/.cache"
clear_path "$SCRIPT_DIR/dist" "dist/"

# Electron caches
clear_path "$HOME/Library/Application Support/flo-desktop/Cache" "Electron app cache"
clear_path "$HOME/Library/Application Support/flo-desktop/Code Cache" "Electron code cache"
clear_path "$HOME/Library/Caches/flo-desktop" "Electron system cache"

# TypeScript incremental build cache
if [ -e "$SCRIPT_DIR/tsconfig.tsbuildinfo" ]; then
  rm -f -- "$SCRIPT_DIR/tsconfig.tsbuildinfo"
  echo -e "${GREEN}Cleared: TS build info${NC}"
fi

echo ""
echo -e "${BLUE}Step 3: Rebuilding TypeScript${NC}"
echo "----------------------------------------"

npm run build 2>&1
echo -e "${GREEN}Build successful${NC}"

echo ""
echo -e "${BLUE}Step 4: Verify routes are compiled${NC}"
echo "----------------------------------------"

if grep -q "customers-search" dist/routes/index.js; then
    echo -e "${GREEN}✓ customers-search route found in compiled code${NC}"
else
    echo -e "${RED}✗ customers-search route NOT found!${NC}"
    exit 1
fi

if grep -q "crm/lookup" dist/routes/index.js; then
    echo -e "${GREEN}✓ crm/lookup route found in compiled code${NC}"
else
    echo -e "${RED}✗ crm/lookup route NOT found!${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}    Nuclear Reset Complete!            ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Now run: npm run dev${NC}"
echo ""
