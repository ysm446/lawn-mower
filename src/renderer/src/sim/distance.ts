// 距離変換。格子の各点について、範囲の外(mask が 0 の点、または格子の外)までの
// 最短距離を求める。経路計画で「境界からどれだけ内側か」を知るために使う。

const INF = 1e20

/** 1 次元の距離変換(距離の 2 乗)。f を書き換える */
function transform1d(
  f: Float64Array,
  n: number,
  hull: Int32Array,
  bounds: Float64Array,
  out: Float64Array
): void {
  let k = 0
  hull[0] = 0
  bounds[0] = -INF
  bounds[1] = INF
  for (let q = 1; q < n; q++) {
    let s: number
    for (;;) {
      const p = hull[k]
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
      if (s > bounds[k]) break
      k--
    }
    k++
    hull[k] = q
    bounds[k] = s
    bounds[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (bounds[k + 1] < q) k++
    const p = hull[k]
    out[q] = (q - p) * (q - p) + f[p]
  }
  f.set(out.subarray(0, n))
}

/**
 * mask が 1 の点について、mask が 0 の点または格子の外までの距離(格子の間隔を 1 とする)を返す。
 * mask が 0 の点は 0 になる。
 */
export function distanceToOutside(mask: Uint8Array, n: number): Float32Array {
  // 格子の外も「外」として扱うために、周りを 1 マス広げて計算する
  const m = n + 2
  const grid = new Float64Array(m * m)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (mask[iz * n + ix] !== 0) grid[(iz + 1) * m + ix + 1] = INF
    }
  }
  const f = new Float64Array(m)
  const out = new Float64Array(m)
  const hull = new Int32Array(m)
  const bounds = new Float64Array(m + 1)
  for (let ix = 0; ix < m; ix++) {
    for (let iz = 0; iz < m; iz++) f[iz] = grid[iz * m + ix]
    transform1d(f, m, hull, bounds, out)
    for (let iz = 0; iz < m; iz++) grid[iz * m + ix] = f[iz]
  }
  for (let iz = 0; iz < m; iz++) {
    for (let ix = 0; ix < m; ix++) f[ix] = grid[iz * m + ix]
    transform1d(f, m, hull, bounds, out)
    for (let ix = 0; ix < m; ix++) grid[iz * m + ix] = f[ix]
  }
  const result = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) result[iz * n + ix] = Math.sqrt(grid[(iz + 1) * m + ix + 1])
  }
  return result
}
