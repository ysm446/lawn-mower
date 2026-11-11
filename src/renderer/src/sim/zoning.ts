// 勾配による区分け。高さの格子から、どこをどの機種で刈るかを決める。描画に依存しない。
// 流れ: 高さをならす → 勾配 → 閾値で分類(境目のがたつきを抑える) → 多数決で整形
//       → つながった領域にまとめる → 小さな領域を周りに吸収 → 出発点から届く範囲 → 輪郭の多角形

export const ZONE_RIDE = 0
export const ZONE_SLOPE = 1
export const ZONE_NONE = 2
export const ZONE_COUNT = 3

export interface ZoningOptions {
  /** 乗用機で刈れる勾配の上限(度) */
  rideMaxDeg: number
  /** 斜面用の機種で刈れる勾配の上限(度) */
  slopeMaxDeg: number
  /** 閾値の前後に取る幅(度)。この幅の中は、隣とつながる側の区分に寄せる */
  hysteresisDeg: number
  /** 勾配を求める前に高さをならす半径(m)。機体の大きさより細かい凹凸を無視する */
  smoothRadius: number
  /** 多数決で整形するときの半径(m) */
  majorityRadius: number
  /** これより狭い領域は周りの区分に吸収する(m²) */
  minArea: number
}

export const DEFAULT_ZONING: ZoningOptions = {
  rideMaxDeg: 15,
  slopeMaxDeg: 30,
  hysteresisDeg: 1.5,
  smoothRadius: 2,
  majorityRadius: 2,
  minArea: 150
}

export interface HeightGrid {
  /** 一辺の標本数 */
  samples: number
  /** 格子の間隔(m) */
  cell: number
  /** 高さ(m)。添字は iz * samples + ix */
  heights: Float32Array
}

export interface ZoneRegion {
  id: number
  zone: number
  /** 面積(m²)。水平に投影した広さ */
  area: number
  /** 出発点から、乗用機で刈れる所だけを通って届くか(乗用機の領域のみ意味を持つ) */
  reachable: boolean
}

export interface ZoningResult {
  samples: number
  cell: number
  /** ならした後の勾配(度) */
  slopeDeg: Float32Array
  /** 格子点ごとの区分(ZONE_*) */
  zones: Uint8Array
  /** 格子点ごとの領域の番号(regions の添字) */
  labels: Int32Array
  regions: ZoneRegion[]
  /** 区分ごとの面積(m²) */
  zoneArea: number[]
  /** 出発点から届く、乗用機で刈れる面積(m²) */
  reachableArea: number
}

/** 箱形のぼかしを縦横に 1 回ずつ掛ける。端は範囲内の平均を取る */
function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  if (radius < 1) return src
  const tmp = new Float32Array(src.length)
  const dst = new Float32Array(src.length)
  const pass = (from: Float32Array, to: Float32Array, stride: number, lineStride: number): void => {
    for (let line = 0; line < n; line++) {
      const base = line * lineStride
      let sum = 0
      let count = 0
      for (let i = 0; i <= Math.min(radius, n - 1); i++) {
        sum += from[base + i * stride]
        count++
      }
      for (let i = 0; i < n; i++) {
        to[base + i * stride] = sum / count
        const add = i + radius + 1
        const remove = i - radius
        if (add < n) {
          sum += from[base + add * stride]
          count++
        }
        if (remove >= 0) {
          sum -= from[base + remove * stride]
          count--
        }
      }
    }
  }
  pass(src, tmp, 1, n)
  pass(tmp, dst, n, 1)
  return dst
}

/** 高さの格子から勾配(度)を求める */
export function computeSlopeDeg(grid: HeightGrid, smoothRadius: number): Float32Array {
  const { samples: n, cell } = grid
  const radius = Math.round(smoothRadius / cell)
  // 2 回掛けると、なだらかな重みのぼかしに近づく
  const h = boxBlur(boxBlur(grid.heights, n, radius), n, radius)
  const slope = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++) {
    const z0 = Math.max(iz - 1, 0)
    const z1 = Math.min(iz + 1, n - 1)
    for (let ix = 0; ix < n; ix++) {
      const x0 = Math.max(ix - 1, 0)
      const x1 = Math.min(ix + 1, n - 1)
      const dx = (h[iz * n + x1] - h[iz * n + x0]) / ((x1 - x0) * cell)
      const dz = (h[z1 * n + ix] - h[z0 * n + ix]) / ((z1 - z0) * cell)
      slope[iz * n + ix] = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI
    }
  }
  return slope
}

