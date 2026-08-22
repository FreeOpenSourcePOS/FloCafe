#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/package.json" ]; then
  echo "Error: nuclear-reset.sh must run from a FloCafe checkout." >&2
  exit 1
fi

is_safe_clear_path() {
  local target=$1
  case "$target" in
    "$ROOT_DIR/frontend/.next"|"$ROOT_DIR/frontend/node_modules/.cache"|"$ROOT_DIR/dist"|"$ROOT_DIR/tsconfig.tsbuildinfo")
      return 0
      ;;
    *flo-desktop*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

clear_path() {
  local target=$1
  local label=$2
  if [ -z "$target" ] || [ "$target" = "/" ] || ! is_safe_clear_path "$target"; then
    echo -e "${RED}Refusing to clear unsafe path for ${label}: ${target}${NC}" >&2
    exit 1
  fi
  if [ "${DRY_RUN:-false}" = "true" ]; then
    if [ -e "$target" ]; then
      echo -e "${YELLOW}Would clear: ${label} (${target})${NC}"
    else
      echo -e "${YELLOW}Skipped: ${label} not found (${target})${NC}"
    fi
    return
  fi
  if [ -e "$target" ]; then
    rm -rf -- "$target"
    echo -e "${GREEN}Cleared: ${label}${NC}"
  else
    echo -e "${YELLOW}Skipped: ${label} not found (${target})${NC}"
  fi
}

clear_electron_caches() {
  local platform="${FLO_RESET_PLATFORM:-$(uname -s)}"
  case "$platform" in
    Darwin)
      clear_path "$HOME/Library/Application Support/flo-desktop/Cache" "Electron app cache"
      clear_path "$HOME/Library/Application Support/flo-desktop/Code Cache" "Electron code cache"
      clear_path "$HOME/Library/Caches/flo-desktop" "Electron system cache"
      ;;
    Linux)
      local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
      local cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
      clear_path "$config_home/flo-desktop/Cache" "Electron app cache"
      clear_path "$config_home/flo-desktop/Code Cache" "Electron code cache"
      clear_path "$cache_home/flo-desktop" "Electron system cache"
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      if [ -n "${APPDATA:-}" ]; then
        clear_path "$APPDATA/flo-desktop/Cache" "Electron app cache"
        clear_path "$APPDATA/flo-desktop/Code Cache" "Electron code cache"
      else
        echo -e "${YELLOW}Skipped: Electron app/code cache unavailable (APPDATA is not set)${NC}"
      fi
      if [ -n "${LOCALAPPDATA:-}" ]; then
        clear_path "$LOCALAPPDATA/flo-desktop" "Electron system cache"
      else
        echo -e "${YELLOW}Skipped: Electron system cache unavailable (LOCALAPPDATA is not set)${NC}"
      fi
      ;;
    *)
      echo -e "${YELLOW}Skipped: Electron cache cleanup not configured for platform ${platform}${NC}"
      ;;
  esac
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CONFIRMED=false
DRY_RUN=false
CACHE_ONLY=false
ELECTRON_CACHE_ONLY=false
for arg in "$@"; do
  case $arg in
    -y|--yes)
      CONFIRMED=true
      ;;
    --dry-run)
      DRY_RUN=true
      CONFIRMED=true
      ;;
    --cache-only)
      CACHE_ONLY=true
      CONFIRMED=true
      ;;
    --electron-cache-only)
      CACHE_ONLY=true
      ELECTRON_CACHE_ONLY=true
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
echo -e "${BLUE}    FloCafe - Development Reset         ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

echo -e "${BLUE}Step 1: Killing Flo processes${NC}"
echo "----------------------------------------"

if [ "$DRY_RUN" = "true" ]; then
  echo -e "${YELLOW}Dry run: would stop Flo processes on ports 3000, 3001, 3002, 3003, 3088${NC}"
elif [ "$CACHE_ONLY" = "true" ]; then
  echo -e "${YELLOW}Cache-only mode: process stop skipped${NC}"
else
  node kill-ports.js 3000 3001 3002 3003 3088
  sleep 1
  echo -e "${GREEN}Flo processes stopped${NC}"
fi

echo ""
echo -e "${BLUE}Step 2: Clearing ALL caches${NC}"
echo "----------------------------------------"

# Project caches
if [ "$ELECTRON_CACHE_ONLY" != "true" ]; then
  clear_path "$ROOT_DIR/frontend/.next" "frontend/.next"
  clear_path "$ROOT_DIR/frontend/node_modules/.cache" "frontend/node_modules/.cache"
  clear_path "$ROOT_DIR/dist" "dist/"
fi

# Electron caches
clear_electron_caches

# TypeScript incremental build cache
if [ "$ELECTRON_CACHE_ONLY" != "true" ]; then
  clear_path "$ROOT_DIR/tsconfig.tsbuildinfo" "TS build info"
fi

if [ "$DRY_RUN" = "true" ]; then
  echo ""
  echo -e "${YELLOW}Dry run complete; rebuild and route verification skipped.${NC}"
  exit 0
fi

if [ "$CACHE_ONLY" = "true" ]; then
  echo ""
  echo -e "${GREEN}Cache cleanup complete; rebuild and route verification skipped.${NC}"
  exit 0
fi

echo ""
echo -e "${BLUE}Step 3: Rebuilding TypeScript${NC}"
echo "----------------------------------------"

npm run build 2>&1
echo -e "${GREEN}Build successful${NC}"

echo ""
echo -e "${BLUE}Step 4: Verify routes are compiled${NC}"
echo "----------------------------------------"

if grep -q "customers-search" dist/main/routes/index.js; then
    echo -e "${GREEN}✓ customers-search route found in compiled code${NC}"
else
    echo -e "${RED}✗ customers-search route NOT found!${NC}"
    exit 1
fi

if grep -q "crm/lookup" dist/main/routes/index.js; then
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
