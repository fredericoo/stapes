# The map of Rune Isle

Where everything on the surface of `data/map.json` is, and who lives and works
where. **This file is written by `bun run generate:island`** together with the
map, so an edit here is lost the next time the map is generated; change
`scripts/island/` instead. Coordinates are map cells, `x, y, level`. The wreck
beach, where a player wakes, is `0, 0`; north is negative `y`.

The island is seed 75599 of the reference generator at 0.5 cells per pixel of
`docs/lore-map.webp`, inside the sketch's coastline. A step takes
200 ms and movement is four-way, so a road's length in cells is its walking time.

No character or creature is placed yet. The tile ids below are the ones draft
PR #699 gives the cast, so placing each character is putting their tile on the
cell beside their bed or at their place of work.

## Places

| Place | Where | Level |
| --- | --- | --- |
| Wreck beach | 0, 0 | 0 |
| The wreck | -2, 6 | 0 |
| The camp | -9, -85 | 1 |
| Bat cave | -40, -53 | 1 |
| The druids' town | -154, -196 | 1 |
| The barrow | -92, -139 | 0 |
| Frost caves | -98, -247 | 1 |
| Bear caves | -162, -279 | 2 |
| Deep woods | -236, -263 | 1 |
| The bog | -249, -93 | 0 |
| Witch's house | -182, -147 | 0 |
| Roadside inn | -14, -227 | 1 |
| The lake | 30, -213 | 1 |
| The warriors' town | 81, -192 | 1 |
| Ember deeps | 164, -201 | 1 |
| Lava gorge | 151, -186 | 1 |
| The lighthouse | 110, -32 | 0 |
| Old harbour ruins | 76, -33 | 0 |
| The White Peak | -56, -323 | 7 |
| Ice hollow | 1, -296 | 4 |
| Sea grotto | 33, -35 | 0 |
| Snake hollow | 96, -121 | 1 |
| Wolf den | -89, -186 | 0 |
| Troll cave | -209, -206 | 1 |

## Who lives and works where

