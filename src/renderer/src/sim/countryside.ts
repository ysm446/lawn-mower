// 土地の配置は固定し、農道だけを地形に合わせて探索する。描画に依存しない。
import type { Terrain } from './terrain'
import type { PlotResult } from './plots'
import type { Tree } from './trees'

export interface FarmRoad {
  /** false: x に沿って進む。true: z に沿って進む */
  vertical: boolean
  offsets: Float32Array
}

export interface Countryside {
  trees: Tree[]
  roads: FarmRoad[]
  /** 土地 ID。農道・畦・外周は -1 */
  parcels: Int32Array
  /** 描画用 RGBA。赤は土地の色調、緑は畦、青は農道 */
  surface: Uint8Array
}

const EDGE = 230
const STEP = 4
const COUNT = EDGE * 2 / STEP + 1

/**
 * 両端を結ぶ農道。距離、縦断勾配、横断勾配、予定線からの距離を評価する。
 * 横方向に 2 m 刻みの候補を置く動的計画法。過大な遠回りを避けるため帯状に探索する。
 */
function road(terrain: Terrain, vertical: boolean, offset: number): FarmRoad {
  const width = 41
  const middle = 20
  const parents = new Int16Array(COUNT * width)
  let costs = new Float64Array(width).fill(Infinity)
  costs[middle] = 0
  const height = (s: number, t: number): number => vertical ? terrain.heightAt(t, s) : terrain.heightAt(s, t)
  for (let k = 1; k < COUNT; k++) {
    const next = new Float64Array(width).fill(Infinity)
    const s = -EDGE + k * STEP
    for (let j = 0; j < width; j++) {
      if (k === COUNT - 1 && j !== middle) continue
      const t = offset + (j - middle) * 2
      const cross = (height(s, t + 2) - height(s, t - 2)) / 4
      for (let p = Math.max(0, j - 1); p <= Math.min(width - 1, j + 1); p++) {
        const distance = Math.hypot(STEP, (j - p) * 2)
        const grade = (height(s, t) - height(s - STEP, offset + (p - middle) * 2)) / distance
        const cost = costs[p] + distance * (1 + 95 * grade * grade + 8 * cross * cross + 0.0003 * (t - offset) ** 2)
        if (cost < next[j]) {
          next[j] = cost
          parents[k * width + j] = p
        }
      }
    }
    costs = next
  }
  const raw = new Float32Array(COUNT)
  let j = middle
  for (let k = COUNT - 1; k >= 0; k--) {
    raw[k] = offset + (j - middle) * 2
    j = parents[k * width + j]
  }
  // 探索格子の折れを局所的にならす。両端は入口として固定する。
  const offsets = raw.map((_, k) => {
    if (k === 0 || k === COUNT - 1) return offset
    let sum = 0
    for (let d = -3; d <= 3; d++) sum += raw[Math.max(0, Math.min(COUNT - 1, k + d))]
    return sum / 7
  })
  return { vertical, offsets }
}

export function roadOffset(road: FarmRoad, s: number): number {
  const u = Math.max(0, Math.min(COUNT - 1, (s + EDGE) / STEP))
  const k = Math.min(COUNT - 2, Math.floor(u))
  return road.offsets[k] + (road.offsets[k + 1] - road.offsets[k]) * (u - k)
}

export function createCountryside(terrain: Terrain): Countryside {
  const roads = [road(terrain, false, -20), ...[-115, 15, 135].map((x) => road(terrain, true, x))]
  const n = terrain.samples
  const parcels = new Int32Array(n * n).fill(-1)
  const surface = new Uint8Array(n * n * 4)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = terrain.origin + ix * terrain.options.cell
      const z = terrain.origin + iz * terrain.options.cell
      const i = iz * n + ix
      surface[i * 4 + 3] = 255
      if (Math.abs(x) > EDGE || Math.abs(z) > EDGE) continue
      let distance = Infinity
      for (const r of roads) distance = Math.min(distance, Math.abs((r.vertical ? x : z) - roadOffset(r, r.vertical ? z : x)))
      const column = roads.slice(1).filter((r) => x > roadOffset(r, z)).length
      const id = column + (z > roadOffset(roads[0], x) ? 4 : 0)
      const border = Math.min(EDGE - Math.abs(x), EDGE - Math.abs(z))
      if (distance > 5 && border > 3) parcels[i] = id
      surface[i * 4] = 30 + id * 28
      surface[i * 4 + 1] = distance > 3.2 && distance < 5.2 || border < 3 ? 255 : 0
      surface[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, 3.7 - distance)) * 255)
    }
  }
  // 道沿いの細身の針葉樹。交差点は空け、幹のまわりは作業範囲から外す。
  const trees: Tree[] = []
  for (let x = -195; x <= 195; x += 26) {
    const z = roadOffset(roads[0], x) + 7
    if (roads.slice(1).some((r) => Math.abs(x - roadOffset(r, z)) < 12)) continue
    trees.push({ kind: 'conifer', x, z, height: 9 + 2 * Math.sin(x), spread: 1.3, tone: 0.4, lone: true })
    const cx = Math.round((x - terrain.origin) / terrain.options.cell)
    const cz = Math.round((z - terrain.origin) / terrain.options.cell)
    const radius = Math.ceil(3 / terrain.options.cell)
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.hypot(dx, dz) * terrain.options.cell <= 3) parcels[(cz + dz) * n + cx + dx] = -1
      }
    }
  }
  return { roads, parcels, surface, trees }
}

/** 土地境界を維持し、到達可能な部分を連結成分ごとに作業区画へ変換する。 */
export function countrysidePlots(farm: Countryside, reach: Uint8Array, n: number, cell: number): PlotResult {
  const labels = new Int32Array(reach.length).fill(-1)
  const plots: PlotResult['plots'] = []
  const queue = new Int32Array(reach.length)
  for (let i = 0; i < reach.length; i++) {
    if (!reach[i] || farm.parcels[i] < 0 || labels[i] !== -1) continue
    const id = plots.length
    let head = 0, tail = 1, sx = 0, sz = 0
    queue[0] = i
    labels[i] = id
    while (head < tail) {
      const p = queue[head++]
      const x = p % n, z = Math.floor(p / n)
      sx += x
      sz += z
      const neighbors = [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, z > 0 ? p - n : -1, z < n - 1 ? p + n : -1]
      for (const q of neighbors) {
        if (q < 0 || !reach[q] || labels[q] !== -1 || farm.parcels[q] !== farm.parcels[i]) continue
        labels[q] = id
        queue[tail++] = q
      }
    }
    // 幹と畦の間など、機体の作業場所にならない切れ端は残さない。
    if (tail * cell * cell < 25) {
      for (let k = 0; k < tail; k++) labels[queue[k]] = -2
    } else {
      plots.push({ id, area: tail * cell * cell, centerX: sx / tail, centerZ: sz / tail })
    }
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] === -2) labels[i] = -1
  return { samples: n, labels, plots }
}
