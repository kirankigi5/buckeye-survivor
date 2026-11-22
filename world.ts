/** Static map model: terrain, prisms, a walkability grid, A* and line-of-sight. */
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Prism = {
  kind: string
  base: number
  top: number
  ring: number[]
  holes: number[][]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const CELL = 2

function inRing(x: number, y: number, r: number[]): boolean {
  let c = false
  const n = r.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

function inPrism2D(p: Prism, x: number, y: number): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
  if (!inRing(x, y, p.ring)) return false
  for (const h of p.holes) if (h.length >= 6 && inRing(x, y, h)) return false
  return true
}

/** Push segment params t in (0,1) where segment a->b crosses polygon ring edges. */
function crossings(ax: number, ay: number, bx: number, by: number, r: number[], out: number[]) {
  const n = r.length >> 1
  const dx = bx - ax, dy = by - ay
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = r[2 * j], y1 = r[2 * j + 1], x2 = r[2 * i], y2 = r[2 * i + 1]
    const ex = x2 - x1, ey = y2 - y1
    const den = dx * ey - dy * ex
    if (Math.abs(den) < 1e-12) continue
    const t = ((x1 - ax) * ey - (y1 - ay) * ex) / den
    const u = ((x1 - ax) * dy - (y1 - ay) * dx) / den
    if (t > 0 && t < 1 && u >= 0 && u <= 1) out.push(t)
  }
}

export class World {
  minX: number
  minY: number
  maxX: number
  maxY: number
  tMinX: number
  tMinY: number
  tnx: number
  tny: number
  terr: Int16Array
  prisms: Prism[] = []
  // grid
  gx: number
  gy: number
  ox: number
  oy: number
  surf: Float32Array
  blocked: Uint8Array
  clear: Float32Array // distance (m) to nearest blocked cell
  // A* scratch
  private gScore: Float32Array
  private parent: Int32Array
  private stamp: Uint32Array
  private closed: Uint32Array
  private gen = 1
  private heapIdx: Int32Array
  private heapF: Float32Array

