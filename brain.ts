/** Decision making: zone, navigation, looting, combat. */
import type { ActorObs, BotAction, Hello, Observation, PickupObs, SelfObs, WeaponObs } from "./mechfight.ts"
import { World } from "./world.ts"

const env = (globalThis as any).process?.env ?? {}
export const OPT = { keepGun: env.MF_KEEPGUN === "1", noCover: env.MF_NOCOVER === "1", cautious: env.MF_CAUTIOUS === "1", hide: env.MF_HIDE === "1", lootR: Number(env.MF_LOOTR ?? 160), strafe: Number(env.MF_STRAFE ?? 1), sweep: env.MF_SWEEP === "1", stealth: env.MF_STEALTH !== "0", passive: env.MF_PASSIVE === "1", budget: Number(env.MF_BUDGET ?? 9), edge: env.MF_EDGE === "1", mover: env.MF_MOVE === "1", farm: env.MF_FARM !== "0", rush: env.MF_RUSH !== "0", equipFirst: env.MF_EQUIP_FIRST !== "0", duel: env.MF_DUEL !== "0", collectKill: env.MF_COLLECT_KILL !== "0", predictDodge: env.MF_PREDICT_DODGE !== "0", finish: env.MF_FINISH === "1", recover: env.MF_RECOVER === "1", seek: env.MF_SEEK === "1", arc: env.MF_ARC === "1", aimRange: env.MF_AIMRANGE === "1", plan: env.MF_PLAN === "1", rank: env.MF_RANK === "1", commitW: Number(env.MF_COMMIT_W ?? 140), commitS: Number(env.MF_COMMIT_S ?? 6), laserEarly: Number(env.MF_LASER_EARLY ?? 0.2), calmHp: Number(env.MF_CALM_HP ?? 0.88), scoop: env.MF_SCOOP === "1", antiLtg: env.MF_ANTI_LTG === "1" }
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const angDiff = (a: number, b: number) => wrap(a - b)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const d2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])

type Enemy = { id: number; pos: number[]; vel: number[]; aim: number[]; hp: number; maxHp: number; cubes: number; weapons: string[]; charging: boolean; seen: number; npc: boolean }
type Mem<T> = { item: T; seen: number }

const UPGRADE_PRIORITY = [
  "armor", "plating", "gun_damage", "laser_damage", "nanites", "laser_charge", "lightning_efficiency", "lightning_range",
  "gun_rate", "gyros", "lightning_chain", "servos", "gun_mag", "gun_velocity", "capacitor",
  "reactor", "jets", "mortar_reload", "mortar_velocity", "mortar_splash", "sensors", "laser_pierce",
]
const WEAPON_VALUE: Record<string, number> = { laser: 3, lightning: 3, mortar: 1, gun: 0 }

export class Brain {
  cfg: any
  world: World | null = null
  rng: () => number
  slot: number

  enemies = new Map<number, Enemy>()
  pickups = new Map<number, Mem<PickupObs>>()
  cubes = new Map<number, Mem<{ id: number; pos: number[] }>>()
  crates = new Map<number, Mem<{ id: number; pos: number[]; hp: number }>>()
  badPickups = new Map<number, number>() // id -> until t
  attackers = new Map<number, { t: number; bearing: number; weapon: string }>()
  threatBearings: { t: number; bearing: number; dist: string; kind: string }[] = []
  lastDamageT = -100
  taken: { t: number; a: number; by?: number }[] = []
  dealt: { t: number; a: number }[] = []
  lastDealT = -100
  zoneStart = new Map<number, { c: number[]; r: number }>()

  // navigation
  path: [number, number][] | null = null
  pathGoal: number[] | null = null
  pathT = -100
  stuckRef: { t: number; p: number[] } = { t: 0, p: [0, 0] }
  stuckUntil = -1
  unstickDir = 0

  // spawn rush
  spawnRushTarget: number[] | null = null
  spawnRushId: number | null = null
  spawnRushSeen = -100
  spawnRushDone = false

  // combat
  strafeSign = 1
  strafeFlipT = 0
  laserHoldStart = -1
  retreatUntil = -1
  retreatSpot: number[] | null = null
  retreatSpotT = -100
  retreatHp = 0.6
  mode = "init"
  holdSpot: number[] | null = null
  holdKey = ""
  holdRefineT = -100
  patrol: number[] | null = null
  patrolT = 0
  scanT = 0
  scanIdx = 0
  lastTargetId = -1
  hitT = new Map<number, number>()
  recoverSpot: number[] | null = null
  recoverSpotT = -99
  seekGoal: number[] | null = null
  seekT = -99
  laserFiredT = new Map<number, number>()
  obsT = 0
  planDir: number[] = [0, 0]
  lastTargetT = -100
  lastKill: { pos: number[]; t: number } | null = null
  t = 0

