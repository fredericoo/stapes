#!/bin/sh
set -eu

PREVIEW_APP=${PREVIEW_APP:?set PREVIEW_APP to the preview application uuid}
MAX_PREVIEWS=${MAX_PREVIEWS:-5}

# Coolify names a preview container <app uuid>-pr-<N> and recreates it on every push,
# so CreatedAt orders the previews by their last push. Stopped containers are not
# restarted by Docker; the next push to that pull request deploys it again.
docker ps --filter "name=^${PREVIEW_APP}-pr-" --format '{{.CreatedAt}}|{{.Names}}' \
| grep -E "\|${PREVIEW_APP}-pr-[0-9]+$" \
| sort -r \
| tail -n +"$((MAX_PREVIEWS + 1))" \
| cut -d'|' -f2 \
| while read -r name; do
    docker stop "$name" >/dev/null && echo "stopped $name"
  done