  // trees: crowns are ellipsoids (soft vision blockers), trunks are vertical cylinders (hard)
  trees: { x: number; y: number; z: number; trunkR: number; trunkTop: number; cx: number; cy: number; cz: number; r: number; rz: number }[] = []
  tgrid: Int32Array[] = []
  tgx = 0
  tgy = 0
  canopyDensity = 0.35
  canopyBlockT = 0.25
  private tstamp: Uint32Array = new Uint32Array(0)
  private tgen = 1
  static TB = 16

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const T = w.terrain
    this.tMinX = T.minX
    this.tMinY = T.minY
    this.tnx = T.nx
    this.tny = T.ny
    const buf = readFileSync(join(dir, "v2", T.file ?? "terrain.i16"))
    this.terr = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + T.nx * T.ny * 2))
    this.minX = w.bounds.minX
    this.minY = w.bounds.minY
    this.maxX = w.bounds.maxX
    this.maxY = w.bounds.maxY
    for (const p of w.prisms) {
      const r: number[] = p.ring
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
      for (let i = 0; i < r.length; i += 2) {
        a = Math.min(a, r[i]); c = Math.max(c, r[i])
        b = Math.min(b, r[i + 1]); d = Math.max(d, r[i + 1])
      }
      const holes: number[][] = (p.holes ?? []).map((h: any) => (Array.isArray(h[0]) ? h.flat() : h))
      this.prisms.push({ kind: p.kind, base: p.base, top: p.top, ring: r, holes, minX: a, minY: b, maxX: c, maxY: d })
    }
    // trees
    if (w.rules) {
      this.canopyDensity = w.rules.canopyDensity ?? 0.35
      this.canopyBlockT = w.rules.canopyBlockT ?? 0.25
    }
    if (w.trees?.fields) {
      const f: string[] = w.trees.fields, d: number[] = w.trees.data, n = f.length
      const ix = (k: string) => f.indexOf(k)
      const [a, b, c, hh, cr, cb, tr, cxI, cyI] = ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "crownX", "crownY"].map(ix)
      for (let e = 0; e + n <= d.length; e += n) {
        const z = d[e + c], h = d[e + hh], base = z + d[e + cb], top = z + h
        this.trees.push({ x: d[e + a], y: d[e + b], z, trunkR: d[e + tr], trunkTop: z + Math.max(d[e + cb] + 0.5 * (h - d[e + cb]), 3),
          cx: cxI >= 0 ? d[e + cxI] : d[e + a], cy: cyI >= 0 ? d[e + cyI] : d[e + b], cz: (base + top) / 2, r: d[e + cr], rz: Math.max((top - base) / 2, 0.5) })
      }
      const TB = World.TB
      this.tgx = Math.ceil((this.maxX - this.minX) / TB) + 1
      this.tgy = Math.ceil((this.maxY - this.minY) / TB) + 1
      const cells: number[][] = Array.from({ length: this.tgx * this.tgy }, () => [])
      this.trees.forEach((t, i) => {
        const rr = Math.max(t.r, t.trunkR)
        const x0 = Math.min(t.cx, t.x) - rr, x1 = Math.max(t.cx, t.x) + rr, y0 = Math.min(t.cy, t.y) - rr, y1 = Math.max(t.cy, t.y) + rr
        for (let gy = Math.max(0, Math.floor((y0 - this.minY) / TB)); gy <= Math.min(this.tgy - 1, Math.floor((y1 - this.minY) / TB)); gy++)
          for (let gx = Math.max(0, Math.floor((x0 - this.minX) / TB)); gx <= Math.min(this.tgx - 1, Math.floor((x1 - this.minX) / TB)); gx++) cells[gy * this.tgx + gx].push(i)
      })
      this.tgrid = cells.map((c) => Int32Array.from(c))
      this.tstamp = new Uint32Array(this.trees.length)
    }
    // grid
    this.ox = this.minX
    this.oy = this.minY
    this.gx = Math.ceil((this.maxX - this.minX) / CELL)
    this.gy = Math.ceil((this.maxY - this.minY) / CELL)
    const N = this.gx * this.gy
    this.surf = new Float32Array(N)
    this.blocked = new Uint8Array(N)
    for (let j = 0; j < this.gy; j++)
      for (let i = 0; i < this.gx; i++) this.surf[j * this.gx + i] = this.ground(this.ox + (i + 0.5) * CELL, this.oy + (j + 0.5) * CELL)
    const margin = 3
    for (let j = 0; j < this.gy; j++)
      for (let i = 0; i < this.gx; i++) {
        const x = this.ox + (i + 0.5) * CELL, y = this.oy + (j + 0.5) * CELL
        if (x < this.minX + margin || x > this.maxX - margin || y < this.minY + margin || y > this.maxY - margin) this.blocked[j * this.gx + i] = 1
      }
    for (const p of this.prisms) {
      const i0 = Math.max(0, Math.floor((p.minX - this.ox) / CELL)), i1 = Math.min(this.gx - 1, Math.floor((p.maxX - this.ox) / CELL))
      const j0 = Math.max(0, Math.floor((p.minY - this.oy) / CELL)), j1 = Math.min(this.gy - 1, Math.floor((p.maxY - this.oy) / CELL))
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = this.ox + (i + 0.5) * CELL, y = this.oy + (j + 0.5) * CELL
          if (!inPrism2D(p, x, y)) continue
          const k = j * this.gx + i
          const g = this.surf[k]
          if (p.kind === "bridge") {
            // a deck near ground level is walkable; a high bridge is walked under
            if (p.top - g < 9 && p.top > g) this.surf[k] = Math.max(this.surf[k], p.top)
            continue
          }
          if (p.top > g + 1.2 && p.base < g + 9) this.blocked[k] = 1
        }
    }
    // distance transform (chamfer 2-3) in cell units -> meters
    const INF = 1e9
    const d = new Float32Array(N)
    for (let k = 0; k < N; k++) d[k] = this.blocked[k] ? 0 : INF
    const gx = this.gx, gy = this.gy
    const a1 = 1, a2 = Math.SQRT2
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        const k = j * gx + i
        let v = d[k]
        if (i > 0) v = Math.min(v, d[k - 1] + a1)
        if (j > 0) {
          v = Math.min(v, d[k - gx] + a1)
          if (i > 0) v = Math.min(v, d[k - gx - 1] + a2)
          if (i < gx - 1) v = Math.min(v, d[k - gx + 1] + a2)
        }
        d[k] = v
      }
    for (let j = gy - 1; j >= 0; j--)
      for (let i = gx - 1; i >= 0; i--) {
        const k = j * gx + i
        let v = d[k]
        if (i < gx - 1) v = Math.min(v, d[k + 1] + a1)
        if (j < gy - 1) {
          v = Math.min(v, d[k + gx] + a1)
          if (i < gx - 1) v = Math.min(v, d[k + gx + 1] + a2)
          if (i > 0) v = Math.min(v, d[k + gx - 1] + a2)
        }
        d[k] = v
      }
    this.clear = new Float32Array(N)
    for (let k = 0; k < N; k++) this.clear[k] = d[k] * CELL
    this.gScore = new Float32Array(N)
    this.parent = new Int32Array(N)
    this.stamp = new Uint32Array(N)
    this.closed = new Uint32Array(N)
    this.heapIdx = new Int32Array(N * 2)
    this.heapF = new Float32Array(N * 2)
  }

  ground(x: number, y: number): number {
    let fx = x - this.tMinX, fy = y - this.tMinY
    fx = Math.max(0, Math.min(this.tnx - 1.001, fx))
    fy = Math.max(0, Math.min(this.tny - 1.001, fy))
    const i = Math.floor(fx), j = Math.floor(fy)
    const u = fx - i, v = fy - j
    const n = this.tnx, t = this.terr
    const h00 = t[j * n + i], h10 = t[j * n + i + 1], h01 = t[(j + 1) * n + i], h11 = t[(j + 1) * n + i + 1]
    return ((h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v) * 0.01
  }

  cellOf(x: number, y: number): number {
    const i = Math.floor((x - this.ox) / CELL), j = Math.floor((y - this.oy) / CELL)
    if (i < 0 || j < 0 || i >= this.gx || j >= this.gy) return -1
    return j * this.gx + i
  }
  cx(k: number) {
    return this.ox + ((k % this.gx) + 0.5) * CELL
  }
  cy(k: number) {
    return this.oy + (Math.floor(k / this.gx) + 0.5) * CELL
  }
  isFree(x: number, y: number, minClear = 0): boolean {
    const k = this.cellOf(x, y)
    return k >= 0 && !this.blocked[k] && this.clear[k] >= minClear
  }
  clearAt(x: number, y: number): number {
    const k = this.cellOf(x, y)
    return k < 0 ? 0 : this.clear[k]
  }

  /** Nearest free cell (clearance >= minClear) to (x,y), searched in growing rings. */
  nearestFree(x: number, y: number, minClear = 3, maxR = 40): number {
    const k0 = this.cellOf(Math.max(this.minX + 4, Math.min(this.maxX - 4, x)), Math.max(this.minY + 4, Math.min(this.maxY - 4, y)))
    if (k0 < 0) return -1
    if (!this.blocked[k0] && this.clear[k0] >= minClear) return k0
    const i0 = k0 % this.gx, j0 = Math.floor(k0 / this.gx)
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = Infinity
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = i0 + di, j = j0 + dj
          if (i < 0 || j < 0 || i >= this.gx || j >= this.gy) continue
          const k = j * this.gx + i
          if (!this.blocked[k] && this.clear[k] >= minClear) {
            const dd = di * di + dj * dj
            if (dd < bd) { bd = dd; best = k }
          }
        }
      if (best >= 0) return best
    }
    return -1
  }

  private cost(k: number): number {
    const c = this.clear[k]
    if (c < 2.5) return 8
    if (c < 3.6) return 2.5
    if (c < 6) return 1.25
    return 1
  }

  /**
   * A* from (sx,sy) to (tx,ty). Returns waypoints [x,y][] (smoothed), or null.
   * `avoid` adds cost near given points (threats). Time-bounded: returns path to the
   * closest node found if the budget runs out.
   */
  path(sx: number, sy: number, tx: number, ty: number, budgetMs = 8, avoid: { x: number; y: number; r: number; w: number }[] = []): [number, number][] | null {
    let s = this.cellOf(sx, sy)
    if (s < 0) return null
    if (this.blocked[s]) {
      s = this.nearestFree(sx, sy, 0, 6)
      if (s < 0) return null
    }
    let goal = this.nearestFree(tx, ty, 3, 30)
    if (goal < 0) goal = this.nearestFree(tx, ty, 0, 30)
    if (goal < 0) return null
    const gen = ++this.gen
    const gx = this.gx
    const gi = goal % gx, gj = Math.floor(goal / gx)
    const h = (k: number) => {
      const di = Math.abs((k % gx) - gi), dj = Math.abs(Math.floor(k / gx) - gj)
      return (Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)) * CELL
    }
    // binary heap
    let hn = 0
    const HI = this.heapIdx, HF = this.heapF
    const push = (k: number, f: number) => {
      let i = hn++
      while (i > 0) {
        const p = (i - 1) >> 1
        if (HF[p] <= f) break
        HI[i] = HI[p]; HF[i] = HF[p]; i = p
      }
      HI[i] = k; HF[i] = f
    }
    const pop = (): number => {
      const top = HI[0]
      const lk = HI[--hn], lf = HF[hn]
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= hn) break
        if (c + 1 < hn && HF[c + 1] < HF[c]) c++
        if (HF[c] >= lf) break
        HI[i] = HI[c]; HF[i] = HF[c]; i = c
      }
      HI[i] = lk; HF[i] = lf
      return top
    }
    this.stamp[s] = gen
    this.gScore[s] = 0
    this.parent[s] = -1
    push(s, h(s))
    const t0 = performance.now()
    let best = s, bestH = h(s)
    let found = false
    let iter = 0
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (hn > 0) {
      const k = pop()
      if (this.closed[k] === gen) continue
      this.closed[k] = gen
      if (k === goal) { found = true; best = k; break }
      const hk = h(k)
      if (hk < bestH) { bestH = hk; best = k }
      if ((++iter & 511) === 0 && performance.now() - t0 > budgetMs) break
      const i = k % gx, j = (k - i) / gx
      const gk = this.gScore[k]
      const zk = this.surf[k]
      for (let d = 0; d < 8; d++) {
        const ni = i + DI[d], nj = j + DJ[d]
        if (ni < 0 || nj < 0 || ni >= gx || nj >= this.gy) continue
        const n = nj * gx + ni
        if (this.blocked[n] || this.closed[n] === gen) continue
        const diag = d >= 4
        if (diag && (this.blocked[j * gx + ni] || this.blocked[nj * gx + i])) continue
        const step = diag ? CELL * Math.SQRT2 : CELL
        const dz = this.surf[n] - zk
        if (dz > 1.2 && dz > step * 1.15) continue // too steep to walk up
        let c = step * this.cost(n)
        if (avoid.length) {
          const x = this.ox + (ni + 0.5) * CELL, y = this.oy + (nj + 0.5) * CELL
          for (const a of avoid) {
            const dd = Math.hypot(x - a.x, y - a.y)
            if (dd < a.r) c += step * a.w * (1 - dd / a.r)
          }
        }
        const ng = gk + c
        if (this.stamp[n] !== gen || ng < this.gScore[n]) {
          this.stamp[n] = gen
          this.gScore[n] = ng
          this.parent[n] = k
          push(n, ng + h(n))
        }
      }
    }
    const cells: number[] = []
    for (let k = best; k >= 0; k = this.parent[k]) {
      cells.push(k)
      if (cells.length > 100000) break
    }
    cells.reverse()
    if (!found && cells.length < 2) return null
    // smooth: greedy string pulling with walkable-line checks
    const pts: [number, number][] = cells.map((k) => [this.cx(k), this.cy(k)])
    const out: [number, number][] = []
    let cur: [number, number] = [sx, sy]
    let idx = 0
    while (idx < pts.length - 1) {
      let far = idx + 1
      for (let m = Math.min(pts.length - 1, idx + 40); m > idx + 1; m--) {
        if (this.walkLine(cur[0], cur[1], pts[m][0], pts[m][1])) { far = m; break }
      }
      out.push(pts[far])
      cur = pts[far]
      idx = far
    }
    if (out.length === 0) out.push(pts[pts.length - 1])
    return out
  }

  /** Straight walk is clear of walls with margin and slopes. */
  walkLine(ax: number, ay: number, bx: number, by: number, minClear = 3): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / 1.0))
    let prevZ = this.ground(ax, ay)
    const startClear = this.clearAt(ax, ay)
    for (let s = 1; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n, y = ay + ((by - ay) * s) / n
      const k = this.cellOf(x, y)
      if (k < 0 || this.blocked[k]) return false
      const c = this.clear[k]
      if (c < minClear && c < startClear + 0.01) return false
      const z = this.surf[k]
      if (z - prevZ > 1.0) return false
      prevZ = z
    }
    return true
  }

  /**
   * First parameter t in [0,1] where segment a->b hits solid geometry, or -1 if clear.
   * Bridges and buildings block; terrain is sampled.
   */
  segHit(a: number[], b: number[], terrain = true): number {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2]
    const sx0 = Math.min(ax, bx), sx1 = Math.max(ax, bx), sy0 = Math.min(ay, by), sy1 = Math.max(ay, by)
    let first = 2
    const ts: number[] = []
    for (const p of this.prisms) {
      if (p.maxX < sx0 || p.minX > sx1 || p.maxY < sy0 || p.minY > sy1) continue
      if (Math.max(az, bz) < p.base || Math.min(az, bz) > p.top) continue
      ts.length = 0
      ts.push(0, 1)
      crossings(ax, ay, bx, by, p.ring, ts)
      for (const h of p.holes) crossings(ax, ay, bx, by, h, ts)
      ts.sort((u, v) => u - v)
      for (let i = 0; i < ts.length - 1; i++) {
        const t0 = ts[i], t1 = ts[i + 1]
        if (t1 - t0 < 1e-9 || t0 >= first) continue
        const tm = (t0 + t1) / 2
        if (!inPrism2D(p, ax + (bx - ax) * tm, ay + (by - ay) * tm)) continue
        const z0 = az + (bz - az) * t0, z1 = az + (bz - az) * t1
        if (Math.max(z0, z1) >= p.base && Math.min(z0, z1) <= p.top) {
          // entry point into the z slab within the interval
          let te = t0
          if (z0 > p.top && z1 < z0) te = t0 + ((z0 - p.top) / (z0 - z1)) * (t1 - t0)
          else if (z0 < p.base && z1 > z0) te = t0 + ((p.base - z0) / (z1 - z0)) * (t1 - t0)
          if (te < first) first = te
          break
        }
      }
    }
    if (terrain) {
      const L = Math.hypot(bx - ax, by - ay)
      const n = Math.max(1, Math.ceil(L / 3))
      for (let s = 1; s < n; s++) {
        const t = s / n
        if (t >= first) break
        const z = az + (bz - az) * t
        if (z < this.ground(ax + (bx - ax) * t, ay + (by - ay) * t) - 0.2) { first = t; break }
      }
    }
    return first <= 1 ? first : -1
  }

  los(a: number[], b: number[]): boolean {
    return this.segHit(a, b) < 0
  }

  /**
   * Canopy transmittance along a->b (1 = clear), or 0 if a trunk blocks it.
   * Mirrors the server: exp(-canopyDensity * metres of crown crossed).
   */
  canopy(a: number[], b: number[]): number {
    if (!this.trees.length) return 1
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const L = Math.hypot(dx, dy, dz)
    const gen = ++this.tgen
    let u = 0
    const TB = World.TB
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (TB * 0.5)))
    let lastCell = -1
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + (dx * s) / steps, y = a[1] + (dy * s) / steps
      const gx = Math.floor((x - this.minX) / TB), gy = Math.floor((y - this.minY) / TB)
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const X = gx + ox, Y = gy + oy
          if (X < 0 || Y < 0 || X >= this.tgx || Y >= this.tgy) continue
          const cell = Y * this.tgx + X
          if (cell === lastCell) continue
          for (const i of this.tgrid[cell]) {
            if (this.tstamp[i] === gen) continue
            this.tstamp[i] = gen
            const t = this.trees[i]
            // crown ellipsoid
            const sx = (a[0] - t.cx) / t.r, sy = (a[1] - t.cy) / t.r, sz = (a[2] - t.cz) / t.rz
            const ux = dx / t.r, uy = dy / t.r, uz = dz / t.rz
            const A = ux * ux + uy * uy + uz * uz
            if (A > 1e-9) {
              const B = 2 * (sx * ux + sy * uy + sz * uz), C = sx * sx + sy * sy + sz * sz - 1
              const g = B * B - 4 * A * C
              if (g > 0) {
                const q = Math.sqrt(g), t0 = (-B - q) / (2 * A), t1 = (-B + q) / (2 * A)
                if (t1 >= 0 && t0 <= 1) u += (Math.min(t1, 1) - Math.max(t0, 0)) * L
              }
            }
            // trunk: 2D distance from segment to trunk axis, within trunk height
            const fx = a[0] - t.x, fy = a[1] - t.y, AA = dx * dx + dy * dy
            if (AA > 1e-9) {
              let tt = -(fx * dx + fy * dy) / AA
              tt = Math.max(0, Math.min(1, tt))
              const px = fx + dx * tt, py = fy + dy * tt
              if (px * px + py * py < t.trunkR * t.trunkR) {
                const zz = a[2] + dz * tt
                if (zz >= t.z && zz <= t.trunkTop) return 0
              }
            }
          }
        }
      lastCell = -1
    }
    return Math.exp(-this.canopyDensity * u)
  }

  /** Vision line of sight: buildings/terrain block, canopy fades, trunks block. */
  sees(a: number[], b: number[]): boolean {
    if (this.segHit(a, b) >= 0) return false
    return this.canopy(a, b) >= this.canopyBlockT
  }
}