| Tile id | Name | Home | Bed | Works at | Work cell |
| --- | --- | --- | --- | --- | --- |
| `tove-arnesdatter` | Tove Arnesdatter | Tove's lean-to at the beach end of the camp | -6, -75, L1 | Wreck beach at dawn, the camp by day | -10, -85, L1 |
| `idris-kaya` | Idris Kaya | Idris's awning beside the path | -4, -82, L1 | Under the awning beside the path | -2, -83, L1 |
| `ifeoma-nwachukwu` | Ifeoma Nwachukwu | Ifeoma's cook tent at the cookfire | -17, -81, L1 | The cookfire | -9, -86, L1 |
| `peregrine-voss` | Peregrine Voss | Peregrine's tent and trap bench | -18, -91, L1 | Trap bench by the salvage pile | -19, -91, L1 |
| `wenna-pascoe` | Wenna Pascoe | Wenna's shack at the salvage pile | 5, -81, L1 | The salvage pile and the wreck beach | 8, -82, L1 |
| `jory-thistlewood` | Jory Thistlewood | In the open beside his barrow | -7, -97, L1 | His barrow at the path's fork towards the two towns | -6, -96, L1 |
| `iolanthe-sarno` | Iolanthe Sarno | Council house | -184, -223, L2 | Council house | -187, -220, L1 |
| `hesper-vaun` | Hesper Vaun | Hesper's cell behind the temple | -190, -208, L1 | Rune temple, the carving table between the forges | -173, -225, L1 |
| `dagny-rook` | Dagny Rook | Dagny's house | -173, -202, L1 | Rune temple, the clerk's desk by the door | -170, -224, L1 |
| `amaru-quispe` | Amaru Quispe | Weaving house | -162, -220, L2 | Weaving house | -160, -219, L1 |
| `noor-halabi` | Noor Halabi | Apothecary | -155, -205, L1 | Apothecary | -155, -208, L1 |
| `pell-marrow` | Pell Marrow | Bakehouse | -162, -202, L1 | Bakehouse | -165, -203, L1 |
| `suvi-kallio` | Suvi Kallio | Suvi's cottage by the garden plots | -203, -217, L1 | Garden plots on the town's west side | -196, -214, L1 |
| `casimir-wren` | Casimir Wren | Apothecary | -157, -205, L2 | The streets: lamplighter | -182, -206, L1 |
| `mina-dross` | Mina Dross | Granary | -154, -219, L1 | Granary | -152, -219, L1 |
| `rosalind-peake` | Rosalind Peake | Ledger house | -181, -201, L1 | Ledger house | -182, -203, L1 |
| `orrin-fask` | Orrin Fask | Long house | -194, -209, L1 | Long house | -198, -209, L1 |
| `fen-achterberg` | Fen Achterberg | Ledger house | -179, -201, L2 | Rune temple steps | -172, -220, L1 |
| `taavi-kask` | Taavi Kask | Wardens' house | -198, -219, L1 | Rune temple door (day warden) | -174, -220, L1 |
| `nadia-ferreira` | Nadia Ferreira | Wardens' house | -195, -218, L1 | The streets at night (night warden) | -173, -215, L1 |
| `ragna-holt` | Ragna Holt | Longhall | 83, -207, L1 | Longhall | 86, -204, L1 |
| `absalom-grieve` | Absalom Grieve | Absalom's house beside the drill yard | 73, -193, L1 | Drill yard | 72, -182, L1 |
| `brannoc-hale` | Brannoc Hale | Smithy | 102, -197, L2 | Smithy | 104, -195, L1 |
| `selin-arslan` | Selin Arslan | Bowyer's shop by the east gate | 119, -194, L1 | Bowyer's shop | 117, -194, L1 |
| `mateo-ferran` | Mateo Ferran | Spear shed by the drill yard | 87, -171, L1 | Spear shed; the longhall at night | 87, -172, L1 |
| `halina-brzeska` | Halina Brzeska | Armoury | 104, -180, L1 | Armoury | 104, -183, L1 |
| `bertha-oyelaran` | Bertha Oyelaran | Smokehouse by the south gate | 100, -168, L1 | Smokehouse | 97, -169, L1 |
| `magda-fenwick` | Magda Fenwick | Trophy shed outside the north gate | 97, -216, L1 | Trophy shed | 97, -217, L1 |
| `tobiah-marsh` | Tobiah Marsh | Tobiah's house by the south gate | 87, -160, L1 | The streets: lamplighter | 84, -196, L1 |
| `rukmini-desai` | Rukmini Desai | Storehouse by the drill yard | 81, -178, L1 | Storehouse | 84, -179, L1 |
| `edda-kell` | Edda Kell | North gatehouse | 87, -215, L1 | North gate | 92, -211, L1 |
| `aurelio-benedetti` | Aurelio Benedetti | Cooperage by the smokehouse | 97, -175, L1 | Cooperage | 97, -177, L1 |
| `sigrun-halde` | Sigrun Halde | Smokehouse by the south gate | 99, -167, L1 | Bench at the drill yard | 69, -178, L1 |
| `gideon-okafor` | Gideon Okafor | East gatehouse | 116, -184, L1 | East gate, facing the Red Waste | 122, -189, L1 |
| `liv-sandvik` | Liv Sandvik | Barracks by the drill yard | 59, -179, L1 | The walls at night | 96, -213, L2 |
| `margit-oslund` | Margit Oslund | Roadside inn, the room behind the bar | -22, -240, L1 | Behind the bar | -20, -240, L1 |
| `kofi-asante` | Kofi Asante | Roadside inn, the loft | -11, -241, L2 | The inn's kitchen and cellar | -17, -239, L1 |
| `rodrigo-vela` | Rodrigo Vela | The room over the stable | -1, -240, L2 | The same table every night | -17, -239, L1 |
| `hamid-sarraf` | Hamid Sarraf | Roadside inn, a guest bed | -22, -241, L2 | The roads between the towns and the camp (pedlar) | — |
| `anselm-quaye` | Anselm Quaye | Roadside inn, a guest bed (assumed) | -11, -239, L2 | A circuit of the island's roads (pilgrim) | — |
| `yeva-kostenko` | Yeva Kostenko | Roadside inn, a guest bed; or either town at dusk | -22, -239, L2 | The roads between the towns (courier) | — |
| `morwen-teague` | Morwen Teague | The witch's house on stilts at the bog's edge | -180, -159, L0 | Her house and the bog by night | -182, -159, L0 |

Beds nobody in the cast sleeps in:

- (spare bunk): Barracks by the drill yard, 56, -179, L1
- (spare bunk): Barracks by the drill yard, 58, -179, L1
- (spare bunk): Barracks by the drill yard, 57, -179, L1
- (guest bed for players): Roadside inn, -11, -237, L2

## Buildings

