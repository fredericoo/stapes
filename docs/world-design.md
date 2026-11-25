# How the world leads a player

## Guided freedom

The world is laid out the way a metroidvania is: a player may go anywhere they
can reach, and the terrain decides what they can reach. Hills, cliffs, water and
roads steer a player through a designed order of places without an invisible
wall or a locked gate. A player who looks for another way out may find one, for
example by wading along a shore, and that is allowed; the obvious way is the
designed one.

Two consequences for anyone editing the map:

- **The start is short and the adventure comes after it.** The walk from the
  wreck to the first camp is a minute or two. The long walks are from the camp
  to the towns, the dungeons and the coast.
- **A barrier is terrain a player can see.** A player cannot climb even one
  level without a ramp, so a hill with no `ramps` is a barrier however its
  levels are stepped: sheer (`terrace` 0 or 1) or in ragged terraces like the
  valley's hills.

## The guided start

In `data/world.json`:

- **The wreck** (`shipwreck`) wakes every new player on the first sand beside
  the sea, with a `flame` two cells inland (its `castaway` and `fire` props).
  The `flame` never burns out; a `campfire` decays and is put out by rain.
  Tove Arnesdatter (`wreck-tove`) stands beside it, calls "Another one off the wreck! Over here, by the fire." to
  any player who has not talked to her yet, and tells the player to follow
  the road. She has no `keeps-hours`, so she is awake at every hour:
  a player who joins at night still gets the guided start. She gives one
  free meal and does not trade, so a new player's first conversation is about
  the island and the only reason to stay on the beach is to listen. She shoots any
  hostile creature she sees within seven cells while she is near her spot, so
  the waking spot is safe.
- **The valley.** `wreck-west-hill` and `wreck-east-hill` are hills with no
  ramps either side of the road (`beach-path`) from the wreck to the camp,
  stepped in ragged terraces three cells wide (`terrace` 3, `roughness` 70)
  and tallest toward the sea. Their tops carry a few trees and pebbles
  (`wreck-hills-trees`, and `rubble` in `wreck-hills-rocks`) and sandy patches
  (`wreck-hills-sand-*`, each ringed by a `grass` rim so its edge is ragged);
  a patch must sit on one level, or the landscape check finds it in pieces. The west hill
  runs down to the sea, so the beach does not lead west; `wreck-shallows-ribs`
  stands in the shallows at its foot so that wading along the shore does not
  either. The east side ends at the bay. The valley opens only at its north
  end, beside the camp.
- **The camp** (`camp`) is at the head of the valley, about 100 cells of road from the
  wreck. It is one house, `camp-pub`, and six decorative tents round the
  fire, each with a few things in front of it and a `bedroll`. Every
  townsfolk there has a `bed` spot on its own bedroll, so nobody walks
  indoors to sleep; the spot is in map coordinates and goes stale if the camp moves, after which `keeps-hours`
  falls back to the nearest bedroll. The pub stocks a fifth of the usual
  food and nothing else (`foodOnly`, `stockPercent: 20`), and the loose
  barrel and box hold a bite each: gear is found or bought further on.
- **A safe haven.** Runa Hask stands at the camp's south edge, where the
  road comes up, and shoots any hostile creature that comes within nine
  cells of her post. Rabbits and deer are left for players.
- **The old harbour** (`old-harbour`) is a short walk east of the camp. Its
  warehouse cellar is the first small dungeon: four rats and a nature slime,
  and a sixth of a storage cellar's food (`stockPercent: 15`).
- **The valley wood.** `wreck-valley-wood` is a forest of the plain `tree`
  only, thick against the hill cliffs and thinning to loose trees beside the
  road, round the ruin and toward the beach (its `opensTo`). Its weeding
  clears the berry bushes the meadows lay in it, so the walk to the camp
  holds little food.
- **Creatures on the way** are sized for about ten players levelling at once
  without clearing the valley: `wreck-valley-game` scatters rats, rabbits
  and deer with `spacing` and no `clumping`, `wreck-valley-slimes` puts a
  few small nature slimes only where trees stand thick (`among`), two snakes
  stand off at the valley's edges well away from the road, and five bats live
  in `wreck-cave`, which opens on the valley side of the west hill. Nothing
  stronger is placed between the wreck and the camp.
- **Something to look at.** `wreck-valley-ruin`, a small ruined temple, stands
  beside the road halfway up.

- **A secret.** `secret-cave` is dug into the east hill's sea cliff. Its
  only way in is a `flooded` mouth that opens onto the shallows at the foot
  of the cliff, reached by wading north from the wreck beach; the sea runs a
  few cells into the tunnel (`seep`). Inside are
  three bats, a skeleton in the neck before the back chamber, and a
  `quest-chest` of 20 gold that each player can open once
  (`rewardTag: secret-cave-gold`).

A `tile` node's `at.z` counts levels above the raised ground under it, so a
creature placed on a hill cave's floor at level 0 needs `z` of minus the
hill's height there; with `z: 0` it lands on the hilltop.

Moving the camp, the road or either hill changes all of this at once; check
from the castaway's cell that the only dry way out of the valley is past the
camp.
