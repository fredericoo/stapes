#!/bin/sh
# Remove the world a closed pull request left behind.
#
# Coolify 4.3.10 never deletes a preview's volume. `DeleteResourceJob::handle`
# returns early for an `ApplicationPreview` into `deleteApplicationPreview`,
# which cancels deployments, removes the containers and force-deletes the
# record — and never reaches the `deleteVolumes` branch, whose `true` default
# only applies to the resource types it returned before. The container goes,
# the volume stays, and nothing ever says so.
#
# Three guards, each ruling out a different way this could eat something live:
#
#   uuid prefix     Only the preview application. Production volumes are
#                   `4whz1r5p0jw6oii6chv80fcj-*` and cannot match.
#   `-pr-N`         Only a pull request's volume, never the base app's own.
#   dangling + age  Attached to nothing, and not created in the last day. A
#                   preview redeploy detaches its volume for seconds while the
#                   container is replaced — a day is far outside that window,
#                   and an open pull request has a container holding its volume.
#
# Deliberately not Coolify's own `delete_unused_volumes`: that prunes every
# unused volume on the box, and production's data and backups are both detached
# for about fifteen seconds during a deploy. A deploy landing on the midnight
# cleanup would take the world and every backup of it together.
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
