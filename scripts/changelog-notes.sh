#!/bin/bash
# Extracts a single version's section from CHANGELOG.md (everything under its
# "## [x.y.z] - date" heading, up to but not including the next one) so it
# can be used verbatim as GitHub release notes.
#
# Usage: scripts/changelog-notes.sh 2.0.3

set -euo pipefail

VERSION="${1:?Usage: changelog-notes.sh <version, e.g. 2.0.3>}"
CHANGELOG="$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"

awk -v ver="$VERSION" '
  BEGIN { found = 0; printing = 0 }
  /^## \[/ {
    if (printing) exit
    if ($0 ~ "^## \\[" ver "\\]") { found = 1; printing = 1 }
    next
  }
  printing { print }
  END { if (!found) exit 1 }
' "$CHANGELOG" | sed -e '/./,$!d'