| Building | North-west corner | South-east corner | Level | Storeys | Door |
| --- | --- | --- | --- | --- | --- |
| Tove's lean-to at the beach end of the camp | -9, -79 | -5, -74 | 1 | 1 | -9, -77 (w) |
| Idris's awning beside the path | -5, -85 | 0, -81 | 1 | 1 | -3, -85 (n) |
| Ifeoma's cook tent at the cookfire | -19, -85 | -15, -80 | 1 | 1 | -17, -85 (n) |
| Peregrine's tent and trap bench | -21, -93 | -17, -88 | 1 | 1 | -19, -88 (s) |
| Wenna's shack at the salvage pile | 2, -85 | 6, -80 | 1 | 1 | 4, -85 (n) |
| Rune temple | -180, -231 | -166, -221 | 1 | 1 | -173, -221 (s) |
| Council house | -190, -225 | -183, -215 | 1 | 2 | -187, -215 (s) |
| Wardens' house | -199, -221 | -194, -215 | 1 | 1 | -197, -215 (s) |
| Weaving house | -163, -222 | -157, -215 | 1 | 2 | -160, -215 (s) |
| Bakehouse | -168, -206 | -161, -200 | 1 | 1 | -165, -206 (n) |
| Apothecary | -158, -211 | -152, -204 | 1 | 2 | -155, -211 (n) |
| Ledger house | -185, -206 | -178, -200 | 1 | 2 | -182, -206 (n) |
| Granary | -155, -223 | -149, -215 | 1 | 1 | -152, -215 (s) |
| Hesper's cell behind the temple | -191, -211 | -187, -207 | 1 | 1 | -189, -211 (n) |
| Long house | -204, -211 | -193, -206 | 1 | 1 | -199, -211 (n) |
| Suvi's cottage by the garden plots | -207, -219 | -202, -215 | 1 | 1 | -205, -215 (s) |
| Dagny's house | -174, -206 | -170, -201 | 1 | 1 | -172, -206 (n) |
| Longhall | 82, -211 | 90, -196 | 1 | 1 | 86, -196 (s) |
| Smithy | 101, -199 | 107, -191 | 1 | 2 | 104, -191 (s) |
| Armoury | 101, -187 | 107, -179 | 1 | 1 | 104, -187 (n) |
| Absalom's house beside the drill yard | 69, -195 | 74, -191 | 1 | 1 | 71, -191 (s) |
| Barracks by the drill yard | 55, -187 | 60, -178 | 1 | 1 | 57, -187 (n) |
| Spear shed by the drill yard | 85, -174 | 90, -170 | 1 | 1 | 90, -172 (e) |
| Storehouse by the drill yard | 80, -182 | 88, -176 | 1 | 1 | 84, -182 (n) |
| Bowyer's shop by the east gate | 115, -197 | 120, -191 | 1 | 1 | 117, -191 (s) |
| East gatehouse | 115, -187 | 119, -183 | 1 | 1 | 117, -187 (n) |
| North gatehouse | 86, -218 | 90, -214 | 1 | 1 | 90, -216 (e) |
| Smokehouse by the south gate | 94, -172 | 101, -166 | 1 | 1 | 94, -169 (w) |
| Cooperage by the smokehouse | 94, -180 | 99, -174 | 1 | 1 | 94, -177 (w) |
| Tobiah's house by the south gate | 86, -163 | 90, -159 | 1 | 1 | 90, -161 (e) |
| Trophy shed outside the north gate | 94, -219 | 99, -215 | 1 | 1 | 94, -217 (w) |
| Roadside inn | -23, -243 | -10, -234 | 1 | 2 | -17, -234 (s) |
| Stable | -6, -242 | 0, -234 | 1 | 2 | -3, -234 (s) |
| The witch's house on stilts at the bog's edge | -184, -162 | -179, -156 | 0 | 1 | -182, -156 (s) |
| The harbour ruins (7 roofless buildings, the first the chapel) | 34, -51 | 89, -28 | 0 | 1 | 34, -51 (s) |
| The lighthouse | 97, -37 | 113, -21 | 0 | 14 | 105, -37 (n) |

## The lamplighters' routes

Each town's lamp posts are `lamppost-off` beside its streets, and only the two
towns have them, because only they have a lamplighter. The posts are listed in
the order a walk from the first one reaches them, nearest next.

- **Casimir Wren · druids' town streets**, 15 posts: -210, -242; -208, -233; -208, -224; -208, -215; -193, -215; -184, -211; -182, -220; -171, -220; -175, -206; -156, -215; -147, -215; -136, -218; -137, -209; -137, -200; -137, -191.
- **Tobiah Marsh · warriors' town streets**, 19 posts: 53, -219; 55, -210; 55, -201; 55, -192; 64, -191; 80, -183; 89, -182; 98, -182; 94, -173; 94, -163; 83, -158; 74, -158; 83, -195; 94, -200; 94, -209; 91, -218; 108, -191; 121, -191; 131, -194.

## Roads

| From | To | Cells | Walk |
| --- | --- | --- | --- |
| Wreck beach | The camp | 95 | 19 s |
| The camp | The druids' town | 259 | 52 s |
| The camp | The warriors' town | 198 | 40 s |
| The druids' town | Roadside inn | 206 | 41 s |
| Roadside inn | The warriors' town | 131 | 26 s |
| The warriors' town | The lighthouse | 210 | 42 s |
| The camp | Old harbour ruins | 158 | 32 s |
| Old harbour ruins | The lighthouse | 36 | 7 s |
| The warriors' town | Ember deeps | 171 | 34 s |
| The druids' town | Deep woods | 150 | 30 s |
| The druids' town | Frost caves | 108 | 22 s |

3 bridges carry roads over rivers; elsewhere a road wades the river at a ford.
46 ramps join the terraces, and every cell a player can reach has a way back.
