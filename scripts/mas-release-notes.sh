#!/bin/bash
# Builds the Mac App Store "What's New" text from the current CHANGELOG.md entry.

set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUT="${2:-release/mas-release-notes.txt}"

mkdir -p "$(dirname "$OUT")"

"$(dirname "$0")/changelog-notes.sh" "$VERSION" |
  sed -E \
    -e 's/^[[:space:]]*#+[[:space:]]*//' \
    -e 's/^[[:space:]]*[-*][[:space:]]*/- /' \
    -e 's/\*\*([^*]+)\*\*/\1/g' \
    -e 's/\[([^]]+)\]\([^)]+\)/\1/g' \
    -e '/^Full Changelog:/d' |
  awk 'NF { blank = 0; print; next } !blank { print; blank = 1 }' |
  sed -e '/./,$!d' > "$OUT"

chars=$(wc -m < "$OUT" | tr -d ' ')
if [ "$chars" -gt 4000 ]; then
  echo "Mac App Store release notes are ${chars} characters; Apple allows at most 4000." >&2
  exit 1
fi

test -s "$OUT" || {
  echo "No Mac App Store release notes generated for ${VERSION}." >&2
  exit 1
}
