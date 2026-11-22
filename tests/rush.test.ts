import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Brain, OPT } from "../brain.ts"

const fixtureData = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"))
const hello = fixtureData.hello
function fixture() {
  const b = new Brain(hello, {} as any)
  b.world = null // Isolate decisions from map geometry and pathfinding time.
  const o = structuredClone(fixtureData.observation)
  Object.assign(o, { t: 0, tick: 0, mechs: [], sounds: [], events: [], cubes: [], pickups: [], crates: [], projectiles: [], drops: [], offer: null })
  Object.assign(o.self, { pos: [0, 0, 0], aim: [0, Math.atan2(1.75 - o.self.stats.muzzle_height, 60)], hp: 1400, max_hp: 1400, cubes: 0, in_zone: true })
  Object.assign(o.zone, { center: [0, 0], radius: 560, next_center: [0, 0], next_radius: 380, shrink_start: 60, shrink_end: 110 })
  const drone = { id: 100, kind: "npc", pos: [60, 0, 0], vel: [0, 0, 0], aim: [Math.PI, 0], hp: 350, max_hp: 350 }
  o.mechs = [drone]
  return { b, o, drone }
}
function step(o: any, t = 0.1) { o.t = t; o.tick = Math.round(t * 20) }

test("opening rush survives the old unconditional zone overwrite", () => {
  const { b, o } = fixture(); const a = b.act(o)
  assert.equal(b.errors, 0); assert.equal(b.mode, "rush")
  assert.ok(a.move![0] > 0.9); assert.equal(a.fire![0], true)
})
test("tracks the same moving drone by id", () => {
  const { b, o, drone } = fixture(); b.act(o)
  step(o); drone.pos = [65, 8, 0]; b.act(o)
  assert.equal(b.spawnRushId, 100); assert.deepEqual(b.spawnRushTarget, drone.pos)
})
test("briefly losing sight keeps pursuit without blind gunfire", () => {
  const { b, o } = fixture(); b.act(o)
  step(o); o.mechs = []; const a = b.act(o)
  assert.equal(b.mode, "rush"); assert.equal(b.spawnRushId, 100); assert.equal(a.fire![0], false)
})
test("drone damage does not cancel the rush", () => {
  const { b, o } = fixture(); b.act(o)
  step(o); o.events = [{ type: "damaged", amount: 25, weapon: "npc", by: 100, bearing: 0 }]; o.self.hp -= 25
  b.act(o); assert.equal(b.mode, "rush")
})
test("player damage and an unsafe zone take precedence", () => {
  const { b, o } = fixture(); b.act(o)
  step(o); o.events = [{ type: "damaged", amount: 45, weapon: "gun", by: 1, bearing: 1 }]
  b.act(o); assert.notEqual(b.mode, "rush")
  const f = fixture(); f.o.self.in_zone = false; f.b.act(f.o)
  assert.equal(f.b.mode, "zone")
})
test("collects the kill reward before detouring for weapons", () => {
  const { b, o } = fixture(); b.act(o)
  step(o); o.mechs = []; o.cubes = [{ id: 5000, pos: [60, 0, 0] }]; o.pickups = [{ id: 8000, kind: "laser", pos: [0, 30, 0] }]
  const a = b.act(o); assert.equal(b.mode, "rush"); assert.ok(a.move![0] > 0.9)
  step(o, 0.2); o.self.cubes = 2; b.act(o); assert.equal(b.spawnRushDone, true); assert.notEqual(b.mode, "rush")
})
test("sound guides search, and a sighting replaces its uncertain waypoint", () => {
  const { b, o, drone } = fixture(); o.mechs = []; o.sounds = [{ kind: "npc_gun", bearing: 1, dist: "mid", age: 0 }]
  const a = b.act(o); assert.equal(b.mode, "rush"); assert.equal(b.spawnRushId, null); assert.deepEqual(a.fire, [false, false])
  step(o); o.sounds = []; o.mechs = [drone]; b.act(o); assert.equal(b.spawnRushId, drone.id); assert.deepEqual(b.spawnRushTarget, drone.pos)
})
test("uses projectile lead and pitch checks rather than firing on yaw alone", () => {
  const { b, o, drone } = fixture(); drone.vel = [0, 10, 0]; const a = b.act(o)
  assert.ok(a.aim![0] > 0); assert.equal(a.fire![0], false)
  o.self.aim = [a.aim![0], 0.5]; step(o); assert.equal(b.act(o).fire![0], false)
})
test("times out and can be disabled for paired evaluations", () => {
  const { b, o } = fixture(); step(o, 31); b.act(o); assert.equal(b.spawnRushDone, true)
  OPT.rush = false
  try { const f = fixture(); f.b.act(f.o); assert.notEqual(f.b.mode, "rush") } finally { OPT.rush = true }
})

