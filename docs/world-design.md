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
- **A barrier is terrain a player can see.** A hill the player is meant not to
  climb is a steep hill (`terrace` 0 or 1, no `ramps`), not a gentle one with
  its ramps left out.

## The guided start

In `data/world.json`:

- **The wreck** (`shipwreck`) wakes every new player on the first sand beside
  the sea, with a `flame` two cells inland (its `castaway` and `fire` props).
  The `flame` never burns out; a `campfire` decays and is put out by rain.
  Tove Arnesdatter (`wreck-tove`) stands beside it and tells the player to
  follow the road. Her trades sit behind one Trade option so a new player's
  first conversation is about the island, not a price list.
- **The valley.** `wreck-west-hill` and `wreck-east-hill` are steep hills either
  side of the road (`beach-path`) from the wreck to the camp. The west hill
  runs down to the sea, so the beach does not lead west; `wreck-shallows-ribs`
  stands in the shallows at its foot so that wading along the shore does not
  either. The east side ends at the bay. The valley opens only at its north
  end, beside the camp.
- **The camp** (`camp`) is at the head of the valley, about 100 cells of road from the
  wreck. It is one house, `camp-pub`, and six decorative tents round the
  fire, each with a few things in front of it and a `bedroll`. Every
  townsfolk there, and Tove at the wreck, has a `bed` spot on its own
  bedroll, so nobody walks indoors to sleep; the spot is in map
  coordinates and goes stale if the camp moves, after which `keeps-hours`
  falls back to the nearest bedroll. The pub stocks a fifth of the usual
  food and nothing else (`foodOnly`, `stockPercent: 20`), and the loose
  barrel and box hold a bite each: gear is found or bought further on.
- **A safe haven.** Runa Hask stands at the camp's south edge, where the
  road comes up, and shoots any hostile creature that comes within nine
  cells of her post. Rabbits and deer are left for players.
- **The old harbour** (`old-harbour`) is a short walk east of the camp. Its
  warehouse cellar is the first small dungeon: four rats and a nature slime,
  and a sixth of a storage cellar's food (`stockPercent: 15`).
- **Creatures on the way** are sized for about ten players levelling at once
  without clearing the valley: `wreck-valley-game` scatters rats, small
  nature slimes, rabbits and deer with `spacing` and no `clumping`, two snakes
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
