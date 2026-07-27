#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}    Flo POS - Clean Restart            ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

echo -e "${BLUE}Step 1: Killing existing Flo processes${NC}"
echo "----------------------------------------"

node kill-ports.js 3000 3001 3002 3088

echo ""
echo -e "${BLUE}Step 2: Clearing caches${NC}"
echo "----------------------------------------"

# Clear caches
rm -rf frontend/.next 2>/dev/null && echo -e "${GREEN}Next.js cache cleared${NC}"
rm -rf frontend/node_modules/.cache 2>/dev/null && echo -e "${GREEN}Node modules cache cleared${NC}"
rm -rf dist 2>/dev/null && echo -e "${GREEN}Dist folder cleared${NC}"

echo ""
echo -e "${BLUE}Step 3: Starting Electron Dev${NC}"
echo "----------------------------------------"
echo -e "${GREEN}Running: npm run dev${NC}"
echo ""

# Run npm run dev
npm run dev
