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
  follow the road.
- **The valley.** `wreck-west-hill` and `wreck-east-hill` are steep hills either
  side of the road (`beach-path`) from the wreck to the camp. The west hill
  runs down to the sea, so the beach does not lead west; `wreck-shallows-ribs`
  stands in the shallows at its foot so that wading along the shore does not
  either. The east side ends at the bay. The valley opens only at its north
  end, beside the camp.
- **The camp** (`camp`) is at the head of the valley, about 100 cells of road from the
  wreck. Its houses stock their containers with food only (`foodOnly`), and so
  are the loose barrel and box: gear is found or bought further on.
- **Creatures on the way** are sized for about ten players levelling at once
  without clearing the valley: `wreck-valley-game` scatters rats, rabbits and
  deer with `spacing` and no `clumping`, two snakes stand in the valley, and
  three bats live in `wreck-cave`, which opens on the valley side of the west
  hill. Nothing stronger is placed between the wreck and the camp.

Moving the camp, the road or either hill changes all of this at once; check
from the castaway's cell that the only dry way out of the valley is past the
camp.