/**
 * 「勾配が閾値以下」の範囲を求める。閾値ちょうどの付近では細かな出入りができやすいので、
 * 閾値 - 幅 以下の確実な所から始めて、閾値 + 幅 までの所へ、つながっている限り広げる。
 */
function belowThreshold(slope: Float32Array, n: number, threshold: number, band: number): Uint8Array {
  const mask = new Uint8Array(slope.length)
  const stack: number[] = []
  for (let i = 0; i < slope.length; i++) {
    if (slope[i] <= threshold - band) {
      mask[i] = 1
      stack.push(i)
    }
  }
  const limit = threshold + band
  while (stack.length > 0) {
    const i = stack.pop() as number
    const ix = i % n
    if (ix > 0) grow(i - 1)
    if (ix < n - 1) grow(i + 1)
    if (i >= n) grow(i - n)
    if (i < slope.length - n) grow(i + n)
  }
  function grow(j: number): void {
    if (mask[j] === 0 && slope[j] <= limit) {
      mask[j] = 1
      stack.push(j)
    }
  }
  return mask
}

/** 周りで最も多い区分に置き換える(細い筋や小さな欠けを消す) */
function majorityFilter(zones: Uint8Array, n: number, radius: number): Uint8Array {
  if (radius < 1) return zones
  const counts: Float32Array[] = []
  for (let zone = 0; zone < ZONE_COUNT; zone++) {
    const indicator = new Float32Array(zones.length)
    for (let i = 0; i < zones.length; i++) indicator[i] = zones[i] === zone ? 1 : 0
    counts.push(boxBlur(indicator, n, radius))
  }
  const out = new Uint8Array(zones.length)
  for (let i = 0; i < zones.length; i++) {
    // 同数のときは今の区分を保つ
    let best = zones[i]
    let bestCount = counts[best][i]
    for (let zone = 0; zone < ZONE_COUNT; zone++) {
      if (counts[zone][i] > bestCount + 1e-6) {
        best = zone
        bestCount = counts[zone][i]
      }
    }
    out[i] = best
  }
  return out
}

interface Labeling {
  labels: Int32Array
  /** 領域ごとの区分 */
  zone: number[]
  /** 領域ごとの格子点の数 */
  size: number[]
}

/** 同じ区分で上下左右につながる格子点を、1 つの領域にまとめる */
function labelRegions(zones: Uint8Array, n: number): Labeling {
  const labels = new Int32Array(zones.length).fill(-1)
  const zone: number[] = []
  const size: number[] = []
  const stack: number[] = []
  for (let start = 0; start < zones.length; start++) {
    if (labels[start] !== -1) continue
    const id = zone.length
    const z = zones[start]
    let count = 0
    labels[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const i = stack.pop() as number
      count++
      const ix = i % n
      if (ix > 0) visit(i - 1)
      if (ix < n - 1) visit(i + 1)
      if (i >= n) visit(i - n)
      if (i < zones.length - n) visit(i + n)
    }
    zone.push(z)
    size.push(count)
    function visit(j: number): void {
      if (labels[j] === -1 && zones[j] === z) {
        labels[j] = id
        stack.push(j)
      }
    }
  }
  return { labels, zone, size }
}

