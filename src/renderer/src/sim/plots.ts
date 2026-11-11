// 区画分け。乗用機で刈れて出発点から届く範囲を、地形の特徴でいくつかの区画に分ける。
// 自動運転は、区画を 1 つずつ刈る。描画に依存しない。
//
// 流れ: 格子点ごとに特徴(位置、標高、斜面の向き)を作る → k-means でまとめる
//       → 区画がひとつながりになるよう整える → 狭い区画を隣に吸収する → 刈る順に番号を振る
// 位置だけで分けると地形に関係のない形になるので、標高と斜面の向きも特徴に入れ、
// 尾根や谷、斜面の向きの変わり目が区画の境目になりやすくしている。

export interface PlotOptions {
  /** 区画 1 つの広さの目安(m²)。刈る範囲の面積をこれで割った数だけ区画を作る */
  targetArea: number
  /** 標高の差 1 m を、水平の距離の何 m ぶんとして扱うか */
  heightWeight: number
  /** 斜面の向きの違いの重み(m)。勾配 100% の差を、水平の距離のこの長さぶんとして扱う */
  slopeWeight: number
}

export const DEFAULT_PLOTS: PlotOptions = {
  targetArea: 12000,
  heightWeight: 5,
  slopeWeight: 260
}

export interface Plot {
  /** 番号。刈る順(0 が最初) */
  id: number
  /** 面積(m²) */
  area: number
  /** 重心の格子点の座標 */
  centerX: number
  centerZ: number
}

export interface PlotResult {
  samples: number
  /** 格子点ごとの区画の番号。刈る範囲の外は -1 */
  labels: Int32Array
  plots: Plot[]
}

/** k-means に使う点を取る間隔(格子点)。全部の点を使うと遅いので間引く */
const SAMPLE_STEP = 4
const ITERATIONS = 16
/** これより狭い区画は隣に吸収する(広さの目安に対する割合) */
const MIN_SHARE = 0.3
const FEATURES = 5

/**
 * 区画に分ける。
 * mask は刈る範囲(1)、heights は標高(m)、n は格子の一辺の点の数、cell は格子の間隔(m)。
 * startIx、startIz は出発点の格子点。この点を含む区画が最初(番号 0)になる。
 */
