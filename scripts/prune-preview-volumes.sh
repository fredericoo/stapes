#!/bin/sh
set -eu

PREVIEW_APP=${PREVIEW_APP:?set PREVIEW_APP to the preview application uuid}
CUTOFF=$(date -d "1 day ago" +%s)

docker volume ls -qf dangling=true \
| grep -E "^${PREVIEW_APP}-.*-pr-[0-9]+$" \
| while read -r volume; do
    created=$(docker volume inspect "$volume" --format "{{.CreatedAt}}" 2>/dev/null) || continue
    created_at=$(date -d "$created" +%s 2>/dev/null) || continue
    [ "$created_at" -lt "$CUTOFF" ] || continue
    docker volume rm "$volume" >/dev/null && echo "removed $volume"
  done