/** 狭い領域を、接している長さが最も長い隣の区分に吸収する。吸収が起きたら true */
function absorbSmallRegions(zones: Uint8Array, n: number, minCells: number): boolean {
  const { labels, zone, size } = labelRegions(zones, n)
  const border: number[][] = zone.map(() => new Array<number>(ZONE_COUNT).fill(0))
  const touch = (i: number, j: number): void => {
    if (labels[i] === labels[j]) return
    border[labels[i]][zones[j]]++
    border[labels[j]][zones[i]]++
  }
  for (let i = 0; i < zones.length; i++) {
    if (i % n < n - 1) touch(i, i + 1)
    if (i < zones.length - n) touch(i, i + n)
  }
  const target = zone.map((z, id) => {
    if (size[id] >= minCells) return z
    let best = z
    let bestLength = 0
    for (let other = 0; other < ZONE_COUNT; other++) {
      if (other !== z && border[id][other] > bestLength) {
        best = other
        bestLength = border[id][other]
      }
    }
    return best
  })
  let changed = false
  for (let i = 0; i < zones.length; i++) {
    const t = target[labels[i]]
    if (zones[i] !== t) {
      zones[i] = t
      changed = true
    }
  }
  return changed
}

/**
 * 区分けを行う。startIx、startIz は出発点(芝刈り機の置き場所)の格子点。
 */
export function computeZoning(
  grid: HeightGrid,
  options: ZoningOptions,
  startIx: number,
  startIz: number
): ZoningResult {
  const { samples: n, cell } = grid
  const slopeDeg = computeSlopeDeg(grid, options.smoothRadius)

  const rideMax = Math.min(options.rideMaxDeg, options.slopeMaxDeg)
  const rideable = belowThreshold(slopeDeg, n, rideMax, options.hysteresisDeg)
  const mowable = belowThreshold(slopeDeg, n, options.slopeMaxDeg, options.hysteresisDeg)
  let zones: Uint8Array = new Uint8Array(n * n)
  for (let i = 0; i < zones.length; i++) {
    zones[i] = mowable[i] === 0 ? ZONE_NONE : rideable[i] === 0 ? ZONE_SLOPE : ZONE_RIDE
  }

  zones = majorityFilter(zones, n, Math.round(options.majorityRadius / cell))

  const cellArea = cell * cell
  const minCells = options.minArea / cellArea
  // 吸収によって隣どうしがつながり、新たに狭い領域が残ることがあるので数回くり返す
  for (let i = 0; i < 4; i++) {
    if (!absorbSmallRegions(zones, n, minCells)) break
  }

  const { labels, zone, size } = labelRegions(zones, n)
  const sx = Math.min(Math.max(Math.round(startIx), 0), n - 1)
  const sz = Math.min(Math.max(Math.round(startIz), 0), n - 1)
  const startLabel = labels[sz * n + sx]
  const regions: ZoneRegion[] = zone.map((z, id) => ({
    id,
    zone: z,
    area: size[id] * cellArea,
    reachable: z === ZONE_RIDE && id === startLabel
  }))

  const zoneArea = new Array<number>(ZONE_COUNT).fill(0)
  let reachableArea = 0
  for (const region of regions) {
    zoneArea[region.zone] += region.area
    if (region.reachable) reachableArea += region.area
  }
  return { samples: n, cell, slopeDeg, zones, labels, regions, zoneArea, reachableArea }
}

/** 輪郭の 1 周。座標は格子点の番号の単位(半端な値は格子点の間)で、x と z を交互に並べる */
export type Loop = number[]

/**
 * 1 つの領域の輪郭を取り出す。領域を左に見て進む向きに並べるので、
 * 外周は面積が正、穴は面積が負になる(loopArea を参照)。
 * 各格子点は、その点を中心とする 1 マスの正方形として扱う。
 */