export function clusterPlots(
  mask: Uint8Array,
  heights: Float32Array,
  n: number,
  cell: number,
  options: PlotOptions,
  startIx: number,
  startIz: number
): PlotResult {
  const labels = new Int32Array(n * n).fill(-1)
  let cells = 0
  for (let i = 0; i < mask.length; i++) cells += mask[i]
  if (cells === 0) return { samples: n, labels, plots: [] }

  // 特徴。位置(m)、標高、斜面の下る向き(勾配)に重みを掛けて、同じ物差しに乗せる
  const feature = (ix: number, iz: number, out: Float64Array, at: number): void => {
    const i = iz * n + ix
    const x0 = heights[iz * n + Math.max(ix - 2, 0)]
    const x1 = heights[iz * n + Math.min(ix + 2, n - 1)]
    const z0 = heights[Math.max(iz - 2, 0) * n + ix]
    const z1 = heights[Math.min(iz + 2, n - 1) * n + ix]
    out[at] = ix * cell
    out[at + 1] = iz * cell
    out[at + 2] = heights[i] * options.heightWeight
    out[at + 3] = ((x1 - x0) / (4 * cell)) * options.slopeWeight
    out[at + 4] = ((z1 - z0) / (4 * cell)) * options.slopeWeight
  }

  // 間引いた点で k-means を回す
  const samples: number[] = []
  for (let iz = 0; iz < n; iz += SAMPLE_STEP) {
    for (let ix = 0; ix < n; ix += SAMPLE_STEP) if (mask[iz * n + ix] === 1) samples.push(ix, iz)
  }
  if (samples.length === 0) {
    // 刈る範囲が間引きの間隔より狭い。全部の点を使う
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) samples.push(i % n, Math.floor(i / n))
  }
  const count = samples.length / 2
  const points = new Float64Array(count * FEATURES)
  for (let p = 0; p < count; p++) feature(samples[p * 2], samples[p * 2 + 1], points, p * FEATURES)

  const k = Math.min(Math.max(Math.round((cells * cell * cell) / options.targetArea), 1), count)
  const centers = new Float64Array(k * FEATURES)
  const distanceTo = (data: Float64Array, at: number, c: number): number => {
    let sum = 0
    for (let f = 0; f < FEATURES; f++) {
      const d = data[at + f] - centers[c * FEATURES + f]
      sum += d * d
    }
    return sum
  }

  // 最初の中心は、乱数を使わずに決める(毎回同じ結果にする)。
  // 出発点に最も近い点から始め、すでに選んだ中心から最も遠い点を順に足す
  let first = 0
  let best = Infinity
  for (let p = 0; p < count; p++) {
    const d = (samples[p * 2] - startIx) ** 2 + (samples[p * 2 + 1] - startIz) ** 2
    if (d < best) {
      best = d
      first = p
    }
  }
  const nearest = new Float64Array(count).fill(Infinity)
  let next = first
  for (let c = 0; c < k; c++) {
    for (let f = 0; f < FEATURES; f++) centers[c * FEATURES + f] = points[next * FEATURES + f]
    let far = -1
    for (let p = 0; p < count; p++) {
      const d = distanceTo(points, p * FEATURES, c)
      if (d < nearest[p]) nearest[p] = d
      if (far < 0 || nearest[p] > nearest[far]) far = p
    }
    next = far
  }

  const assign = new Int32Array(count)
  const sums = new Float64Array(k * FEATURES)
  const sizes = new Int32Array(k)
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    let changed = false
    sums.fill(0)
    sizes.fill(0)
    for (let p = 0; p < count; p++) {
      let bestC = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = distanceTo(points, p * FEATURES, c)
        if (d < bestD) {
          bestD = d
          bestC = c
        }
      }
      if (assign[p] !== bestC) changed = true
      assign[p] = bestC
      sizes[bestC]++
      for (let f = 0; f < FEATURES; f++) sums[bestC * FEATURES + f] += points[p * FEATURES + f]
    }
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) continue
      for (let f = 0; f < FEATURES; f++) centers[c * FEATURES + f] = sums[c * FEATURES + f] / sizes[c]
    }
    if (!changed && iteration > 0) break
  }

  // すべての格子点を、最も近い中心に割り当てる
  const one = new Float64Array(FEATURES)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix
      if (mask[i] === 0) continue
      feature(ix, iz, one, 0)
      let bestC = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = distanceTo(one, 0, c)
        if (d < bestD) {
          bestD = d
          bestC = c
        }
      }
      labels[i] = bestC
    }
  }

  const minCells = (options.targetArea * MIN_SHARE) / (cell * cell)
  const pieces = mergePieces(labels, n, minCells)
  return orderPlots(labels, n, cell, pieces, startIx, startIz)
}

/**
 * 区画がひとつながりになるよう整える。labels を書き換え、区画の数を返す。
 * 同じ番号でも離れている所は別の切れ端として数え、区画ごとに最も広い切れ端だけを残す。
 * 残りの切れ端と、minCells より狭い区画は、境目を最も長く接している隣の区画に吸収する。
 */
