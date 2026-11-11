// 地形。なだらかな丘陵を、シード値から手続き的に作る。描画に依存しない。
// 単位は m。Y が上で、高さは (x, z) の関数として持つ。
// 中央の範囲は一定間隔の格子(高さマップ)として持ち、走行と区分けはこの格子を使う。
// 格子の外は式から直接求める(遠景の山並み用)。

/** 地形の形の調整。マップごとに変える */
export interface TerrainShape {
  /** 丘の起伏の倍率(1 が基準。小さいほど平ら) */
  hillScale: number
  /** 遠景の山並みの高さの倍率 */
  mountainScale: number
}

export const DEFAULT_SHAPE: TerrainShape = { hillScale: 1, mountainScale: 1 }

export interface TerrainOptions {
  /** 地形を決めるシード値。同じ値なら同じ地形になる */
  seed: number
  /** 格子で持つ範囲の一辺(m)。原点が中心 */
  size: number
  /** 格子の間隔(m) */
  cell: number
  /** 地形の形の調整。省くと基準の丘陵 */
  shape?: TerrainShape
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 7,
  size: 512,
  cell: 1
}

export interface Gradient {
  /** x 方向の傾き(高さ / 水平距離) */
  dx: number
  /** z 方向の傾き */
  dz: number
}

function hash(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

function corner(ix: number, iz: number, fx: number, fz: number, seed: number): number {
  const angle = (hash(ix, iz, seed) / 4294967296) * Math.PI * 2
  return Math.cos(angle) * fx + Math.sin(angle) * fz
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** 勾配ノイズ(パーリンノイズ)。値はおよそ -0.7〜0.7 */
export function gradientNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fz)
  const a = corner(ix, iz, fx, fz, seed)
  const b = corner(ix + 1, iz, fx - 1, fz, seed)
  const c = corner(ix, iz + 1, fx, fz - 1, seed)
  const d = corner(ix + 1, iz + 1, fx - 1, fz - 1, seed)
  return a + (b - a) * u + (c - a + (a - b - c + d) * u) * v
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1)
  return t * t * (3 - 2 * t)
}

// 丘の波の重ね合わせ: [波長 m, 振幅 m]
const HILL_OCTAVES: ReadonlyArray<readonly [number, number]> = [
  [160, 24],
  [74, 7],
  [34, 1.8]
]

/** 式から直接求めた高さ。どこでも呼べる */
export function terrainHeight(
  x: number,
  z: number,
  seed: number,
  shape: TerrainShape = DEFAULT_SHAPE
): number {
  let hills = 0
  for (let i = 0; i < HILL_OCTAVES.length; i++) {
    const [wavelength, amplitude] = HILL_OCTAVES[i]
    hills += gradientNoise(x / wavelength, z / wavelength, seed + i * 101) * amplitude
  }
  // 起伏の大きい所と小さい所をつくる(平らに近い所から急な斜面まで出るように)
  const relief = 0.35 + 1.5 * smoothstep(-0.45, 0.45, gradientNoise(x / 330, z / 330, seed + 977))
  hills *= shape.hillScale
  let h = hills * relief

  // 遠くは山並みにして、地平線を隠す
  const far = smoothstep(320, 1900, Math.hypot(x, z))
  if (far > 0) {
    const ridge = gradientNoise(x / 820, z / 820, seed + 1543)
    h += far * far * (150 + 330 * (ridge + 0.5)) * shape.mountainScale + far * hills * 3
  }
  return h
}

export class Terrain {
  /** 一辺の標本数 */
  readonly samples: number
  /** 格子の端の座標(x、z 共通) */
  readonly origin: number
  /** 高さ(m)。添字は iz * samples + ix */
  readonly heights: Float32Array

  constructor(readonly options: TerrainOptions = DEFAULT_TERRAIN) {
    const { seed, size, cell } = options
    this.samples = Math.round(size / cell) + 1
    this.origin = -size / 2
    this.heights = new Float32Array(this.samples * this.samples)
    for (let iz = 0; iz < this.samples; iz++) {
      for (let ix = 0; ix < this.samples; ix++) {
        this.heights[iz * this.samples + ix] = terrainHeight(
          this.origin + ix * cell,
          this.origin + iz * cell,
          seed,
          options.shape
        )
      }
    }
  }

  /** 地面の高さ。格子の中は格子から補間し、外は式から求める */
  heightAt(x: number, z: number): number {
    const { cell, seed, shape } = this.options
    const gx = (x - this.origin) / cell
    const gz = (z - this.origin) / cell
    const last = this.samples - 1
    if (gx < 0 || gz < 0 || gx > last || gz > last) return terrainHeight(x, z, seed, shape)
    const ix = Math.min(Math.floor(gx), last - 1)
    const iz = Math.min(Math.floor(gz), last - 1)
    const fx = gx - ix
    const fz = gz - iz
    const i = iz * this.samples + ix
    const h = this.heights
    const a = h[i]
    const b = h[i + 1]
    const c = h[i + this.samples]
    const d = h[i + this.samples + 1]
    return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fz
  }

  /**
   * 点 (px, py, pz) から向き (dx, dy, dz)(長さ 1)へ進んだ線が、地面に当たるまでの距離(m)。
   * max まで進んでも当たらなければ max を返す。
   * 遠くほど粗く進み、地面の下に入ったら、その区間を二分して詰める
   */
  rayDistance(px: number, py: number, pz: number, dx: number, dy: number, dz: number, max: number): number {
    let near = 0
    let far = 0
    while (far < max) {
      near = far
      far = Math.min(max, far + Math.max(0.5, far * 0.03))
      if (py + dy * far > this.heightAt(px + dx * far, pz + dz * far)) continue
      for (let i = 0; i < 12; i++) {
        const mid = (near + far) / 2
        if (py + dy * mid <= this.heightAt(px + dx * mid, pz + dz * mid)) far = mid
        else near = mid
      }
      return far
    }
    return max
  }

  /** 地面の傾き。span は差分をとる幅(m) */
  gradientAt(x: number, z: number, out: Gradient, span = 1): Gradient {
    const half = span / 2
    out.dx = (this.heightAt(x + half, z) - this.heightAt(x - half, z)) / span
    out.dz = (this.heightAt(x, z + half) - this.heightAt(x, z - half)) / span
    return out
  }

  /** 勾配(ラジアン)。水平が 0 */
  slopeAt(x: number, z: number, span = 1): number {
    const g = this.gradientAt(x, z, scratch, span)
    return Math.atan(Math.hypot(g.dx, g.dz))
  }

  /** 向き heading に進むときの、進行方向の傾き(高さ / 水平距離) */
  gradeAlong(x: number, z: number, heading: number, span = 1): number {
    const g = this.gradientAt(x, z, scratch, span)
    return g.dx * Math.sin(heading) + g.dz * Math.cos(heading)
  }
}

const scratch: Gradient = { dx: 0, dz: 0 }
