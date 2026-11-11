// 刈る経路の計画。刈る範囲(格子の mask)を、往復刈りと外周刈りで塗りつぶす経路を作る。
// 流れ: 境界からの距離 → 内側を平行な直線で区切る(往復刈り) → 近い順につなぐ
//       → 直線どうしは旋回の曲線でつなぐ → 最後に境界沿いを数周する(外周刈り)
// 経路は後輪軸の中央が通る位置で表す。刈刃は deckOffset だけ前にあるので、その分ずらす。

import { distanceToOutside } from './distance'
import { dubinsPath } from './dubins'
import type { DrivePath } from './pathFollower'
import { simplifyLoop, traceRegion } from './zoning'

export interface PlanGrid {
  /** 一辺の標本数 */
  samples: number
  /** 格子の間隔(m) */
  cell: number
  /** 格子の端の座標(x、z 共通) */
  origin: number
  /** 刈る範囲なら 1 */
  mask: Uint8Array
}

export interface PlanOptions {
  /** 刈り幅(m) */
  cutWidth: number
  /** 隣の列と重ねる幅(m) */
  overlap: number
  /** 往復刈りの向き(度)。0 で Z 方向 */
  angleDeg: number
  /** 外周刈りの周回数。旋回の場所を確保する役目もある */
  headlandPasses: number
  /** 旋回の半径(m) */
  turnRadius: number
  /** 後輪軸から刈刃までの前方距離(m) */
  deckOffset: number
  /** 刈り始める前に、列にまっすぐ乗るための助走(m) */
  runIn: number
}

export interface CoveragePlan {
  path: DrivePath
  /** 往復刈りの列の数 */
  sweepCount: number
  /** 刈刃を下げて走る距離(m) */
  cutLength: number
  /** 刈刃を上げて移動する距離(m) */
  transitLength: number
}

/** これより短い列は作らない(m) */
const MIN_SWEEP_LENGTH = 4
/** これより近い相手には、旋回の曲線で直接つなぐ(m) */
const DIRECT_LINK_DISTANCE = 20
/** 移動のとき、境界からこれだけ内側を通る(m) */
const TRANSIT_MARGIN = 1.5

interface Sweep {
  ax: number
  az: number
  bx: number
  bz: number
  done: boolean
}

class PathBuilder {
  readonly points: number[] = []
  readonly cut: number[] = []
  cutLength = 0
  transitLength = 0
  x = 0
  z = 0
  heading = 0

  constructor(x: number, z: number, heading: number) {
    this.points.push(x, z)
    this.x = x
    this.z = z
    this.heading = heading
  }

  add(x: number, z: number, cut: boolean): void {
    const dx = x - this.x
    const dz = z - this.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-4) return
    this.points.push(x, z)
    this.cut.push(cut ? 1 : 0)
    if (cut) this.cutLength += length
    else this.transitLength += length
    this.x = x
    this.z = z
    this.heading = Math.atan2(dx, dz)
  }

  addAll(points: number[], cut: boolean): void {
    for (let i = 0; i < points.length; i += 2) this.add(points[i], points[i + 1], cut)
  }
}