function mergePieces(labels: Int32Array, n: number, minCells: number): number {
  // つながった切れ端ごとに番号を振り直す
  const piece = new Int32Array(labels.length).fill(-1)
  const pieceLabel: number[] = []
  const pieceSize: number[] = []
  const stack: number[] = []
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] < 0 || piece[start] >= 0) continue
    const id = pieceLabel.length
    const label = labels[start]
    let size = 0
    piece[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const i = stack.pop() as number
      size++
      const ix = i % n
      const visit = (j: number): void => {
        if (labels[j] === label && piece[j] < 0) {
          piece[j] = id
          stack.push(j)
        }
      }
      if (ix > 0) visit(i - 1)
      if (ix < n - 1) visit(i + 1)
      if (i >= n) visit(i - n)
      if (i < labels.length - n) visit(i + n)
    }
    pieceLabel.push(label)
    pieceSize.push(size)
  }

  // 区画ごとに、最も広い切れ端を残す
  const count = pieceLabel.length
  const largest = new Map<number, number>()
  for (let id = 0; id < count; id++) {
    const current = largest.get(pieceLabel[id])
    if (current === undefined || pieceSize[id] > pieceSize[current]) largest.set(pieceLabel[id], id)
  }
  // 切れ端の行き先。自分自身なら、区画として残る
  const target = new Int32Array(count)
  const kept = new Uint8Array(count)
  for (let id = 0; id < count; id++) target[id] = id
  for (const id of largest.values()) kept[id] = 1
  const resolve = (id: number): number => {
    while (target[id] !== id) id = target[id]
    return id
  }

  // 残さない切れ端と、狭すぎる区画を、隣に吸収する。狭い順に片づける
  for (let round = 0; round < count; round++) {
    const size = new Float64Array(count)
    for (let id = 0; id < count; id++) size[resolve(id)] += pieceSize[id]
    let keptCount = 0
    for (let id = 0; id < count; id++) if (target[id] === id && kept[id] === 1) keptCount++
    let pick = -1
    for (let id = 0; id < count; id++) {
      if (target[id] !== id) continue
      const small = kept[id] === 0 || (size[id] < minCells && keptCount > 1)
      if (small && (pick < 0 || size[id] < size[pick])) pick = id
    }
    if (pick < 0) break
    // 接している境目の長さを、相手ごとに数える
    const border = new Map<number, number>()
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] < 0 || resolve(piece[i]) !== pick) continue
      const ix = i % n
      const touch = (j: number): void => {
        if (piece[j] < 0) return
        const other = resolve(piece[j])
        if (other !== pick) border.set(other, (border.get(other) ?? 0) + 1)
      }
      if (ix > 0) touch(i - 1)
      if (ix < n - 1) touch(i + 1)
      if (i >= n) touch(i - n)
      if (i < piece.length - n) touch(i + n)
    }
    let into = -1
    let longest = 0
    for (const [other, length] of border) {
      // 残す区画を優先し、その中で境目が最も長い相手を選ぶ
      const score = length + (kept[other] === 1 ? 1e9 : 0)
      if (score > longest) {
        longest = score
        into = other
      }
    }
    if (into < 0) {
      // どこにも接していない(離れ小島)。そのまま区画として残す
      kept[pick] = 1
      if (size[pick] < minCells) pieceSize[pick] += minCells
      continue
    }
    target[pick] = into
  }

  // 残った区画に、0 から続き番号を振る
  const number = new Int32Array(count).fill(-1)
  let plots = 0
  for (let i = 0; i < piece.length; i++) {
    if (piece[i] < 0) continue
    const root = resolve(piece[i])
    if (number[root] < 0) number[root] = plots++
    labels[i] = number[root]
  }
  return plots
}

/** 区画に、刈る順の番号を振り直す。出発点のある区画から始め、重心が最も近い区画へ順に進む */
function orderPlots(
  labels: Int32Array,
  n: number,
  cell: number,
  count: number,
  startIx: number,
  startIz: number
): PlotResult {
  const size = new Float64Array(count)
  const sumX = new Float64Array(count)
  const sumZ = new Float64Array(count)
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    if (label < 0) continue
    size[label]++
    sumX[label] += i % n
    sumZ[label] += Math.floor(i / n)
  }
  const centerX = Array.from(sumX, (v, i) => v / Math.max(size[i], 1))
  const centerZ = Array.from(sumZ, (v, i) => v / Math.max(size[i], 1))

  const sx = Math.min(Math.max(Math.round(startIx), 0), n - 1)
  const sz = Math.min(Math.max(Math.round(startIz), 0), n - 1)
  let current = labels[sz * n + sx]
  let fromX = sx
  let fromZ = sz
  const order: number[] = []
  const used = new Uint8Array(count)
  for (let step = 0; step < count; step++) {
    if (current < 0 || used[current] === 1) {
      current = -1
      let best = Infinity
      for (let c = 0; c < count; c++) {
        if (used[c] === 1) continue
        const d = (centerX[c] - fromX) ** 2 + (centerZ[c] - fromZ) ** 2
        if (d < best) {
          best = d
          current = c
        }
      }
    }
    used[current] = 1
    order.push(current)
    fromX = centerX[current]
    fromZ = centerZ[current]
  }

  const rank = new Int32Array(count)
  order.forEach((label, i) => {
    rank[label] = i
  })
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = rank[labels[i]]
  const plots: Plot[] = order.map((label, id) => ({
    id,
    area: size[label] * cell * cell,
    centerX: centerX[label],
    centerZ: centerZ[label]
  }))
  return { samples: n, labels, plots }
}