test("scans for drones outside the initial field of view", () => {
  const { b, o } = fixture(); o.mechs = []; o.self.aim = [0, 0]
  assert.ok(b.act(o).aim![0] > 1)
})
test("low health cancels the opening objective", () => {
  const { b, o } = fixture(); b.act(o); step(o); o.self.hp = 600
  b.act(o); assert.equal(b.spawnRushDone, true); assert.notEqual(b.mode, "rush")
})

test("takes a short detour for a laser before committing to a distant drone", () => {
  const { b, o } = fixture()
  o.pickups = [{ id: 8000, kind: "laser", pos: [0, 40, 0] }]
  const action = b.act(o)
  assert.equal(b.mode, "equip")
  assert.ok(action.move![1] > 0.9)
  assert.equal(action.boost, true)
})

test("prefers a laser to an in-range mortar", () => {
  const { b, o } = fixture()
  o.pickups = [
    { id: 8000, kind: "mortar", pos: [1, 0, 0] },
    { id: 8001, kind: "laser", pos: [2, 0, 0] },
  ]
  assert.equal(b.act(o).take, 8001)
})

test("clears the defeated attacker and moves to its dropped cubes", () => {
  const { b, o, drone } = fixture()
  const enemy = { ...drone, id: 1, kind: "mech", hp: 30, max_hp: 1400 }
  o.mechs = [enemy]
  o.events = [{ type: "damaged", by: 1, weapon: "gun", bearing: 0, amount: 45 }]
  b.act(o)
  step(o)
  o.mechs = []
  o.events = [{ type: "kill", target: 1 }]
  o.cubes = [{ id: 5000, pos: [60, 1, 0] }]
  o.pickups = [{ id: 8000, kind: "mortar", pos: [0, 25, 0] }]
  const action = b.act(o)
  assert.equal(b.enemies.has(1), false)
  assert.equal(b.attackers.has(1), false)
  assert.equal(b.mode, "kill-cubes")
  assert.ok(action.move![0] > 0.9)
  assert.deepEqual(action.fire, [false, false])
})

function usePredictiveDodge(run: () => void) {
  const previous = OPT.predictDodge
  OPT.predictDodge = true
  try { run() } finally { OPT.predictDodge = previous }
}

test("ignores shots above the mech", () => usePredictiveDodge(() => {
  const { b, o } = fixture()
  o.mechs = []
  o.projectiles = [{ id: 1, kind: "gun", pos: [50, 1, 20], vel: [-252, 0, 0] }]
  assert.deepEqual(b.act(o).move, [0, 0])
}))

test("dodges a shot that intersects the mech's current movement", () => usePredictiveDodge(() => {
  const { b, o } = fixture()
  o.mechs = []
  o.self.vel = [0, 11, 0]
  o.projectiles = [{ id: 1, kind: "gun", pos: [100, 4.4, 4], vel: [-252, 0, 0] }]
  assert.ok(Math.abs(b.act(o).move![1]) > 0.9)
}))

test("uses the most imminent shot when two shots call for opposite moves", () => usePredictiveDodge(() => {
  const { b, o } = fixture()
  o.mechs = []
  o.projectiles = [
    { id: 1, kind: "gun", pos: [50, 1, 4], vel: [-252, 0, 0] },
    { id: 2, kind: "gun", pos: [95, -1, 4], vel: [-252, 0, 0] },
  ]
  assert.ok(b.act(o).move![1] < -0.9)
}))