export function traceRegion(labels: Int32Array, n: number, regionId: number): Loop[] {
  // マスの角を (n + 1) 四方の点として番号づけする。角 (cx, cz) の座標は (cx - 0.5, cz - 0.5)
  const w = n + 1
  // 角から出る辺の行き先。1 つの角から最大 2 本出る(斜めに接する所)
  const next = new Map<number, number[]>()
  const addEdge = (from: number, to: number): void => {
    const list = next.get(from)
    if (list) list.push(to)
    else next.set(from, [to])
  }
  const inside = (ix: number, iz: number): boolean =>
    ix >= 0 && iz >= 0 && ix < n && iz < n && labels[iz * n + ix] === regionId

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (labels[iz * n + ix] !== regionId) continue
      const a = iz * w + ix // 角 (ix, iz)
      const b = a + 1
      const c = a + w
      const d = c + 1
      // 領域を左に見る向き(x を右、z を上に取った図で反時計回り)
      if (!inside(ix, iz - 1)) addEdge(a, b)
      if (!inside(ix + 1, iz)) addEdge(b, d)
      if (!inside(ix, iz + 1)) addEdge(d, c)
      if (!inside(ix - 1, iz)) addEdge(c, a)
    }
  }

  const loops: Loop[] = []
  for (const [start, list] of next) {
    while (list.length > 0) {
      const loop: Loop = []
      let from = start
      let to = list.pop() as number
      let prevDx = 0
      let prevDz = 0
      for (;;) {
        const dx = (to % w) - (from % w)
        const dz = Math.floor(to / w) - Math.floor(from / w)
        // 向きが変わった角だけを頂点として残す
        if (dx !== prevDx || dz !== prevDz) loop.push((from % w) - 0.5, Math.floor(from / w) - 0.5)
        prevDx = dx
        prevDz = dz
        if (to === start) break
        const out = next.get(to) as number[]
        let pick = out.length - 1
        if (out.length > 1) {
          // 斜めに接する所では同じマスの縁をたどる側を選び、領域を斜めにはつなげない
          for (let k = 0; k < out.length; k++) {
            const ex = (out[k] % w) - (to % w)
            const ez = Math.floor(out[k] / w) - Math.floor(to / w)
            if (dx * ez - dz * ex > 0) pick = k
          }
        }
        from = to
        to = out.splice(pick, 1)[0]
      }
      // 始点が直線の途中だった場合は取り除く
      if (loop.length >= 6) {
        const m = loop.length
        const ax = loop[2] - loop[0]
        const az = loop[3] - loop[1]
        const bx = loop[0] - loop[m - 2]
        const bz = loop[1] - loop[m - 1]
        if (ax * bz - az * bx === 0) loop.splice(0, 2)
      }
      loops.push(loop)
    }
  }
  return loops
}

/** 輪郭が囲む面積(格子の単位)。外周は正、穴は負 */
export function loopArea(loop: Loop): number {
  let sum = 0
  for (let i = 0; i < loop.length; i += 2) {
    const j = (i + 2) % loop.length
    sum += loop[i] * loop[j + 1] - loop[j] * loop[i + 1]
  }
  return sum / 2
}

/** 輪郭の頂点を間引く(ずれが tolerance 以内に収まる範囲で) */
export function simplifyLoop(loop: Loop, tolerance: number): Loop {
  const count = loop.length / 2
  if (count <= 4 || tolerance <= 0) return loop
  // 最も離れた 2 点で 2 つに分け、それぞれを間引く
  let far = 0
  let farDist = -1
  for (let i = 1; i < count; i++) {
    const d = (loop[i * 2] - loop[0]) ** 2 + (loop[i * 2 + 1] - loop[1]) ** 2
    if (d > farDist) {
      farDist = d
      far = i
    }
  }
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[far] = 1
  const stack: Array<[number, number]> = [
    [0, far],
    [far, count]
  ]
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number]
    const ax = loop[a * 2]
    const az = loop[a * 2 + 1]
    const bx = loop[(b % count) * 2]
    const bz = loop[(b % count) * 2 + 1]
    const len = Math.hypot(bx - ax, bz - az) || 1
    let worst = -1
    let worstDist = tolerance
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((loop[i * 2] - ax) * (bz - az) - (loop[i * 2 + 1] - az) * (bx - ax)) / len
      if (d > worstDist) {
        worstDist = d
        worst = i
      }
    }
    if (worst !== -1) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: Loop = []
  for (let i = 0; i < count; i++) {
    if (keep[i]) out.push(loop[i * 2], loop[i * 2 + 1])
  }
  return out
}