/** 格子の上の最短経路(A*)。通れるのは passable が 1 の点だけ。見つからなければ null */
function gridRoute(
  passable: Uint8Array,
  n: number,
  startIx: number,
  startIz: number,
  goalIx: number,
  goalIz: number
): number[] | null {
  const start = startIz * n + startIx
  const goal = goalIz * n + goalIx
  const cost = new Float64Array(n * n).fill(Infinity)
  const from = new Int32Array(n * n).fill(-1)
  // 二分ヒープ(優先度と点の番号を別の配列で持つ)
  const heapKey: number[] = []
  const heapNode: number[] = []
  const push = (key: number, node: number): void => {
    let i = heapKey.length
    heapKey.push(key)
    heapNode.push(node)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heapKey[parent] <= key) break
      heapKey[i] = heapKey[parent]
      heapNode[i] = heapNode[parent]
      i = parent
    }
    heapKey[i] = key
    heapNode[i] = node
  }
  const pop = (): number => {
    const top = heapNode[0]
    const key = heapKey.pop() as number
    const node = heapNode.pop() as number
    const size = heapKey.length
    if (size > 0) {
      let i = 0
      for (;;) {
        let child = i * 2 + 1
        if (child >= size) break
        if (child + 1 < size && heapKey[child + 1] < heapKey[child]) child++
        if (heapKey[child] >= key) break
        heapKey[i] = heapKey[child]
        heapNode[i] = heapNode[child]
        i = child
      }
      heapKey[i] = key
      heapNode[i] = node
    }
    return top
  }
  const estimate = (ix: number, iz: number): number => Math.hypot(ix - goalIx, iz - goalIz)

  cost[start] = 0
  push(estimate(startIx, startIz), start)
  while (heapKey.length > 0) {
    const node = pop()
    if (node === goal) break
    const ix = node % n
    const iz = (node - ix) / n
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const jx = ix + dx
        const jz = iz + dz
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue
        const next = jz * n + jx
        if (passable[next] === 0 && next !== goal) continue
        const c = cost[node] + (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1)
        if (c < cost[next]) {
          cost[next] = c
          from[next] = node
          push(c + estimate(jx, jz), next)
        }
      }
    }
  }
  if (from[goal] === -1 && goal !== start) return null
  const route: number[] = []
  for (let node = goal; node !== -1; node = from[node]) {
    route.push(node % n, Math.floor(node / n))
    if (node === start) break
  }
  // 逆順に並んでいるので、始点からの順に直す
  const ordered: number[] = []
  for (let i = route.length - 2; i >= 0; i -= 2) ordered.push(route[i], route[i + 1])
  return ordered
}

/** 輪郭の角を丸める。各頂点の前後 radius の範囲(辺が短ければ辺の半分まで)を曲線に置き換える */
function roundCorners(loop: number[], radius: number): number[] {
  const out: number[] = []
  const m = loop.length
  for (let i = 0; i < m; i += 2) {
    const vx = loop[i]
    const vz = loop[i + 1]
    const px = loop[(i - 2 + m) % m] - vx
    const pz = loop[(i - 1 + m) % m] - vz
    const nx = loop[(i + 2) % m] - vx
    const nz = loop[(i + 3) % m] - vz
    const pLength = Math.hypot(px, pz)
    const nLength = Math.hypot(nx, nz)
    if (pLength < 1e-6 || nLength < 1e-6) continue
    const pCut = Math.min(radius, pLength / 2) / pLength
    const nCut = Math.min(radius, nLength / 2) / nLength
    const ax = vx + px * pCut
    const az = vz + pz * pCut
    const bx = vx + nx * nCut
    const bz = vz + nz * nCut
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      const u = 1 - t
      out.push(u * u * ax + 2 * u * t * vx + t * t * bx, u * u * az + 2 * u * t * vz + t * t * bz)
    }
  }
  return out
}

