// 刈る前の芝の長さのむら。場所ごとの「長さの倍率」を格子で持つ。描画に依存しない。
// 描画(葉の長さ、地面の色)と、シミュレーション(刈りカスの量)の両方が同じ値を使う。

import { gradientNoise } from './terrain'

export interface GrassFieldOptions {
  seed: number
  /** 覆う範囲の一辺(m)。原点が中心 */
  size: number
  /** 一辺の標本数 */
  resolution: number
}

/** 長さの倍率の下限と上限(基準の芝丈に掛ける) */
export const LENGTH_FACTOR_MIN = 0.4
export const LENGTH_FACTOR_MAX = 1.75

export class GrassField {
  /** 長さのむら(0〜255)。0 が最も短く、255 が最も長い。添字は iz * resolution + ix */
  readonly data: Uint8Array

  constructor(readonly options: GrassFieldOptions) {
    const { seed, size, resolution } = options
    this.data = new Uint8Array(resolution * resolution)
    const cell = size / resolution
    for (let iz = 0; iz < resolution; iz++) {
      const z = -size / 2 + (iz + 0.5) * cell
      for (let ix = 0; ix < resolution; ix++) {
        const x = -size / 2 + (ix + 0.5) * cell
        // 数 m ごとの株のかたまりと、もっと大きな広がりを重ねる
        const clump = gradientNoise(x / 2.9, z / 2.9, seed + 311)
        const spread = gradientNoise(x / 15, z / 15, seed + 733)
        const v = 0.5 + clump * 0.6 + spread * 0.5
        this.data[iz * resolution + ix] = Math.round(Math.min(Math.max(v, 0), 1) * 255)
      }
    }
  }

  /** (x, z) での長さの倍率。範囲の外は端の値 */
  lengthFactorAt(x: number, z: number): number {
    const { size, resolution } = this.options
    const gx = Math.min(Math.max(((x + size / 2) / size) * resolution - 0.5, 0), resolution - 1)
    const gz = Math.min(Math.max(((z + size / 2) / size) * resolution - 0.5, 0), resolution - 1)
    const ix = Math.min(Math.floor(gx), resolution - 2)
    const iz = Math.min(Math.floor(gz), resolution - 2)
    const fx = gx - ix
    const fz = gz - iz
    const i = iz * resolution + ix
    const d = this.data
    const top = d[i] + (d[i + 1] - d[i]) * fx
    const bottom = d[i + resolution] + (d[i + resolution + 1] - d[i + resolution]) * fx
    const v = (top + (bottom - top) * fz) / 255
    return LENGTH_FACTOR_MIN + (LENGTH_FACTOR_MAX - LENGTH_FACTOR_MIN) * v
  }
}