  constructor(hello: Hello, shared?: World) {
    this.cfg = hello.config
    this.slot = hello.slot
    let s = (hello.seed >>> 0) || 12345
    this.rng = () => {
      s ^= s << 13; s >>>= 0
      s ^= s >>> 17
      s ^= s << 5; s >>>= 0
      return s / 4294967296
    }
    if (shared) { this.world = shared; return }
    const here = new URL(".", import.meta.url).pathname
    for (const dir of [hello.map?.dir, "/arena", here + "arena", "arena"]) {
      if (!dir) continue
      try {
        this.world = new World(dir)
        break
      } catch (e) {
        console.error(`world load failed from ${dir}: ${(e as Error).message}`)
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  weapon(me: SelfObs, kind: string): [WeaponObs | null, number] {
    for (let i = 0; i < me.weapons.length; i++) {
      const w = me.weapons[i]
      if (w && w.kind === kind) return [w, i]
    }
    return [null, -1]
  }
  scale(cubes: number) {
    return 1 + (this.cfg.cubes.size_per_cube ?? 0.05) * (cubes || 0)
  }
  los(a: number[], b: number[]) {
    return this.world ? this.world.los(a, b) : true
  }

  /** Zone circle at time tt (interpolating during shrink). */
  zoneAt(obs: Observation, tt: number): { c: number[]; r: number } {
    const z = obs.zone
    let st = this.zoneStart.get(z.shrink_start)
    if (!st) {
      st = { c: [z.center[0], z.center[1]], r: z.radius }
      if (obs.t <= z.shrink_start + 0.05) this.zoneStart.set(z.shrink_start, st)
      else {
        // first seen mid-shrink: back out the start circle assuming `center/radius` are live
        const f = clamp((obs.t - z.shrink_start) / Math.max(1e-6, z.shrink_end - z.shrink_start), 0, 0.999)
        const r0 = (z.radius - f * z.next_radius) / (1 - f)
        const c0 = [0, 1].map((i) => (z.center[i] - f * z.next_center[i]) / (1 - f))
        st = { c: c0, r: r0 }
        this.zoneStart.set(z.shrink_start, st)
      }
    }
    if (tt <= z.shrink_start) return st
    const f = clamp((tt - z.shrink_start) / Math.max(1e-6, z.shrink_end - z.shrink_start), 0, 1)
    return { c: [st.c[0] + (z.next_center[0] - st.c[0]) * f, st.c[1] + (z.next_center[1] - st.c[1]) * f], r: st.r + (z.next_radius - st.r) * f }
  }

  /** Seconds until point p is outside the zone (Infinity if never during this phase). */
  timeUntilOut(obs: Observation, p: number[]): number {
    const z = obs.zone
    for (let tt = obs.t; tt <= z.shrink_end + 0.01; tt += 1) {
      const c = this.zoneAt(obs, tt)
      if (d2(p, c.c) > c.r - 2) return tt - obs.t
    }
    if (d2(p, z.next_center) > z.next_radius - 2) return z.shrink_end - obs.t
    // next phase: assume it starts shrinking after a hold and might move anywhere in the circle
    return Infinity
  }

  /**
   * Sample move directions, roll each forward ~0.6 s with the ground
   * acceleration, and score incoming projectiles, exposure to shooters
   * (rear-arc ones weigh more), lightning reach, range to the target,
   * line of sight for our own shots, walls and the safe circle.
   */
  planMove(obs: Observation, intent: number[], target: Enemy, mechs: Enemy[], pref: number, wantCover: boolean, haveLtg: boolean, safeC: number[], safeR: number): { dir: number[]; boost: boolean } | null {
    const w = this.world
    if (!w) return null
    const me = obs.self, p = me.pos, t = obs.t
    const sc = this.scale(me.cubes)
    const st = me.stats ?? {}
    const walk = st.walk_speed ?? 11.7, run = st.boost_speed ?? 19.5, acc = st.ground_accel ?? 58.5
    const rad = 2.5 * sc + 0.5, height = 9 * sc
    const lr = this.cfg.weapons.lightning?.range ?? 45
    const shooters = mechs.filter((o) => t - o.seen < 1.5 && d2(o.pos, p) < 200).sort((a, b) => d2(a.pos, p) - d2(b.pos, p)).slice(0, 4)
    const toT = Math.atan2(target.pos[1] - p[1], target.pos[0] - p[0])
    const il = Math.hypot(intent[0], intent[1])
    const incoming = obs.projectiles.filter((pr) => false && pr.kind === "gun" && ((p[0] - pr.pos[0]) * pr.vel[0] + (p[1] - pr.pos[1]) * pr.vel[1]) > 0)
    const cands: { dir: number[]; boost: boolean }[] = [{ dir: [0, 0], boost: false }]
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      cands.push({ dir: [Math.cos(a), Math.sin(a)], boost: false })
      if (me.energy > 35 && k % 2 === 0) cands.push({ dir: [Math.cos(a), Math.sin(a)], boost: true })
    }
    if (il > 0.1) cands.push({ dir: [intent[0] / il, intent[1] / il], boost: false })
    let best: { dir: number[]; boost: boolean } | null = null, bestS = -Infinity
    for (const c of cands) {
      const spd = c.boost ? run : walk
      let x = p[0], y = p[1], vx = me.vel[0], vy = me.vel[1]
      let score = 0, blocked = false
      const hitIds = new Set<number>()
      for (let k = 1; k <= 12; k++) {
        const dt = 0.05, T = k * dt
        const tx = c.dir[0] * spd - vx, ty = c.dir[1] * spd - vy, tl = Math.hypot(tx, ty)
        const dv = Math.min(tl, acc * dt)
        if (tl > 1e-6) { vx += (tx / tl) * dv; vy += (ty / tl) * dv }
        x += vx * dt; y += vy * dt
        if ((k === 4 || k === 12) && !w.isFree(x, y, 2.4)) { blocked = true; break }
        for (const pr of incoming) {
          if (hitIds.has(pr.id)) continue
          const px = pr.pos[0] + pr.vel[0] * T, py = pr.pos[1] + pr.vel[1] * T, pz = pr.pos[2] + pr.vel[2] * T
          if (Math.hypot(px - x, py - y) < rad && pz > p[2] - 0.5 && pz < p[2] + height + 0.5) {
            hitIds.add(pr.id)
            const from = Math.atan2(pr.pos[1] - y, pr.pos[0] - x)
            score -= Math.abs(angDiff(from, toT)) > Math.PI / 2 ? 75 : 50
          }
        }
      }
      if (blocked) continue
      const q = [x, y, w.ground(x, y)]
      const chest = [x, y, q[2] + 5 * sc]
      for (const o of shooters) {
        const om = [o.pos[0], o.pos[1], o.pos[2] + 7 * this.scale(o.cubes)]
        const od = Math.hypot(o.pos[0] - x, o.pos[1] - y)
        const sees = this.los(om, chest)
        if (o.id === target.id) {
          if (sees) { if (wantCover) score -= 25 }
          else if (!wantCover) score -= 30
          score -= Math.abs(od - pref) * 0.35
        } else if (sees) {
          const rear = Math.abs(angDiff(Math.atan2(o.pos[1] - y, o.pos[0] - x), toT)) > Math.PI / 2
          score -= rear ? 38 : 22
        }
        if (o.weapons.includes("lightning") && !(haveLtg && o.id === target.id) && od < lr + 10) score -= (lr + 10 - od) * 3
      }
      const out = d2(q, safeC) - safeR
      if (out > 0) score -= out * 2
      if (il > 0.1) score += 50 * (c.dir[0] * intent[0] + c.dir[1] * intent[1]) / il
      score += 6 * (c.dir[0] * this.planDir[0] + c.dir[1] * this.planDir[1])
      score += 8 * Math.abs(c.dir[0] * Math.sin(toT) - c.dir[1] * Math.cos(toT))
      if (c.boost) score -= 4
      if (score > bestS) { bestS = score; best = c }
    }
    if (best) this.planDir = best.dir
    return best
  }

  // Extra damage we deal: rear hits (x rear_mult) and laser cook-off on mortar carriers.
  exposure(e: Enemy, p: number[], laser: boolean): number {
    const toMe = Math.atan2(p[1] - e.pos[1], p[0] - e.pos[0])
    let bonus = Math.abs(angDiff(e.aim[0], toMe)) > Math.PI / 2 ? 45 : 0
    if (laser && e.weapons.includes("mortar")) bonus += 30
    if (this.obsT - (this.laserFiredT.get(e.id) ?? -99) < 1.3) bonus += 50
    return bonus
  }

  // ---------------------------------------------------------------- memory
  observe(obs: Observation) {
    const t = obs.t
    this.obsT = t
    const me = obs.self
    for (const m of obs.mechs) {
      const e: Enemy = {
        id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, cubes: m.cubes ?? 0,
        weapons: m.weapons ?? [], charging: !!m.charging, seen: t, npc: m.kind === "npc",
      }
      this.enemies.set(m.id, e)
    }
    for (const [id, e] of this.enemies) if (t - e.seen > (e.npc ? 40 : 12)) this.enemies.delete(id)
    for (const b of obs.beams ?? []) if (b.kind === "laser" && b.by != null) this.laserFiredT.set(b.by, t - (b.age ?? 0))
    for (const p of obs.pickups) this.pickups.set(p.id, { item: p, seen: t })
    for (const c of obs.cubes) this.cubes.set(c.id, { item: c, seen: t })
    for (const c of obs.crates) this.crates.set(c.id, { item: { id: c.id, pos: c.pos, hp: c.hp ?? 300 }, seen: t })
    // forget items we should be seeing but aren't
    const pos = me.pos
    for (const map of [this.pickups, this.cubes, this.crates] as Map<number, Mem<any>>[]) {
      for (const [id, m] of map) {
        const dd = d2(m.item.pos, pos)
        if (m.seen < t && (dd < 25 || t - m.seen > 90)) map.delete(id)
      }
    }
    for (const ev of obs.events) {
      if (ev.type === "damaged") {
        if (ev.weapon !== "zone") { this.lastDamageT = t; this.taken.push({ t, a: ev.amount, by: ev.by ?? -1 }) }
        if (ev.by != null && ev.bearing != null) this.attackers.set(ev.by, { t, bearing: ev.bearing, weapon: ev.weapon })
        if (ev.bearing != null) this.threatBearings.push({ t, bearing: ev.bearing, dist: "near", kind: "damage" })
      } else if (ev.type === "hit") {
        this.lastDealT = t
        if (ev.target < 100) this.dealt.push({ t, a: ev.amount })
        if (ev.target < 100) this.hitT.set(ev.target, t)
      } else if (ev.type === "kill" && OPT.collectKill) {
        const enemy = this.enemies.get(ev.target)
        if (enemy) this.lastKill = { pos: enemy.pos, t }
        if (OPT.scoop && !this.taken.some((x) => x.by !== ev.target && t - x.t < 2.5)) {
          this.retreatUntil = -1
          this.threatBearings = this.threatBearings.filter((b) => b.kind !== "damage" || t - b.t > 3)
        }
        this.enemies.delete(ev.target)
        this.attackers.delete(ev.target)
        this.taken = this.taken.filter((hit) => hit.by !== ev.target)
      } else if (ev.type === "take_failed") {
        this.badPickups.set(ev.id, t + (ev.reason === "range" ? 1 : 30))
        if (ev.reason === "gone") this.pickups.delete(ev.id)
      } else if (ev.type === "took") {
        this.pickups.delete(ev.id)
      } else if (ev.type === "dropped") {
        this.badPickups.set(ev.id, t + 1e9) // don't pick back up what we dropped
      }
    }
    for (const s of obs.sounds) {
      if (["gun", "laser", "laser_charge", "lightning", "mortar", "step", "boost", "jet", "reload"].includes(s.kind) && s.dist !== "far")
        this.threatBearings.push({ t: t - s.age, bearing: s.bearing, dist: s.dist, kind: s.kind })
    }
    this.taken = this.taken.filter((x) => t - x.t < 6)
    this.dealt = this.dealt.filter((x) => t - x.t < 6)
    this.threatBearings = this.threatBearings.filter((b) => t - b.t < 6).slice(-30)
    for (const [id, a] of this.attackers) if (t - a.t > 8) this.attackers.delete(id)
  }

  // ---------------------------------------------------------------- navigation
  /** Returns a unit move vector toward goal using A* waypoints. */
  navTo(obs: Observation, goal: number[], avoid: { x: number; y: number; r: number; w: number }[] = []): number[] {
    const me = obs.self
    const p = me.pos
    const w = this.world
    if (!w) {
      const dx = goal[0] - p[0], dy = goal[1] - p[1], L = Math.hypot(dx, dy) || 1
      return [dx / L, dy / L]
    }
    const t = obs.t
    const goalMoved = !this.pathGoal || d2(this.pathGoal, goal) > Math.max(4, 0.1 * d2(p, goal))
    if (!this.path || goalMoved || t - this.pathT > 2.5 || this.path.length === 0) {
      if (d2(p, goal) < 3 || w.walkLine(p[0], p[1], goal[0], goal[1], 2.6)) this.path = [[goal[0], goal[1]]]
      else this.path = w.path(p[0], p[1], goal[0], goal[1], Math.max(1, Math.min(5, this.left() - 2)), avoid)
      this.pathGoal = goal
      this.pathT = t
    }
    const path = this.path
    if (!path || path.length === 0) {
      const dx = goal[0] - p[0], dy = goal[1] - p[1], L = Math.hypot(dx, dy) || 1
      return [dx / L, dy / L]
    }
    // advance waypoints
    while (path.length > 1 && (d2(p, path[0]) < 3 || w.walkLine(p[0], p[1], path[1][0], path[1][1], 2.6) && d2(p, path[0]) < 12)) path.shift()
    const wp = path[0]
    let dx = wp[0] - p[0], dy = wp[1] - p[1]
    const L = Math.hypot(dx, dy)
    if (L < 0.5) return [0, 0]
    dx /= L; dy /= L
    return this.steer(p, [dx, dy])
  }

  /** Push away from nearby walls. */
  steer(p: number[], dir: number[]): number[] {
    const w = this.world
    if (!w) return dir
    const c = w.clearAt(p[0], p[1])
    if (c >= 4) return dir
    const e = 2
    const gx = w.clearAt(p[0] + e, p[1]) - w.clearAt(p[0] - e, p[1])
    const gy = w.clearAt(p[0], p[1] + e) - w.clearAt(p[0], p[1] - e)
    const gl = Math.hypot(gx, gy)
    if (gl < 1e-6) return dir
    const k = (4 - c) / 4 * 0.6
    let x = dir[0] + (gx / gl) * k, y = dir[1] + (gy / gl) * k
    const l = Math.hypot(x, y) || 1
    return [x / l, y / l]
  }

  /** Pick the free direction closest to `dir` (for combat movement without a path). */
  freeDir(p: number[], dir: number[], look = 5): number[] {
    const w = this.world
    const L = Math.hypot(dir[0], dir[1])
    if (!w || L < 1e-6) return dir
    const base = Math.atan2(dir[1], dir[0])
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
      const a = base + off
      const x = p[0] + Math.cos(a) * look, y = p[1] + Math.sin(a) * look
      if (w.isFree(x, y, 2.6) && w.isFree(p[0] + Math.cos(a) * look * 0.5, p[1] + Math.sin(a) * look * 0.5, 2.6)) {
        if (Math.abs(off) > 1.5) this.strafeSign = -this.strafeSign
        return [Math.cos(a) * L, Math.sin(a) * L]
      }
    }
    return dir
  }

  concealCache = new Map<number, number>()
  /** Fraction of viewing directions (70 m and 130 m out) from which a mech standing at (x,y) can't be seen. */
  concealment(x: number, y: number): number {
    const w = this.world
    if (!w) return 0
    const key = Math.floor((x - w.minX) / 4) * 4096 + Math.floor((y - w.minY) / 4)
    const c = this.concealCache.get(key)
    if (c !== undefined) return c
    const g = w.ground(x, y)
    const body = [x, y, g + 4.5], head = [x, y, g + 8.5]
    let hidden = 0, n = 0
    for (let k = 0; k < 12; k++) {
      const b = (k / 12) * TAU + 0.13
      for (const r of [70, 130]) {
        const vx = x + Math.cos(b) * r, vy = y + Math.sin(b) * r
        if (vx < w.minX || vx > w.maxX || vy < w.minY || vy > w.maxY) { hidden++; n++; continue }
        const eye = [vx, vy, w.ground(vx, vy) + 8]
        n++
        if (!w.sees(eye, body) && !w.sees(eye, head)) hidden++
      }
    }
    const v = hidden / n
    this.concealCache.set(key, v)
    return v
  }

  /** Find a cover spot near `center` (within `rad`) inside the safe disk. */
  findHoldSpot(center: number[], rad: number, safeC: number[], safeR: number, threats: number[][]): number[] {
    const w = this.world
    if (!w) return center
    let best = center, bestS = -Infinity
    const t0 = performance.now()
    const z0 = 8
    for (let i = 0; i < (OPT.stealth ? 60 : 40); i++) {
      if (performance.now() - t0 > 4 || this.left() < 3) break
      const a = this.rng() * TAU, r = i === 0 ? 0 : Math.sqrt(this.rng()) * rad
      const x = center[0] + Math.cos(a) * r, y = center[1] + Math.sin(a) * r
      if (!w.isFree(x, y, 3.2)) continue
      if (Math.hypot(x - safeC[0], y - safeC[1]) > safeR) continue
      const g = w.ground(x, y)
      let cover = 0
      for (let k = 0; k < 12; k++) {
        const b = (k / 12) * TAU
        if (w.segHit([x, y, g + z0], [x + Math.cos(b) * 25, y + Math.sin(b) * 25, g + z0], false) >= 0) cover++
      }
      let s = Math.min(cover, 7) - r / 25
      if (OPT.stealth) s = this.concealment(x, y) * 12 + Math.min(cover, 7) * 0.4 - r / 30
      for (const th of threats) if (w.los([x, y, g + z0], [th[0], th[1], th[2] + 6])) s -= 3
      if (s > bestS) { bestS = s; best = [x, y] }
    }
    return best
  }

  /** A spot that breaks line of sight from threats. */
  findRetreat(p: number[], threats: number[][], safeC: number[], safeR: number): number[] | null {
    const w = this.world
    if (!w) return null
    let best: number[] | null = null, bestS = -Infinity
    const t0 = performance.now()
    for (let i = 0; i < 36; i++) {
      if (performance.now() - t0 > 4 || this.left() < 3) break
      const a = (i / 36) * TAU + this.rng() * 0.2
      const r = 18 + this.rng() * 40
      const x = p[0] + Math.cos(a) * r, y = p[1] + Math.sin(a) * r
      if (!w.isFree(x, y, 3)) continue
      if (Math.hypot(x - safeC[0], y - safeC[1]) > safeR) continue
      const g = w.ground(x, y)
      let s = -r / 15
      let seen = 0
      for (const th of threats) {
        if (w.los([x, y, g + 6], [th[0], th[1], th[2] + 7])) seen++
        s += Math.min(60, Math.hypot(x - th[0], y - th[1])) / 20
        // don't run past the threat
        const tx = th[0] - p[0], ty = th[1] - p[1]
        if ((tx * (x - p[0]) + ty * (y - p[1])) > 0) s -= 4
      }
      s -= seen * 6
      if (s > bestS) { bestS = s; best = [x, y] }
    }
    return best
  }

  // ---------------------------------------------------------------- aiming
  /** Lead-aim point for a projectile of speed v from muzzle m at enemy e. */
  leadPoint(m: number[], e: Enemy, v: number, tlag = 0): number[] {
    const sc = this.scale(e.cubes)
    const cz = e.npc ? 1.75 : 4.5 * sc
    const g = this.cfg.mech.gravity ?? 22
    let tt = 0
    let pt = [e.pos[0], e.pos[1], e.pos[2] + cz]
    const age = Math.max(0, this.t - e.seen)
    for (let i = 0; i < 3; i++) {
      const T = tt + tlag + age
      let z = e.pos[2] + e.vel[2] * T
      if (Math.abs(e.vel[2]) > 0.5) z -= 0.5 * g * T * T * 0.5
      const gr = this.world ? this.world.ground(e.pos[0] + e.vel[0] * T, e.pos[1] + e.vel[1] * T) : -1e9
      z = Math.max(z, gr)
      pt = [e.pos[0] + e.vel[0] * T, e.pos[1] + e.vel[1] * T, z + cz]
      tt = Math.hypot(pt[0] - m[0], pt[1] - m[1], pt[2] - m[2]) / v
    }
    return pt
  }

  aimAt(m: number[], pt: number[]): [number, number] {
    const dx = pt[0] - m[0], dy = pt[1] - m[1], dz = pt[2] - m[2]
    return [Math.atan2(dy, dx), Math.atan2(dz, Math.hypot(dx, dy))]
  }

  /** Is the actual aim close enough to hit a target of half-width hw and half-height hh at point pt? */
  onTarget(me: SelfObs, m: number[], pt: number[], hw: number, hh: number): boolean {
    const [yaw, pitch] = me.aim
    const want = this.aimAt(m, pt)
    const D = Math.hypot(pt[0] - m[0], pt[1] - m[1], pt[2] - m[2])
    const ey = Math.abs(angDiff(yaw, want[0])) * D
    const ep = Math.abs(pitch - want[1]) * D
    return ey < hw && ep < hh
  }

  /** Mortar pitch to hit pt from m. Returns [low, high] (null if out of range). */
  mortarPitch(m: number[], pt: number[], v: number, g: number): [number, number] | null {
    const D = Math.hypot(pt[0] - m[0], pt[1] - m[1])
    const dz = pt[2] - m[2]
    const v2 = v * v
    const disc = v2 * v2 - g * (g * D * D + 2 * dz * v2)
    if (disc < 0) return null
    const sq = Math.sqrt(disc)
    return [Math.atan((v2 - sq) / (g * D)), Math.atan((v2 + sq) / (g * D))]
  }

  // ---------------------------------------------------------------- main
  tickStart = 0
  /** ms left of this decision's compute budget */
  left(total = OPT.budget) {
    return total - (performance.now() - this.tickStart)
  }

  /** Run the hot code paths on synthetic observations so the JIT has compiled them before the match. */
  static warmup(hello: Hello, world: World, ms = 1500) {
    const t0 = performance.now()
    const tmp = new Brain(hello, world)
    const c = hello.config.zone.start_center
    let k = 0
    while (performance.now() - t0 < ms && k < 400) {
      const a = (k * 2.39996) % (Math.PI * 2), r = 50 + (k * 37) % 300
      const me = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]
      me.push(world.ground(me[0], me[1]))
      const en = [me[0] + 60 * Math.cos(a + 1), me[1] + 60 * Math.sin(a + 1)]
      en.push(world.ground(en[0], en[1]))
      const obs: any = {
        type: "obs", tick: k * 2, t: k * 0.1, alive: 16,
        self: { id: 0, pos: me, vel: [0, 0, 0], aim: [a, 0], hp: k % 3 ? 1400 : 300, max_hp: 1400, energy: 100, max_energy: 100, grounded: true, cubes: 0, upgrades: [], in_zone: true,
          weapons: [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: hello.config.weapons.gun }, k % 2 ? { kind: "laser", cooldown: 0, charge: k % 4 ? 0.8 : 0, stats: hello.config.weapons.laser } : { kind: "lightning", cooldown: 0, stats: hello.config.weapons.lightning }],
          stats: { ...hello.config.mech } },
        mechs: k % 5 === 4 ? [] : [{ id: 1, kind: "mech", pos: en, vel: [5, -3, 0], aim: [a + Math.PI, 0], hp: 900, max_hp: 1400, cubes: 0, weapons: ["gun", "laser"], charging: k % 3 === 0 }],
        projectiles: [{ id: 1, kind: "gun", pos: [en[0], en[1], en[2] + 7], vel: [(me[0] - en[0]) * 4, (me[1] - en[1]) * 4, 0] }, { id: 2, kind: "mortar", pos: [en[0], en[1], en[2] + 20], vel: [10, 0, 5] }],
        crates: [{ id: 1000, pos: [me[0] + 20, me[1], me[2]], hp: 300 }], cubes: [{ id: 5000, pos: [me[0] + 30, me[1] + 5, me[2]] }],
        pickups: [{ id: 8000, kind: "lightning", pos: [me[0] - 40, me[1], me[2]] }],
        sounds: [{ kind: "gun", bearing: a, dist: "near", age: 0 }], beams: [],
        events: k % 4 === 1 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: a + 2, by: k % 8 === 1 ? 1 : 2 }] : [],
        drops: [{ id: 20000, pos: [me[0] + 50, me[1] + 50, me[2]], radius: 8, lands_in: 0, capture_s: 4, progress: 0, holder: null }],
        zone: { center: c, radius: 560, next_center: [c[0] + 40, c[1] - 20], next_radius: k % 2 ? 380 : 140, shrink_start: 60, shrink_end: 110, dps: 20 },
        offer: k % 7 === 0 ? { id: 1, expires: 99, choices: [{ id: "armor", name: "", desc: "" }, { id: "gyros", name: "", desc: "" }] } : null,
      }
      try { tmp.decide(obs) } catch (e) { if (k === 0) console.error("warmup", e) }
      k++
    }
    return k
  }

  errors = 0
  act(obs: Observation): BotAction {
    try {
      return this.decide(obs)
    } catch (e) {
      this.errors++
      if (this.errors <= 5 || this.errors % 200 === 0) console.error(`decide failed at t=${obs.t}:`, e)
      return this.fallback(obs)
    }
  }

  /** Minimal safe behaviour if the main logic throws: go to the zone, shoot the nearest mech. */
  fallback(obs: Observation): BotAction {
    const me = obs.self, p = me.pos
    const g = obs.zone.next_center
    const yaw = Math.atan2(g[1] - p[1], g[0] - p[0])
    const far = d2(p, g) > obs.zone.next_radius * 0.6
    const a: BotAction = { move: far ? [Math.cos(yaw), Math.sin(yaw)] : [0, 0], aim: [yaw, 0], boost: !me.in_zone, fire: [false, false] }
    const e = obs.mechs.filter((m) => m.kind === "mech").sort((x, y) => d2(x.pos, p) - d2(y.pos, p))[0]
    if (e) {
      const dd = d2(e.pos, p)
      const tt = dd / 252
      const q = [e.pos[0] + e.vel[0] * tt, e.pos[1] + e.vel[1] * tt, e.pos[2] + 4.5]
      a.aim = [Math.atan2(q[1] - p[1], q[0] - p[0]), Math.atan2(q[2] - p[2] - 7, dd)]
      a.fire = [me.weapons[0]?.kind === "gun" || me.weapons[0]?.kind === "lightning", me.weapons[1]?.kind === "gun" || me.weapons[1]?.kind === "lightning"]
    }
    if (obs.offer) a.pick = 0
    this.label = "fallback"
    return a
  }

  decide(obs: Observation): BotAction {
    this.tickStart = performance.now()
    this.t = obs.t
    this.observe(obs)
    const me = obs.self
    const t = obs.t
    const p = me.pos
    const st = me.stats
    const sc = this.scale(me.cubes)
    const eye = [p[0], p[1], p[2] + (st.eye_height ?? 8 * sc)]
    const muzzle = [p[0], p[1], p[2] + (st.muzzle_height ?? 7 * sc)]
    const hpFrac = me.hp / me.max_hp
    const act: BotAction = { move: [0, 0], boost: false, jump: false, fire: [false, false] }
    const labels: string[] = []

    // ---- upgrades
    if (obs.offer && obs.offer.choices.length) {
      let bi = 0, bs = Infinity
      obs.offer.choices.forEach((c, i) => {
        const r = UPGRADE_PRIORITY.indexOf(c.id)
        const s = r < 0 ? 100 : r
        if (s < bs) { bs = s; bi = i }
      })
      act.pick = bi
    }

    // ---- zone
    const z = obs.zone
    const curZ = this.zoneAt(obs, t)
    const marginNext = clamp(z.next_radius * 0.22, 3, 45)
    const safeC = z.next_center
    const safeR = Math.max(0, z.next_radius - marginNext)
    const distOutSafe = Math.max(0, d2(p, safeC) - safeR)
    const tOut = this.timeUntilOut(obs, p)
    const walk = st.walk_speed ?? 11.7
    const needT = distOutSafe / walk
    const outsideNow = d2(p, curZ.c) > curZ.r - 1 || !me.in_zone
    const zoneUrgent = outsideNow || (tOut < Infinity && needT * 1.4 + 6 > tOut)
    // point to go to if we need to move inward
    let safePt: number[]
    {
      const dx = p[0] - safeC[0], dy = p[1] - safeC[1], L = Math.hypot(dx, dy)
      const r = Math.max(0, safeR * 0.85)
      safePt = L <= r ? [p[0], p[1]] : [safeC[0] + (dx / L) * r, safeC[1] + (dy / L) * r]
    }
    // is a point safe to go to (inside the region we must be in soon)
    const ptOk = (q: number[], slack = 0) => {
      if (d2(q, curZ.c) > curZ.r - 5) return false
      const travel = d2(p, q) / walk + Math.max(0, d2(q, safeC) - safeR) / walk
      const tq = this.timeUntilOut(obs, q)
      return travel * 1.3 + 5 + slack < Math.min(tOut === Infinity ? 1e9 : tOut + 30, tq) || d2(q, safeC) < safeR
    }

    // ---- threats
    const mechs = [...this.enemies.values()].filter((e) => !e.npc && t - e.seen < 6)
    const npcs = [...this.enemies.values()].filter((e) => e.npc && t - e.seen < 3)
    const visibleNow = new Set(obs.mechs.map((m) => m.id))
    const canSee = (e: Enemy) => {
      const sce = e.npc ? 0.5 : this.scale(e.cubes)
      return this.los(eye, [e.pos[0], e.pos[1], e.pos[2] + 4.5 * sce]) || this.los(eye, [e.pos[0], e.pos[1], e.pos[2] + 8 * sce])
    }
    const losCache = new Map<number, boolean>()
    const hasLos = (e: Enemy) => {
      let v = losCache.get(e.id)
      if (v === undefined) { v = canSee(e); losCache.set(e.id, v) }
      return v
    }
    const [gun, gunSlot] = this.weapon(me, "gun")
    const [laser, laserSlot] = this.weapon(me, "laser")
    const [ltg, ltgSlot] = this.weapon(me, "lightning")
    const [mortar, mortarSlot] = this.weapon(me, "mortar")
    const gunOk = !!gun && (gun.ammo ?? 1) > 0 && !(gun.reload > 0)

    // ---- choose a target
    const recentlyHit = t - this.lastDamageT < 4
    let target: Enemy | null = null
    let bestScore = Infinity
    for (const e of mechs) {
      const dd = d2(e.pos, p)
      if (dd > 260) continue
      const los = visibleNow.has(e.id) && hasLos(e)
      const attacker = this.attackers.has(e.id) && t - this.attackers.get(e.id)!.t < 5
      if (!los && !attacker) continue
      const eFrac = e.hp / e.maxHp
      let engage = attacker || dd < 70 || (hpFrac > 0.5 && (dd < 130 || (laser && dd < 240)))
      if (hpFrac > 0.4 && eFrac < 0.35 && dd < 200) engage = true
      if (OPT.passive && !attacker) {
        engage = dd < 35 || z.next_radius <= 25 || (eFrac < 0.2 && hpFrac > 0.6 && dd < 90)
      } else if (OPT.stealth && !attacker) {
        const toMe = Math.atan2(p[1] - e.pos[1], p[0] - e.pos[0])
        const aware = Math.abs(angDiff(e.aim[0], toMe)) < 0.5
        engage = dd < 45 || (aware && dd < 90) || (eFrac < 0.3 && hpFrac > 0.5 && dd < 120) || z.next_radius <= 25
      } else if (OPT.cautious && !attacker) {
        const toMe = Math.atan2(p[1] - e.pos[1], p[0] - e.pos[0])
        const aware = Math.abs(angDiff(e.aim[0], toMe)) < 0.6 && dd < 210
        const busy = e.hp < e.maxHp * 0.85
        engage = aware && dd < 200 || dd < 50 || (busy && hpFrac > 0.45 && dd < 160) || (eFrac < 0.4 && hpFrac > 0.35 && dd < 200)
      }
      if (OPT.recover && !attacker && hpFrac < 0.8 && dd > 60 && !(eFrac < 0.3 && hpFrac > 0.5)) engage = false
      if (OPT.finish && !engage && eFrac < 0.45 && hpFrac > 0.4 && dd < 220) engage = true
      if (!engage) continue
      const recentDmg = this.taken.reduce((a, x) => a + (x.by === e.id && t - x.t < 3 ? x.a : 0), 0)
      let s = dd + e.hp / 12 - recentDmg / 3 - (attacker ? 60 : 0) - (e.id === this.lastTargetId && t - this.lastTargetT < 3 ? 70 : 0) - (OPT.rank && e.id === this.lastTargetId && t - (this.hitT.get(e.id) ?? -99) < OPT.commitS ? OPT.commitW * (2 - eFrac) : 0) + (los ? 0 : 80) - (OPT.finish ? (1 - eFrac) * 120 : 0) - (OPT.arc ? this.exposure(e, p, !!laser) : 0)
      if (s < bestScore) { bestScore = s; target = e }
    }
    // NPC that is shooting us or that we can farm
    const mechThreatNear = mechs.some((e) => d2(e.pos, p) < 150)
    let npcTarget: Enemy | null = null
    if (!target) {
      let bd = Infinity
      for (const e of npcs) {
        const dd = d2(e.pos, p)
        const attacker = this.attackers.has(e.id) && t - this.attackers.get(e.id)!.t < 4
        const farm = (OPT.farm || !OPT.stealth) && !(OPT.recover && hpFrac < 0.85) && !mechThreatNear && hpFrac > (OPT.farm ? 0.45 : 0.55) && dd < (OPT.farm ? 130 : 90) && (gunOk || ltg || laser || (gun && hpFrac > 0.7)) && !zoneUrgent
        if ((attacker || farm) && visibleNow.has(e.id) && hasLos(e) && dd < bd) { bd = dd; npcTarget = e }
      }
    }
    // Opening farm: keep a drone by id through turns and brief occlusion. A
    // sound is only a search waypoint; it never creates a shootable enemy.
    let rushGoal: number[] | null = null
    let rushEnemy: Enemy | null = null
    let rushReward = false
    if (!OPT.farm || !OPT.rush || t > 30 || me.cubes >= 2 || hpFrac < 0.6) {
      this.spawnRushDone = true
      this.spawnRushTarget = null
      this.spawnRushId = null
    }
    const rushSafe = (q: number[], killTime: number) => {
      const travel = d2(p, q) / walk * 1.4 + killTime
      const escape = Math.max(0, d2(q, safeC) - safeR) / walk * 1.4
      return !outsideNow && travel + escape + 6 < Math.min(tOut, this.timeUntilOut(obs, q))
    }
    if (!this.spawnRushDone) {
      let e = this.spawnRushId === null ? null : this.enemies.get(this.spawnRushId) ?? null
      // A real sighting replaces a bearing-only search immediately.
      if (this.spawnRushId === null) {
        e = npcs.filter((n) => visibleNow.has(n.id) && d2(n.pos, p) < 190 && rushSafe(n.pos, 4))
          .sort((a, b) => d2(a.pos, p) - d2(b.pos, p))[0] ?? null
        if (e) this.spawnRushId = e.id
      }
      if (e && visibleNow.has(e.id)) {
        this.spawnRushTarget = e.pos.slice()
        this.spawnRushSeen = t
      }
      // Prefer the cubes from the opening kill over a different weapon or drone.
      const reward = [...this.cubes.values()].filter((c) => this.spawnRushTarget && d2(c.item.pos, this.spawnRushTarget) < 25)
        .sort((a, b) => d2(a.item.pos, p) - d2(b.item.pos, p))[0]
      if (reward && (!e || !visibleNow.has(e.id))) {
        rushGoal = reward.item.pos
        rushReward = true
      } else if (this.spawnRushTarget && t - this.spawnRushSeen < 8) {
        rushGoal = this.spawnRushTarget
        rushEnemy = e
      } else {
        this.spawnRushTarget = null
        this.spawnRushId = null
        e = [...this.enemies.values()].filter((n) => n.npc && t - n.seen < 3 && d2(n.pos, p) < 190 && rushSafe(n.pos, 4))
          .sort((a, b) => d2(a.pos, p) - d2(b.pos, p))[0] ?? null
        if (e) {
          this.spawnRushId = e.id
          this.spawnRushTarget = e.pos.slice()
          this.spawnRushSeen = e.seen
          rushGoal = e.pos
          rushEnemy = e
        } else {
          const sound = obs.sounds.find((s) => s.kind === "npc_gun" && s.age < 1 && s.dist !== "far")
          if (sound) {
            const range = sound.dist === "near" ? this.cfg.sound.near * 0.7 : (this.cfg.sound.near + this.cfg.sound.mid) * 0.5
            const q = [p[0] + Math.cos(sound.bearing) * range, p[1] + Math.sin(sound.bearing) * range, p[2]]
            if (rushSafe(q, 4)) {
              this.spawnRushTarget = q
              this.spawnRushSeen = t - sound.age
              rushGoal = q
            }
          }
        }
      }
      const playerDanger = !!target || mechs.some((e) => d2(e.pos, p) < 80) || [...this.attackers.values()].some((a) => a.weapon !== "npc" && t - a.t < 3)
      if (rushGoal && (playerDanger || !rushSafe(rushGoal, rushEnemy ? 4 : 0))) {
        rushGoal = null
        rushEnemy = null
      }
      // Reaching an empty last-known position means the kill/loot is gone.
      if (rushGoal && !reward && (!rushEnemy || !visibleNow.has(rushEnemy.id)) && d2(rushGoal, p) < 7 && t - this.spawnRushSeen > 1) {
        this.spawnRushTarget = null
        this.spawnRushId = null
        rushGoal = null
        rushEnemy = null
      }
      if (rushEnemy && visibleNow.has(rushEnemy.id) && hasLos(rushEnemy) && !target) npcTarget = rushEnemy
    }
    const fightTarget = target ?? npcTarget
    if (target) { this.lastTargetId = target.id; this.lastTargetT = t }
    // Chase a wounded opponent that broke line of sight before it can regenerate.
    let finishGoal: number[] | null = null
    if (OPT.finish && !fightTarget && !zoneUrgent && hpFrac > 0.45) {
      let bestF = Infinity
      for (const e of mechs) {
        if (visibleNow.has(e.id) || t - e.seen > 5 || t - (this.hitT.get(e.id) ?? -99) > 8) continue
        const estHp = e.hp + Math.max(0, t - e.seen - 4) * 45
        if (estHp / e.maxHp > 0.5 || estHp > me.hp) continue
        const age = Math.min(t - e.seen, 1.5)
        const q = [e.pos[0] + e.vel[0] * age, e.pos[1] + e.vel[1] * age, e.pos[2]]
        if (d2(q, p) > 160 || !ptOk(q)) continue
        if (mechs.some((o) => o.id !== e.id && d2(o.pos, q) < 90)) continue
        if (estHp < bestF) { bestF = estHp; finishGoal = q }
      }
    }

    // ---- movement decision
    let moveDir: number[] = [0, 0]
    let boost = false
    let lookYaw: number | null = null
    const threatsPos = mechs.filter((e) => d2(e.pos, p) < 220).map((e) => e.pos)
    const avoid = mechs.filter((e) => t - e.seen < 8).map((e) => ({ x: e.pos[0], y: e.pos[1], r: 70, w: 4 }))
    let wantTake: number | null = null
    let wantDrop: number | undefined

    // pickups in range: take them whenever useful
    const pickupWant = (pk: PickupObs): { val: number; drop?: number } | null => {
      if ((this.badPickups.get(pk.id) ?? -1) > t) return null
      if (me.weapons.some((w) => w && w.kind === pk.kind)) return null
      const v = WEAPON_VALUE[pk.kind] ?? 0
      const empty = me.weapons.findIndex((w) => !w)
      if (empty >= 0) return v > 0 ? { val: v } : null
      // both slots full: swap the worst one if this is better
      let worst = -1, wv = Infinity
      me.weapons.forEach((w, i) => {
        if (!w) return
        let val = WEAPON_VALUE[w.kind] ?? 0
        if (w.kind === "gun") val = !OPT.keepGun && (laser && pk.kind === "lightning" || ltg && pk.kind === "laser") ? 0.5 : 2.5
        if (w.kind === "laser" && (w.charge ?? 0) > 0) val = 99
        if (val < wv) { wv = val; worst = i }
      })
      if (worst >= 0 && v > wv + 0.4) return { val: v - wv, drop: worst }
      return null
    }
    let takeValue = -Infinity
    for (const pk of obs.pickups) {
      const dh = d2(pk.pos, p), dz = Math.abs(pk.pos[2] - p[2])
      if (dh <= (this.cfg.loot.pickup_radius ?? 4) - 0.2 && dz < 3.8) {
        const wnt = pickupWant(pk)
        if (!wnt) continue
        const value = wnt.val * 10 - dh
        if (value > takeValue) {
          takeValue = value
          wantTake = pk.id
          wantDrop = wnt.drop
        }
        if (!OPT.equipFirst) break
      }
    }

    const inCombat = !!fightTarget || recentlyHit
    const unseenHit = !fightTarget && this.taken.some((x) => t - x.t < 2.5) && this.threatBearings.some((b) => b.kind === "damage" && t - b.t < 2.5)
    let equipGoal: PickupObs | null = null
    if (OPT.equipFirst && !rushReward && !target && !recentlyHit && !laser && !ltg && !zoneUrgent && t < 60) {
      let bestDist = rushEnemy && d2(rushEnemy.pos, p) < 40 ? 20 : rushEnemy ? 55 : 115
      for (const { item: pk } of this.pickups.values()) {
        if (pk.kind !== "laser" && pk.kind !== "lightning") continue
        const distance = d2(p, pk.pos)
        if (distance >= bestDist || distance < (this.cfg.loot.pickup_radius ?? 4) - 0.2 || !pickupWant(pk)) continue
        if (Math.abs(pk.pos[2] - (this.world?.ground(pk.pos[0], pk.pos[1]) ?? pk.pos[2])) > 2 || !ptOk(pk.pos)) continue
        if (mechs.some((e) => d2(e.pos, pk.pos) < 50)) continue
        bestDist = distance
        equipGoal = pk
      }
    }
    const taken6 = this.taken.reduce((a, x) => a + x.a, 0)
    const dealt6 = this.dealt.reduce((a, x) => a + x.a, 0)
    const nearEnemies = mechs.filter((e) => d2(e.pos, p) < 120).length
    let retreatNow = false
    if (target && z.next_radius > 30) {
      const eFrac = target.hp / target.maxHp
      if (hpFrac < 0.33 && (eFrac > hpFrac + 0.05 || nearEnemies > 1)) retreatNow = true
      if (hpFrac < this.retreatHp && taken6 > dealt6 * 1.5 + 250 && eFrac > 0.3) retreatNow = true
      if (nearEnemies > 2 && hpFrac < 0.7) retreatNow = true
      if (OPT.duel && eFrac > 0.3) {
        const attackers = new Set(this.taken.filter((x) => t - x.t < 2.5 && x.by !== undefined && x.by >= 0 && x.by < 16).map((x) => x.by))
        if (hpFrac < 0.75 && attackers.size >= 2) retreatNow = true
        if (hpFrac < 0.65 && taken6 - dealt6 > 260 && target.hp > me.hp + 150) retreatNow = true
      }
    }
    const punish = OPT.arc && !!target && t - (this.laserFiredT.get(target.id) ?? -99) < 1.3 && hpFrac > 0.3 && nearEnemies < 3
    if (punish && target!.hp < me.hp * 1.6) retreatNow = false
    if (retreatNow) this.retreatUntil = t + 2.5
    const retreat = t < this.retreatUntil && z.next_radius > 30 && !(target && target.hp / target.maxHp < 0.15 && hasLos(target))

    // Go find house bots while healthy: kills before the late swarm are the points.
    let seekGoal: number[] | null = null
    if (OPT.seek && !fightTarget && !zoneUrgent && hpFrac > 0.75 && (gunOk || laser || ltg) && !rushGoal && !equipGoal && t > 8) {
      if (this.seekGoal && t - this.seekT < 4 && d2(this.seekGoal, p) > 10 && ptOk(this.seekGoal)) seekGoal = this.seekGoal
      else {
        let bestS = 250
        for (const e of this.enemies.values()) {
          if (e.npc || t - e.seen > 20) continue
          const dd = d2(e.pos, p)
          if (dd < bestS && dd > 10 && ptOk(e.pos)) { bestS = dd; seekGoal = [e.pos[0], e.pos[1], e.pos[2]] }
        }
        if (!seekGoal) {
          const snd = this.threatBearings.filter((b) => t - b.t < 4 && (b.kind === "gun" || b.kind === "laser" || b.kind === "lightning" || b.kind === "mortar")).sort((a, b) => b.t - a.t)[0]
          if (snd) {
            const near = this.cfg.sound?.near ?? 60, mid = this.cfg.sound?.mid ?? 150
            const r = snd.dist === "near" ? near * 0.7 : snd.dist === "mid" ? (near + mid) * 0.5 : mid * 1.1
            const q = [p[0] + Math.cos(snd.bearing) * r, p[1] + Math.sin(snd.bearing) * r, p[2]]
            if (ptOk(q)) seekGoal = q
          }
        }
        this.seekGoal = seekGoal
        this.seekT = t
      }
    }
    // Regeneration needs a quiet interval: no damage dealt or taken.
    const recovering = OPT.recover && !fightTarget && !zoneUrgent && hpFrac < 0.85 && !rushGoal && !equipGoal
    if (zoneUrgent && !(fightTarget && !outsideNow && tOut > needT * 1.2 + 3)) {
      this.mode = "zone"
      moveDir = this.navTo(obs, safePt, inCombat ? [] : avoid)
      const threatClose = mechs.some((e) => d2(e.pos, p) < 160)
      boost = (outsideNow && (z.dps >= 35 || needT > 3)) || needT * 1.15 + 2 > tOut || (me.energy > 90 && needT > 6 && !threatClose)
    } else if (equipGoal && !retreat) {
      this.mode = "equip"
      moveDir = this.navTo(obs, equipGoal.pos, avoid)
      boost = me.energy > 60 && d2(equipGoal.pos, p) > 15
    } else if (rushGoal && !retreat) {
      this.mode = "rush"
      const dd = d2(rushGoal, p)
      // Close the distance to secure the reward. Keep enough room for the
      // muzzle to pitch down at a short drone while it is still alive.
      if (rushEnemy && visibleNow.has(rushEnemy.id) && dd < 13) {
        const yaw = Math.atan2(rushGoal[1] - p[1], rushGoal[0] - p[0])
        moveDir = this.freeDir(p, [-Math.sin(yaw), Math.cos(yaw)])
      } else moveDir = dd < 0.8 ? [0, 0] : this.navTo(obs, rushGoal, avoid)
      boost = dd > 30 && me.energy > (ltg ? 50 : 35)
    } else if (retreat && (target || recentlyHit)) {
      this.mode = "retreat"
      if (!this.retreatSpot || t - this.retreatSpotT > 1.5) {
        this.retreatSpot = this.findRetreat(p, threatsPos, safeC, Math.max(safeR + marginNext * 0.8, 20))
        this.retreatSpotT = t
      }
      const spot = this.retreatSpot
      if (spot) moveDir = this.navTo(obs, spot)
      else if (target) {
        const dx = p[0] - target.pos[0], dy = p[1] - target.pos[1], L = Math.hypot(dx, dy) || 1
        moveDir = this.freeDir(p, [dx / L, dy / L])
      }
      boost = me.energy > 15
    } else if (unseenHit && !zoneUrgent) {
      // shot by someone we can't see: turn to them (aim below) and get out of their line
      this.mode = "evade"
      const b = this.threatBearings.filter((x) => x.kind === "damage").sort((a, c) => c.t - a.t)[0]
      if (!this.retreatSpot || t - this.retreatSpotT > 1.5) {
        const fake = [p[0] + Math.cos(b.bearing) * 90, p[1] + Math.sin(b.bearing) * 90, p[2]]
        this.retreatSpot = this.findRetreat(p, [fake], safeC, Math.max(safeR + marginNext * 0.8, 20))
        this.retreatSpotT = t
      }
      if (this.retreatSpot) moveDir = this.navTo(obs, this.retreatSpot)
      else moveDir = this.freeDir(p, [-Math.sin(b.bearing) * (this.strafeSign || 1), Math.cos(b.bearing) * (this.strafeSign || 1)])
      boost = me.energy > 40
    } else if (seekGoal && !retreat && !unseenHit) {
      this.mode = "seek"
      moveDir = this.navTo(obs, seekGoal)
      boost = me.energy > 60 && d2(seekGoal, p) > 60
    } else if (recovering && !unseenHit && !retreat) {
      this.mode = "recover"
      if (!this.recoverSpot || t - this.recoverSpotT > 3 || !ptOk(this.recoverSpot)) {
        this.recoverSpot = threatsPos.length ? this.findRetreat(p, threatsPos, safeC, Math.max(safeR + marginNext * 0.8, 20)) : this.findHoldSpot([p[0], p[1]], 25, safeC, Math.max(2, safeR), threatsPos)
        this.recoverSpotT = t
      }
      const spot = this.recoverSpot
      moveDir = spot && d2(spot, p) > 3 ? this.navTo(obs, spot, avoid) : [0, 0]
      boost = false
    } else if (finishGoal && !retreat) {
      this.mode = "finish"
      moveDir = this.navTo(obs, finishGoal, avoid)
      boost = me.energy > 30
    } else if (fightTarget) {
      this.mode = target ? "fight" : "npc"
      const e = fightTarget
      const dx = e.pos[0] - p[0], dy = e.pos[1] - p[1], dd = Math.hypot(dx, dy) || 1
      const ux = dx / dd, uy = dy / dd
      if (t > this.strafeFlipT) {
        if (OPT.strafe === 1) {
          // left/right/stop with short dwell: defeats linear lead
          const r = this.rng()
          this.strafeSign = r < 0.42 ? -1 : r < 0.84 ? 1 : 0
          this.strafeFlipT = t + 0.3 + this.rng() * 0.5
        } else {
          this.strafeSign = this.rng() < 0.5 ? -1 : 1
          this.strafeFlipT = t + 0.45 + this.rng() * 0.9
        }
      }
      // preferred distance
      let pref = 90
      const eHasLtg = e.weapons.includes("lightning")
      if (ltg && !eHasLtg) pref = 25
      else if (ltg && eHasLtg) pref = laser ? 70 : 28
      else if (eHasLtg) pref = 75
      else if (OPT.aimRange && !laser) pref = 55
      if (e.npc) pref = ltg ? 30 : 50
      let radial = 0
      if (dd > pref + 15) radial = hpFrac > 0.45 ? 0.7 : 0
      else if (dd < pref - 15) radial = -0.6
      const lrng = ltg?.stats.range ?? 45
      let lateral = this.strafeSign
      let closing = false
      if (OPT.duel && !e.npc && hasLos(e)) {
        const ownRangeAdvantage = ltg && !eHasLtg && hpFrac > 0.55 && nearEnemies < 2 && me.energy > 35
        const finishing = e.hp < e.maxHp * 0.25 && e.hp + 300 < me.hp && nearEnemies < 2 && gunOk
        const theirRange = this.cfg.weapons.lightning.range ?? 45
        if ((ownRangeAdvantage && dd > lrng * 0.8 && dd < lrng + 50) || (finishing && dd > 34 && dd < 105)) {
          closing = true
          radial = 1
          lateral *= 0.4
          boost = me.energy > (ltg ? 55 : 40)
        } else if (eHasLtg && (!ltg || laser) && dd < theirRange + 13) {
          radial = -1
          lateral *= 0.65
          boost = me.energy > 35
        } else if (!ltg && !eHasLtg && gunOk && !laser && dd > 65 && dd < 125 && hpFrac > 0.6 && nearEnemies < 2) {
          // Shot spread and lead error scale with range. Close an isolated gun duel.
          radial = 0.65
        }
      }
      if (OPT.arc && !e.npc && t - (this.laserFiredT.get(e.id) ?? -99) < 1.3 && hpFrac > 0.3 && !closing && dd > 20) {
        // its laser is on cooldown: close in and fight instead of kiting
        radial = Math.max(radial, 0.6)
        lateral *= 0.6
      }
      let mx = -uy * lateral + ux * radial, my = ux * lateral + uy * radial
      if (OPT.arc && !e.npc) {
        // keep other shooters inside the torso's front arc: step out from between them
        const toE = Math.atan2(dy, dx)
        for (const o of mechs) {
          if (o.id === e.id || t - o.seen > 2) continue
          const od = d2(o.pos, p)
          if (od > 170 || od < 1) continue
          const sep = Math.abs(angDiff(Math.atan2(o.pos[1] - p[1], o.pos[0] - p[0]), toE))
          if (sep < 1.2) continue
          const w = 0.9 * clamp((sep - 1.2) / 0.8, 0.3, 1)
          mx += ((p[0] - o.pos[0]) / od) * w - ux * w * 0.4
          my += ((p[1] - o.pos[1]) / od) * w - uy * w * 0.4
        }
      }
      // dodge a laser that is charging at us
      if (e.charging && Math.abs(angDiff(e.aim[0], Math.atan2(-dy, -dx))) < 0.25) {
        const sg = this.strafeSign || 1
        mx = -uy * sg; my = ux * sg
        boost = me.energy > 10
      }
      // keep every visible lightning carrier outside its reach, not just the target
      if (OPT.antiLtg) {
        const reach = (this.cfg.weapons.lightning?.range ?? 45) + 12
        for (const o of mechs) {
          if (t - o.seen > 1.5 || !o.weapons.includes("lightning") || (ltg && o.id === e.id)) continue
          const od = d2(o.pos, p)
          if (od >= reach || od < 0.5) continue
          const w = (reach - od) / reach * 1.6
          mx += ((p[0] - o.pos[0]) / od) * w; my += ((p[1] - o.pos[1]) / od) * w
        }
      }
      // stay in the zone
      if (d2(p, safeC) > safeR && z.next_radius > 0) {
        const zx = safeC[0] - p[0], zy = safeC[1] - p[1], zl = Math.hypot(zx, zy) || 1
        const k = clamp((d2(p, safeC) - safeR) / 30, 0, 1)
        mx += (zx / zl) * k; my += (zy / zl) * k
      }
      const canFireSoon = gunOk || (!!laser && laser.cooldown < 0.7) || (!!ltg && dd < lrng && me.energy > 8) || (!!mortar && mortar.cooldown < 0.7 && dd > 22)
      if (!OPT.noCover && !canFireSoon && !closing && !e.npc && hasLos(e) && dd > 30) {
        this.mode = "cover"
        if (!this.retreatSpot || t - this.retreatSpotT > 1.5) {
          this.retreatSpot = this.findRetreat(p, threatsPos.length ? threatsPos : [e.pos], safeC, Math.max(safeR + marginNext * 0.8, 20))
          this.retreatSpotT = t
        }
        if (this.retreatSpot && d2(this.retreatSpot, p) < 40) moveDir = this.navTo(obs, this.retreatSpot)
        else { const l = Math.hypot(mx, my) || 1; moveDir = this.freeDir(p, [mx / l, my / l]) }
      } else if (!hasLos(e) && dd > 25 && !e.npc && hpFrac > 0.5) moveDir = this.navTo(obs, e.pos)
      else {
        const l = Math.hypot(mx, my) || 1
        moveDir = this.freeDir(p, [mx / l, my / l])
      }
    } else {
      // ---- loot / objective / hold
      let goal: number[] | null = null
      let goalKind = ""
      const safeTime = tOut === Infinity ? 1e9 : tOut - needT * 1.4
      // supply drop
      for (const dr of obs.drops) {
        const dd = d2(dr.pos, p)
        const contested = mechs.some((e) => d2(e.pos, dr.pos) < 45 && t - e.seen < 4)
        if (dd < 170 && dr.lands_in < dd / walk + 8 && !contested && ptOk(dr.pos) && (dr.holder == null || dr.holder === me.id)) {
          goal = [dr.pos[0], dr.pos[1]]
          goalKind = "drop"
          if (dd < dr.radius - 2) goal = [p[0], p[1]]
          break
        }
      }
      // A kill can drop several cubes. Collect them before leaving for a pickup.
      const kill = this.lastKill
      const scoopOk = !kill ? false : OPT.scoop ? hpFrac > 0.3 && !mechs.some((e) => d2(e.pos, p) < 40) && t - kill!.t < 20 : ![...this.attackers.values()].some((a) => t - a.t < 2.5) && !mechs.some((e) => d2(e.pos, p) < 75) && t - kill!.t < 8
      if (kill && !goal && scoopOk) {
        let closest = OPT.scoop ? 180 : 100
        for (const { item: cube } of this.cubes.values()) {
          const distance = d2(p, cube.pos)
          if (distance < closest && d2(cube.pos, kill.pos) < 15 && Math.abs(cube.pos[2] - kill.pos[2]) < 4 && ptOk(cube.pos)) {
            closest = distance
            goal = cube.pos
            goalKind = "kill-cubes"
          }
        }
        if (!goal && d2(p, kill.pos) > 6 && d2(p, kill.pos) < (OPT.scoop ? 180 : 75) && ptOk(kill.pos)) {
          goal = kill.pos
          goalKind = "kill-cubes"
        }
      }
      // weapons
      if (!goal) {
        let bv = -Infinity
        for (const [, m] of this.pickups) {
          const pk = m.item
          const wnt = pickupWant(pk)
          if (!wnt) continue
          const dd = d2(pk.pos, p)
          if (dd > OPT.lootR) continue
          if (Math.abs(pk.pos[2] - (this.world?.ground(pk.pos[0], pk.pos[1]) ?? pk.pos[2])) > 2) continue // on a roof
          if (!ptOk(pk.pos)) continue
          const v = wnt.val * 60 - dd
          if (v > bv) { bv = v; goal = [pk.pos[0], pk.pos[1]]; goalKind = "loot" }
        }
      }
      // cubes
      if (!goal) {
        let bd = 120
        if (OPT.farm) bd = 170
        for (const [, m] of this.cubes) {
          const c = m.item
          const dd = d2(c.pos, p)
          if (Math.abs(c.pos[2] - (this.world?.ground(c.pos[0], c.pos[1]) ?? c.pos[2])) > 2) continue
          if (dd < bd && ptOk(c.pos)) { bd = dd; goal = [c.pos[0], c.pos[1]]; goalKind = "cube" }
        }
      }
      if (OPT.farm && !goal && !mechThreatNear && hpFrac > 0.5 && !zoneUrgent) {
        // hunt remembered drones, then crates
        let bd = 220
        for (const e of this.enemies.values()) {
          if (!e.npc || t - e.seen > 40) continue
          const dd = d2(e.pos, p)
          if (dd < bd && ptOk(e.pos)) { bd = dd; goal = [e.pos[0], e.pos[1]]; goalKind = "hunt" }
        }
        if (!goal) {
          let bc = 170
          for (const [, m] of this.crates) {
            const c = m.item
            if (Math.abs(c.pos[2] - (this.world?.ground(c.pos[0], c.pos[1]) ?? c.pos[2])) > 2) continue
            const dd = d2(c.pos, p)
            if (dd < bc && ptOk(c.pos)) { bc = dd; goal = [c.pos[0], c.pos[1]]; goalKind = "crate" }
          }
          // stop at shooting distance with line of sight
          if (goal && goalKind === "crate" && d2(goal, p) < 40) {
            const cp = [goal[0], goal[1], (this.world?.ground(goal[0], goal[1]) ?? p[2]) + 1.2]
            if (this.los(muzzle, cp)) goal = [p[0], p[1]]
          }
        }
      }
      if (goal && safeTime < 5) goal = null
      if (goal) {
        this.mode = goalKind
        this.holdSpot = null
        moveDir = d2(goal, p) < 0.6 ? [0, 0] : this.navTo(obs, goal, avoid)
        if (goalKind === "kill-cubes" && me.energy > 65 && d2(goal, p) > 20) boost = true
        if (goalKind === "drop" && d2(goal, p) < 3) moveDir = [0, 0]
      } else {
        this.mode = "hold"
        const key = `${z.next_center[0].toFixed(0)},${z.next_center[1].toFixed(0)},${z.next_radius.toFixed(0)}`
        const slack = tOut === Infinity ? 1e9 : tOut - needT * 1.6
        const hiding = OPT.hide && slack > 25 && z.next_radius >= 140
        const hkey = key + (hiding ? "h" : "")
        if (!this.holdSpot || this.holdKey !== hkey || (!hiding && d2(this.holdSpot, safeC) > safeR)) {
          if (hiding) this.holdSpot = this.findHoldSpot([p[0], p[1]], 50, curZ.c, Math.max(2, curZ.r - 15), threatsPos)
          else if (OPT.edge && safeR > 40) {
            const dx = p[0] - safeC[0], dy = p[1] - safeC[1], L = Math.hypot(dx, dy) || 1
            const ec = [safeC[0] + (dx / L) * safeR * 0.78, safeC[1] + (dy / L) * safeR * 0.78]
            this.holdSpot = this.findHoldSpot(ec, Math.min(40, safeR * 0.2), safeC, Math.max(2, safeR * 0.95), threatsPos)
          } else {
            const rad = Math.min(45, Math.max(2, safeR * 0.5))
            this.holdSpot = this.findHoldSpot(safePt, rad, safeC, Math.max(2, safeR), threatsPos)
          }
          this.holdKey = hkey
        }
        if (OPT.stealth && this.left() > 5 && t - this.holdRefineT > 1) {
          // keep looking for a better-concealed spot nearby while it's quiet
          this.holdRefineT = t
          const rad = Math.min(70, Math.max(2, safeR * 0.6))
          const cand = this.findHoldSpot(safePt, rad, safeC, Math.max(2, safeR), threatsPos)
          const cs = this.concealment(cand[0], cand[1]), hs = this.concealment(this.holdSpot[0], this.holdSpot[1])
          if (cs > hs + 0.12 && d2(cand, p) < 90) this.holdSpot = cand
        }
        if (OPT.mover && d2(this.holdSpot, p) < 14) {
          if (t > this.patrolT || !this.patrol || d2(this.patrol, p) < 2.5) {
            for (let k = 0; k < 8; k++) {
              const a = this.rng() * TAU, r = 5 + this.rng() * 9
              const q = [this.holdSpot[0] + Math.cos(a) * r, this.holdSpot[1] + Math.sin(a) * r]
              if (this.world && this.world.isFree(q[0], q[1], 3)) { this.patrol = q; break }
            }
            this.patrolT = t + 1.5 + this.rng() * 2
          }
          if (this.patrol) moveDir = this.navTo(obs, this.patrol, avoid)
          if (me.grounded && this.rng() < 0.04) act.jump = true
        } else if (d2(this.holdSpot, p) > 2.5) moveDir = this.navTo(obs, this.holdSpot, avoid)
        // walk slowly (silently) when close
        const dh = d2(this.holdSpot, p)
        if (dh < 20 && !zoneUrgent && !OPT.mover) {
          const k = Math.min(1, 0.4 + dh / 40)
          moveDir = [moveDir[0] * k, moveDir[1] * k]
        }
      }
    }

    if (OPT.stealth && !zoneUrgent && !fightTarget && !recentlyHit && (this.mode === "hold" || this.mode === "loot" || this.mode === "cube")) {
      const heard = this.threatBearings.some((b) => t - b.t < 8 && b.kind !== "damage")
      const known = mechs.some((e) => d2(e.pos, p) < 170)
      if (heard || known) {
        const l = Math.hypot(moveDir[0], moveDir[1])
        const cap = 4.4 / walk
        if (l > cap) moveDir = [(moveDir[0] / l) * cap, (moveDir[1] / l) * cap]
        boost = false
      }
    }

    // ---- grab nearby kill cubes even mid-fight
    if (OPT.scoop && this.lastKill && t - this.lastKill.t < 12 && this.mode === "fight" && hpFrac > 0.3) {
      let cube: number[] | null = null, cd = 16
      for (const { item } of this.cubes.values()) {
        const dc = d2(item.pos, p)
        if (dc < cd && d2(item.pos, this.lastKill.pos) < 15 && Math.abs(item.pos[2] - p[2]) < 4) { cd = dc; cube = item.pos }
      }
      if (cube) {
        const dx = cube[0] - p[0], dy = cube[1] - p[1], L = Math.hypot(dx, dy) || 1
        const ml = Math.hypot(moveDir[0], moveDir[1]) || 1
        moveDir = this.freeDir(p, [dx / L * 0.75 + moveDir[0] / ml * 0.35, dy / L * 0.75 + moveDir[1] / ml * 0.35])
        this.mode = "fight+scoop"
      }
    }

    // ---- short-horizon movement planner for fights
    let planned = false
    if (OPT.plan && target && this.mode === "fight" && !zoneUrgent && this.left() > 2.5) {
      const dd = d2(target.pos, p)
      const lr = this.cfg.weapons.lightning?.range ?? 45
      const eLtg = target.weapons.includes("lightning")
      const pref = ltg && !eLtg ? 25 : eLtg ? lr + 15 : laser ? 85 : 60
      const ready = gunOk || (!!laser && laser.cooldown < 0.7) || (!!ltg && dd < lr && me.energy > 8)
      const r = this.planMove(obs, moveDir, target, mechs, pref, !ready, !!ltg, safeC, safeR)
      if (r) { moveDir = r.dir; boost = r.boost; planned = true }
    }

    // ---- dodge projectiles
    let dodge: { time: number; direction: number[] } | null = null
    let mortarDodge = false
    for (const pr of obs.projectiles) {
      if (pr.kind === "mortar") {
        // predict landing
        const g = this.cfg.weapons.mortar.gravity ?? 22
        let lp: number[] | null = null
        for (let k = 1; k <= 40; k++) {
          const T = k * 0.1
          const x = pr.pos[0] + pr.vel[0] * T, y = pr.pos[1] + pr.vel[1] * T, zz = pr.pos[2] + pr.vel[2] * T - 0.5 * g * T * T
          if (this.world && zz < this.world.ground(x, y)) { lp = [x, y]; break }
        }
        if (lp && d2(lp, p) < (this.cfg.weapons.mortar.splash_radius ?? 7) + 5) {
          const dx = p[0] - lp[0], dy = p[1] - lp[1], L = Math.hypot(dx, dy) || 1
          moveDir = this.freeDir(p, [dx / L, dy / L])
          boost = me.energy > 5
          mortarDodge = true
        }
      } else {
        const rx = pr.pos[0] - p[0], ry = pr.pos[1] - p[1]
        const vx = pr.vel[0] - (OPT.predictDodge ? me.vel[0] : 0)
        const vy = pr.vel[1] - (OPT.predictDodge ? me.vel[1] : 0)
        const vv = vx * vx + vy * vy
        if (vv < 1) continue
        const tca = -(rx * vx + ry * vy) / vv
        if (tca < 0 || tca > 0.8) continue
        const cx = rx + vx * tca, cy = ry + vy * tca
        const miss = Math.hypot(cx, cy)
        if (miss < 3 * sc && tca > 0.12) {
          if (OPT.predictDodge) {
            const height = pr.pos[2] - p[2] + (pr.vel[2] - me.vel[2]) * tca
            if (height < -0.5 || height > 9 * sc + 0.5 || tca > 0.5 || (dodge && tca > dodge.time)) continue
          }
          const vl = Math.sqrt(vv)
          let nx = -vy / vl, ny = vx / vl
          if (nx * cx + ny * cy > 0) { nx = -nx; ny = -ny }
          if (OPT.predictDodge) dodge = { time: tca, direction: [nx, ny] }
          else {
            const dir = this.freeDir(p, [nx, ny])
            moveDir = [moveDir[0] * 0.3 + dir[0], moveDir[1] * 0.3 + dir[1]]
          }
        }
      }
    }
    if (dodge && !mortarDodge) {
      const keepCourse = outsideNow ? 0.8 : 0.35
      const [x, y] = this.freeDir(p, dodge.direction)
      moveDir = [moveDir[0] * keepCourse + x, moveDir[1] * keepCourse + y]
    }

    // ---- stuck handling
    const ml = Math.hypot(moveDir[0], moveDir[1])
    if (t - this.stuckRef.t > 1.0) {
      const moved = d2(this.stuckRef.p, p)
      if (ml > 0.5 && moved < 1.2 && t > 1 && me.grounded) {
        this.stuckUntil = t + 0.7
        this.unstickDir = this.rng() < 0.5 ? 1 : -1
        this.path = null
      }
      this.stuckRef = { t, p: [p[0], p[1]] }
    }
    if (t < this.stuckUntil && ml > 0.1) {
      act.jump = me.grounded
      boost = me.energy > 10
      const a = Math.atan2(moveDir[1], moveDir[0]) + this.unstickDir * 0.6
      moveDir = [Math.cos(a), Math.sin(a)]
    }
    {
      const l = Math.hypot(moveDir[0], moveDir[1])
      if (l > 1) moveDir = [moveDir[0] / l, moveDir[1] / l]
    }
    act.move = [moveDir[0], moveDir[1]]
    {
      // keep an energy reserve for lightning and emergencies unless the zone is eating us
      const reserve = ltg ? 45 : 30
      const emergency = outsideNow || this.mode === "retreat" || (fightTarget?.charging ?? false) || t < this.stuckUntil
      if (boost && me.energy < reserve && !emergency) boost = false
    }
    act.boost = boost && Math.hypot(moveDir[0], moveDir[1]) > 0.3

    // ---- aim and fire
    const fire = [false, false]
    let aim: [number, number] | null = null
    if (this.mode === "rush" && rushGoal && !fightTarget) {
      aim = [Math.atan2(rushGoal[1] - p[1], rushGoal[0] - p[0]), 0]
    }
    if (laser && (laser.charge ?? 0) > 0 && !fightTarget) {
      // charging with nothing to shoot: keep holding a little, then let it go
      if (this.laserHoldStart < 0) this.laserHoldStart = t
      if (t - this.laserHoldStart < 1.2) fire[laserSlot] = true
    }
    if (fightTarget) {
      const e = fightTarget
      const sce = e.npc ? 0.72 : this.scale(e.cubes)
      const hw = (e.npc ? 1.8 : 2.5 * sce) * 1.05
      const hh = (e.npc ? 1.75 : 4.5 * sce) * 0.95
      const dd = Math.hypot(e.pos[0] - p[0], e.pos[1] - p[1])
      const center = [e.pos[0], e.pos[1], e.pos[2] + (e.npc ? 1.75 : 4.5 * sce)]
      const los = hasLos(e)
      const lr = ltg?.stats.range ?? 45
      const lcone = ((ltg?.stats.cone_deg ?? 30) * Math.PI) / 180 / 2
      const laserReady = !!laser && ((laser.charge ?? 0) > 0 || laser.cooldown < 0.4)
      const gunSpeed = gun?.stats.speed ?? 252
      let primary = "none"
      if (ltg && dd < lr * 0.95 && los) primary = "lightning"
      else if (laserReady && los && dd < (laser!.stats.range ?? 280)) primary = "laser"
      else if (gunOk && los && dd < (gun!.stats.range ?? 230)) primary = "gun"
      else if (mortar && mortar.cooldown < 0.5 && dd > 22 && dd < 220) primary = "mortar"
      else if (laser && los) primary = "laser"
      else if (gun && los) primary = "gun"

      const laserNearRelease = !!laser && (laser.charge ?? 0) >= (laser.stats.charge ?? 0.75) - OPT.laserEarly
      if (OPT.rank && gunOk && los && (primary === "lightning" || (primary === "laser" && !laserNearRelease))) {
        // the lightning cone and an early laser charge tolerate the gun's lead, so both slots shoot
        aim = this.aimAt(muzzle, this.leadPoint(muzzle, e, gunSpeed, 0.05))
      } else if (primary === "lightning" || primary === "laser" || primary === "none") {
        const lead = this.leadPoint(muzzle, e, 1e9, 0.08)
        aim = this.aimAt(muzzle, lead)
      } else if (primary === "gun") {
        aim = this.aimAt(muzzle, this.leadPoint(muzzle, e, gunSpeed, 0.05))
      } else if (primary === "mortar") {
        const mv = mortar!.stats.speed ?? 72, mg = mortar!.stats.gravity ?? 22
        const mz = [p[0], p[1], p[2] + 9 * sc + 0.5]
        let tgt = [e.pos[0], e.pos[1], e.pos[2] + 1]
        let sol: [number, number] | null = null
        let useHigh = !los
        for (let i = 0; i < 3; i++) {
          sol = this.mortarPitch(mz, tgt, mv, mg)
          if (!sol) break
          const th = useHigh ? sol[1] : sol[0]
          const T = Math.hypot(tgt[0] - mz[0], tgt[1] - mz[1]) / (mv * Math.cos(th))
          tgt = [e.pos[0] + e.vel[0] * T, e.pos[1] + e.vel[1] * T, e.pos[2] + 1]
        }
        if (sol) {
          const pitch = clamp(useHigh ? sol[1] : sol[0], this.cfg.mech.min_pitch ?? -0.7, this.cfg.mech.max_pitch ?? 1.3)
          aim = [Math.atan2(tgt[1] - mz[1], tgt[0] - mz[0]), pitch]
          const D = Math.hypot(tgt[0] - mz[0], tgt[1] - mz[1])
          if (mortar!.cooldown <= 0 && Math.abs(angDiff(me.aim[0], aim[0])) * D < 2.5 && Math.abs(me.aim[1] - pitch) < 0.03) fire[mortarSlot] = true
        } else {
          aim = this.aimAt(muzzle, center)
        }
      }
      // fire whatever is lined up
      const gunMax = OPT.aimRange && !e.npc && e.hp > e.maxHp * 0.2 ? 150 : (gun?.stats.range ?? 230)
      if (gun && gunOk && los && dd < Math.min(gunMax, gun.stats.range ?? 230)) {
        const lp = this.leadPoint(muzzle, e, gunSpeed, 0.05)
        if (gun.cooldown <= 0.1 && this.onTarget(me, muzzle, lp, hw, hh)) {
          const hit = this.world ? this.world.segHit(muzzle, lp) : -1
          if (hit < 0) fire[gunSlot] = true
        }
      }
      if (ltg && los && dd < lr * 0.97 && me.energy >= (ltg.stats.energy ?? 3)) {
        if (Math.abs(angDiff(me.aim[0], Math.atan2(e.pos[1] - p[1], e.pos[0] - p[0]))) < lcone * 0.85) fire[ltgSlot] = true
      }
      if (laser) {
        const charge = laser.charge ?? 0
        const full = laser.stats.charge ?? 0.75
        if (charge > 0) {
          if (this.laserHoldStart < 0) this.laserHoldStart = t
          const lead = this.leadPoint(muzzle, e, 1e9, 0.0)
          const ready = charge >= full - 0.06
          const on = los && this.onTarget(me, muzzle, lead, hw * 0.9, hh)
          // release (fire) when fully charged and on target
          const minFrac = laser.stats.min_frac ?? 0.35, base = laser.stats.damage ?? 315
          const dmgNow = base * (minFrac + (1 - minFrac) * Math.min(1, charge / full)) * (1 + 0.04 * Math.min(me.cubes, 10)) * (e.weapons.includes("mortar") ? 1.6 : 1)
          const lethal = OPT.rank && !e.npc && on && charge >= (laser.stats.min_charge ?? 0.15) && dmgNow >= e.hp
          if ((ready && on) || lethal) fire[laserSlot] = false
          else if (t - this.laserHoldStart > full + (OPT.rank && los ? 1.9 : 1.6)) fire[laserSlot] = false
          else fire[laserSlot] = true
        } else {
          this.laserHoldStart = -1
          if (laser.cooldown <= 0.05 && los && dd < (laser.stats.range ?? 280) && primary === "laser") fire[laserSlot] = true
        }
      }
    } else {
      if (!(laser && (laser.charge ?? 0) > 0)) this.laserHoldStart = -1
      // shoot crates for loot when it is calm
      const calm = !(OPT.rank && hpFrac < OPT.calmHp) && this.mode !== "recover" && this.mode !== "rush" && this.mode !== "equip" && (OPT.farm || !OPT.stealth) && !mechThreatNear && t - this.lastDamageT > 6 && !zoneUrgent
      if (calm && ((gun && gunOk) || (ltg && me.energy > 40))) {
        let best: { id: number; pos: number[]; hp: number } | null = null, bd = OPT.farm ? 90 : 70
        for (const [, m] of this.crates) {
          if (m.seen < t) continue
          const dd = d2(m.item.pos, p)
          if (dd < bd && dd > 4) {
            const cp = [m.item.pos[0], m.item.pos[1], m.item.pos[2] + 1.2]
            if (this.world && this.world.segHit(muzzle, cp) >= 0) continue
            bd = dd; best = m.item
          }
        }
        if (best) {
          const cp = [best.pos[0], best.pos[1], best.pos[2] + 1.2]
          aim = this.aimAt(muzzle, cp)
          if (gun && gunOk && gun.cooldown <= 0.1 && this.onTarget(me, muzzle, cp, 1.0, 1.0)) fire[gunSlot] = true
          if (ltg && bd < (ltg.stats.range ?? 45) * 0.9 && Math.abs(angDiff(me.aim[0], aim[0])) < 0.2) fire[ltgSlot] = true
          this.mode += "+crate"
        }
      }
    }

    // where to look when not shooting
    if (!aim) {
      const recent = this.threatBearings.filter((b) => t - b.t < 3).sort((a, b) => b.t - a.t)
      // remembered enemy that is not visible: watch it
      const watch = mechs.filter((e) => d2(e.pos, p) < 200).sort((a, b) => d2(a.pos, p) - d2(b.pos, p))[0]
      const dmg = this.threatBearings.filter((b) => b.kind === "damage" && t - b.t < 2.5).sort((a, b) => b.t - a.t)[0]
      if (dmg) lookYaw = dmg.bearing
      else if (watch) lookYaw = Math.atan2(watch.pos[1] - p[1], watch.pos[0] - p[0])
      else if (recent.length) lookYaw = recent[0].bearing
      else if (OPT.farm && OPT.rush && !this.spawnRushDone && t < 3) lookYaw = me.aim[0] + 1.1
      else {
        const mvYaw = Math.hypot(moveDir[0], moveDir[1]) > 0.3 ? Math.atan2(moveDir[1], moveDir[0]) : null
        if (t > this.scanT) {
          this.scanT = t + 1.4 + this.rng()
          this.scanIdx++
        }
        if (OPT.sweep) {
          lookYaw = me.aim[0] + 1.3
        } else if (mvYaw !== null && this.mode !== "hold") {
          const offs = [0, 0.9, 0, -0.9]
          lookYaw = mvYaw + offs[this.scanIdx % 4]
        } else {
          // scan the open directions, biased to the zone center
          const toC = Math.atan2(safeC[1] - p[1], safeC[0] - p[0])
          const offs = [0, 1.6, 3.14, -1.6, 0.8, -0.8]
          lookYaw = (d2(p, safeC) > 15 ? toC : me.aim[0]) + offs[this.scanIdx % offs.length]
        }
      }
      aim = [lookYaw, 0]
      // reload when nothing to shoot
      if (gun && !(gun.reload > 0) && (gun.ammo ?? 12) < (gun.stats.mag ?? 12) * 0.7 && t - this.lastDamageT > 1.5) act.reload = true
    }
    if (gun && (gun.ammo ?? 1) === 0 && !(gun.reload > 0)) act.reload = true
    if (gun && !(gun.reload > 0) && !fire[gunSlot] && fightTarget) {
      const mag = gun.stats.mag ?? 12, ammo = gun.ammo ?? mag
      const tLos = hasLos(fightTarget)
      const far = d2(fightTarget.pos, p) > (gun.stats.range ?? 230)
      if ((ammo < mag * 0.5 && (!tLos || far)) || (ammo < mag * 0.25 && t - this.lastDamageT > 1.5)) act.reload = true
    }
    act.aim = [wrap(aim[0]), clamp(aim[1], this.cfg.mech.min_pitch ?? -0.7, this.cfg.mech.max_pitch ?? 1.3)]
    act.fire = [fire[0], fire[1]]
    if (wantTake !== null) {
      act.take = wantTake
      if (wantDrop !== undefined) act.drop = wantDrop
    }
    labels.push(`${this.mode} hp${Math.round(me.hp)} e${Math.round(me.energy)}${fightTarget ? " t" + fightTarget.id : ""}`)
    this.label = labels.join(" ")
    return act
  }
  label = ""
}
