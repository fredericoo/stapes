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
  (`wreck-hills-sand-*`, whose fill lays `sand` with `grass` on it along its
  `edge`, so grass fades into the sand on every side). A ring of `grass` laid
  by a separate layer through an inner mask comes apart into small pieces,
  and the `grass` component drops pieces under 16 cells, so the rim belongs
  to the fill. A patch must sit on one level and keep a cell off any brink,
  or the landscape check finds it in pieces or the sand meets the brink with
  no rim; a small frame draws its oval mask as a near-square unless
  `raggedScale` is small, so the masks use `ragged` 90 and `raggedScale` 3.
  The patches are masked out of `shore-slimes`, which reads any sand as
  shore. The west hill
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

## Rating zones

A player's journey runs through five zones, each sized for what the player
carries by the time they reach it. A zone's number is the player rating it
expects, read as the **even level** that `bun run verify ratings` prints for
a creature: the level at which a player with Sharp, Toughness and Agility all
at that level, holding that level's sword, wins as often as it loses. A
player's rating is about that level. The creature's own ⭐ rating is roughly
twice its even level, so do not place by the star.

| zone | player rating | where | kit on arrival | hostiles (even level) |
| ---- | ------------- | ----- | -------------- | --------------------- |
| 0 | 1–5 | the wreck valley, the camp, the old harbour cellar, `wreck-cave` | none | rat 1, bat 1, small slimes 1–2, two snakes 8 off the road |
| 1 | 5–15 | the roads between the camp, the inn and both towns, and the land beside them: `camp-heath`, `meadow-pests`, `lake-shore`, `south-shore`, `south-downs`, `west-shore`, `woodland-wilds` | bow, hammer or axe, cap and boots (requirement 5) | rats, snakes 8, nature, water and fire slimes 5, and moss and tide wisps by night |
| 2 | 15–50 | the deep woods off the roads (`wood-wolves`), `north-wilds`, `west-wilds`, the bog, the desert, `sunken-crypt`, `bat-cave`, `bear-den` | the towns' second tier (requirement 10–15), then the third (22–33) | wolf 15, bog imp 14, skeleton 24, snow wolf 28, bear 35, with zone-1 kinds among them |
| 3 | 50+ | the peak, `ice-caves` | third tier | snow wolf 28 on the way, the yeti 65 for a party |
| 4 | 65+ | `obsidian-deeps`, the lava gorge | — | cave troll 35 today; the zone has no creature that fits it yet |

Rules that follow from the table:

- **A zone-1 road has no zone-2 hostile within reach of it.** Wolves and bog
  imps walk up to 10 and 18 cells from where they were placed before their
  home leash turns them back, and a wolf notices a player 9 cells off at
  night. A wolf outpaces a player (a step in 140 ms against 200 ms), so one
  that notices a new player kills them. `wood-wolves` therefore carries a
  subtract mask `from` each of `camp-to-druids`, `druids-to-inn` and
  `hamlet-road`, and from `druid-town`, grown 24 cells; `bog-imps` carries
  one from `witch-path`. A grown mask steps to four neighbours, so 24 steps
  reach about 17 cells along a diagonal and the nearest wolf home is 24
  cells from those roads. A road that is moved keeps its mask, because the
  mask follows the road's own cells.
- **A dangerous creature beside a road is in a den.** The bear sits inside
  `bear-den` on its hill, near `hamlet-road`, and a player meets it only by
  walking in. That is the one kind of danger a zone-1 road may pass.
- **A scatter of hostiles is a few packs, not a carpet.** At `density` 1 the
  deep woods held about 1,090 wolves joined into chains of up to 56, and the
  snowfield 386 snow wolves within sight of one another. `wood-wolves` is at
  0.15 and `peak-beasts` at 0.3, both with `clumping` 100, which leaves about
  120 wolves and 67 snow wolves, mostly alone or in twos and threes.
  `bog-imps` is at 0.6 and `desert-slimes` at 0.3.
- **Every stretch of land has something on it, and more than one kind.** Each
  zone-1 and zone-2 area has its own scatter mixing three to six kinds, with
  `spacing` so they are spread rather than clumped, at about one creature per
  800 cells. Only the camp's ring (Runa Hask's post) and the wreck valley's
  hilltops are left empty on purpose. A zone-2 scatter carries a subtract mask
  `from` each zone-1 road and town it borders, grown 24 cells; a zone-1 scatter
  needs only to stay off the towns' streets.
