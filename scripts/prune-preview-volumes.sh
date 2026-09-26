#!/bin/sh
set -eu

PREVIEW_APP=99d1ohboqype9py2obc64wnt
CUTOFF=$(date -d "1 day ago" +%s)

docker volume ls -qf dangling=true \
| grep -E "^${PREVIEW_APP}-.*-pr-[0-9]+$" \
| while read -r volume; do
    created=$(docker volume inspect "$volume" --format "{{.CreatedAt}}" 2>/dev/null) || continue
    created_at=$(date -d "$created" +%s 2>/dev/null) || continue
    [ "$created_at" -lt "$CUTOFF" ] || continue
    docker volume rm "$volume" >/dev/null && echo "removed $volume"
  done