export function planCoverage(
  grid: PlanGrid,
  options: PlanOptions,
  startX: number,
  startZ: number,
  startHeading: number
): CoveragePlan {
  const { samples: n, cell, origin, mask } = grid
  const spacing = Math.max(options.cutWidth - options.overlap, 0.5)
  const dist = distanceToOutside(mask, n)
  for (let i = 0; i < dist.length; i++) dist[i] *= cell

  const toIndex = (v: number): number => Math.min(Math.max(Math.round((v - origin) / cell), 0), n - 1)
  const distAt = (x: number, z: number): number => {
    const gx = (x - origin) / cell
    const gz = (z - origin) / cell
    if (gx < 0 || gz < 0 || gx > n - 1 || gz > n - 1) return 0
    return dist[Math.round(gz) * n + Math.round(gx)]
  }

  const builder = new PathBuilder(startX, startZ, startHeading)

  // 移動で通れる所
  const passable = new Uint8Array(n * n)
  for (let i = 0; i < passable.length; i++) passable[i] = dist[i] >= TRANSIT_MARGIN ? 1 : 0
  const clearLine = (ax: number, az: number, bx: number, bz: number): boolean => {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.5))
    for (let s = 0; s <= steps; s++) {
      const t = steps > 0 ? s / steps : 0
      if (distAt(ax + (bx - ax) * t, az + (bz - az) * t) < TRANSIT_MARGIN) return false
    }
    return true
  }

  /** 今の位置から、(x, z) に向き heading で着くようにつなぐ(刈刃は上げる) */
  const linkTo = (x: number, z: number, heading: number): void => {
    const gap = Math.hypot(x - builder.x, z - builder.z)
    if (gap < 0.05) return
    if (gap <= DIRECT_LINK_DISTANCE) {
      const turn = dubinsPath(builder.x, builder.z, builder.heading, x, z, heading, options.turnRadius)
      builder.addAll(turn.points, false)
      return
    }
    // 遠い相手には、刈る範囲の中を通る道を探してつなぐ
    const route = gridRoute(passable, n, toIndex(builder.x), toIndex(builder.z), toIndex(x), toIndex(z))
    if (route) {
      // 見通せる点まで飛ばして、折れ線を短くする
      let ax = builder.x
      let az = builder.z
      let i = 0
      const count = route.length / 2
      while (i < count - 1) {
        let reach = i + 1
        for (let j = count - 1; j > i + 1; j--) {
          if (clearLine(ax, az, origin + route[j * 2] * cell, origin + route[j * 2 + 1] * cell)) {
            reach = j
            break
          }
        }
        if (reach === count - 1) break
        ax = origin + route[reach * 2] * cell
        az = origin + route[reach * 2 + 1] * cell
        builder.add(ax, az, false)
        i = reach
      }
    }
    // 最後は旋回の曲線で、向きを合わせて着く
    const approach = Math.min(8, gap / 2)
    const px = x - Math.sin(heading) * approach
    const pz = z - Math.cos(heading) * approach
    if (distAt(px, pz) >= TRANSIT_MARGIN) {
      const turn = dubinsPath(builder.x, builder.z, builder.heading, px, pz, heading, options.turnRadius)
      builder.addAll(turn.points, false)
    }
    builder.add(x, z, false)
  }

  // ---------------------------------------------- 往復刈り
  const headland = options.headlandPasses * spacing
  // 列の端は、外周刈りの帯に刈り幅の半分だけ食い込ませる。
  // 境界に斜めに当たる列では、帯の片側の角が届かずに三角形の刈り残しができるため
  const sweepLimit = Math.max(headland - options.cutWidth / 2, options.cutWidth / 2)
  const angle = (options.angleDeg * Math.PI) / 180
  const dirX = Math.sin(angle)
  const dirZ = Math.cos(angle)
  const normalX = Math.cos(angle)
  const normalZ = -Math.sin(angle)

  // 刈る範囲が、列に直交する向きと列の向きにどこまで広がっているか
  let cMin = Infinity
  let cMax = -Infinity
  let tMin = Infinity
  let tMax = -Infinity
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (dist[iz * n + ix] < sweepLimit) continue
      const x = origin + ix * cell
      const z = origin + iz * cell
      const c = x * normalX + z * normalZ
      const t = x * dirX + z * dirZ
      if (c < cMin) cMin = c
      if (c > cMax) cMax = c
      if (t < tMin) tMin = t
      if (t > tMax) tMax = t
    }
  }

  const sweeps: Sweep[] = []
  if (cMin <= cMax) {
    const step = cell * 0.5
    const lines = Math.max(1, Math.round((cMax - cMin) / spacing) + 1)
    // 範囲の中央に列が揃うように、端の余りを両側に振り分ける
    const first = (cMin + cMax) / 2 - ((lines - 1) * spacing) / 2
    for (let k = 0; k < lines; k++) {
      const c = first + k * spacing
      let runStart = NaN
      for (let t = tMin - step; t <= tMax + step * 2; t += step) {
        const inside = distAt(c * normalX + t * dirX, c * normalZ + t * dirZ) >= sweepLimit
        if (inside && Number.isNaN(runStart)) runStart = t
        if (!inside && !Number.isNaN(runStart)) {
          const runEnd = t - step
          if (runEnd - runStart >= MIN_SWEEP_LENGTH) {
            sweeps.push({
              ax: c * normalX + runStart * dirX,
              az: c * normalZ + runStart * dirZ,
              bx: c * normalX + runEnd * dirX,
              bz: c * normalZ + runEnd * dirZ,
              done: false
            })
          }
          runStart = NaN
        }
      }
    }
  }

  // 今いる所から近い端を持つ列を、順に選んで刈る
  const lead = options.deckOffset
  for (let remaining = sweeps.length; remaining > 0; remaining--) {
    let best: Sweep | null = null
    let bestReverse = false
    let bestDist = Infinity
    // 刈刃のある位置から測る
    const fromX = builder.x + Math.sin(builder.heading) * lead
    const fromZ = builder.z + Math.cos(builder.heading) * lead
    for (const sweep of sweeps) {
      if (sweep.done) continue
      const da = Math.hypot(sweep.ax - fromX, sweep.az - fromZ)
      const db = Math.hypot(sweep.bx - fromX, sweep.bz - fromZ)
      if (da < bestDist) {
        bestDist = da
        best = sweep
        bestReverse = false
      }
      if (db < bestDist) {
        bestDist = db
        best = sweep
        bestReverse = true
      }
    }
    const sweep = best as Sweep
    sweep.done = true
    const sx = bestReverse ? sweep.bx : sweep.ax
    const sz = bestReverse ? sweep.bz : sweep.az
    const ex = bestReverse ? sweep.ax : sweep.bx
    const ez = bestReverse ? sweep.az : sweep.bz
    const length = Math.hypot(ex - sx, ez - sz)
    const ux = (ex - sx) / length
    const uz = (ez - sz) / length
    const heading = Math.atan2(ux, uz)
    // 後輪軸は刈刃より lead だけ後ろを通る。その手前に助走をつける
    linkTo(sx - ux * (lead + options.runIn), sz - uz * (lead + options.runIn), heading)
    builder.add(sx - ux * lead, sz - uz * lead, false)
    builder.add(ex - ux * lead, ez - uz * lead, true)
  }

  // ---------------------------------------------- 外周刈り(内側の周から外へ)
  const labels = new Int32Array(n * n)
  for (let pass = options.headlandPasses - 1; pass >= 0; pass--) {
    const level = options.cutWidth / 2 + pass * spacing
    for (let i = 0; i < labels.length; i++) labels[i] = dist[i] >= level ? 1 : 0
    const loops = traceRegion(labels, n, 1)
      .map((raw) => simplifyLoop(raw, 0.6).map((v) => origin + v * cell))
      .map((loop) => roundCorners(loop, options.turnRadius))
      .filter((loop) => {
        let perimeter = 0
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length
          perimeter += Math.hypot(loop[j] - loop[i], loop[j + 1] - loop[i + 1])
        }
        return perimeter >= 30
      })

    const pending = new Set(loops)
    while (pending.size > 0) {
      // 今いる所から最も近い頂点を持つ周を選び、その頂点から回る
      let best: number[] | null = null
      let bestVertex = 0
      let bestDist = Infinity
      for (const loop of pending) {
        for (let i = 0; i < loop.length; i += 2) {
          const d = Math.hypot(loop[i] - builder.x, loop[i + 1] - builder.z)
          if (d < bestDist) {
            bestDist = d
            best = loop
            bestVertex = i
          }
        }
      }
      const loop = best as number[]
      pending.delete(loop)
      const m = loop.length
      const at = (k: number): number => (bestVertex + k * 2) % m
      const x0 = loop[at(0)]
      const z0 = loop[at(0) + 1]
      const heading = Math.atan2(loop[at(1)] - x0, loop[at(1) + 1] - z0)
      linkTo(x0, z0, heading)
      for (let k = 1; k <= m / 2; k++) builder.add(loop[at(k)], loop[at(k) + 1], true)
      // 刈刃が前にある分だけ、始点を越えて進んで周を閉じる
      let extra = lead
      for (let k = m / 2 + 1; extra > 0 && k <= m; k++) {
        const px = loop[at(k)]
        const pz = loop[at(k) + 1]
        extra -= Math.hypot(px - builder.x, pz - builder.z)
        builder.add(px, pz, true)
      }
    }
  }

  return {
    path: { points: new Float32Array(builder.points), cut: new Uint8Array(builder.cut) },
    sweepCount: sweeps.length,
    cutLength: builder.cutLength,
    transitLength: builder.transitLength
  }
}
