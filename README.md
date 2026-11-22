# buckeye-survivor

A Mech Royale (`mechfight/1`) bot written in TypeScript and run with Bun. It plays for placement: it stays alive, keeps ahead of the zone, and fights when it has to or has an edge.

## Files

| File | Purpose |
| --- | --- |
| `bot.ts` | Entry point (stdin/stdout loop via the kit wrapper). |
| `brain.ts` | Decisions: zone timing, looting, combat, retreat, upgrades. |
| `world.ts` | Map model: 2 m walkability grid, A* pathfinding, line of sight against prisms and terrain. |
| `mechfight.ts` | Kit wrapper, unchanged. |
| `arena/` | Copy of the map, used only if `hello.map.dir` can't be read. |

## Behaviour

- **Zone:** works out when the shrinking circle will reach its position and leaves early enough to walk (or boost) into the next circle with a margin.
- **Navigation:** A* on a wall-inflated grid with line-of-sight path smoothing, wall repulsion, and jump-and-jet when stuck.
- **Loot:** walks to weapons, cubes, and uncontested supply drops when that is safe for the zone. Shoots crates when nothing is around. Ends up with laser + lightning when it can.
- **Combat:**
  - gun shots lead the target and fire only when the shot is lined up and not blocked;
  - laser charges fully and is released on target;
  - lightning fires whenever a target is in its cone;
  - mortar uses a ballistic solution and lobs over cover;
  - keeps its torso on the attacker to avoid ×1.5 rear damage, and strafes randomly (left / right / stop) to beat lead aiming;
  - dodges charging lasers, incoming bullets, and mortar landings.
- **Survival:** takes cover while reloading. Retreats out of line of sight when losing the damage trade, low on HP, or outnumbered. Turns toward and evades attackers it can't see.
- **Upgrades:** armor > plating > nanites > laser/lightning > gun > the rest.

## Check locally

```sh
docker build --platform linux/amd64 -t mech-bot .
python3 check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" mech-bot
```
