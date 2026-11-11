// 区分けの表示。weather-globe の「範囲」の描き方に合わせている。
//   塗り: 輪郭のすぐ内側が濃く、内側へ行くほど薄くなる(輪郭から内へ広がる光)。地面のシェーダーが重ねる
//   縁取り: 画面の上で一定の太さを持つ、光る線
// 乗用機で刈れて出発点から届く所は、何も重ねずに芝をそのまま見せる。

import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  Group,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType
} from 'three'
import { smoothLoop } from '../sim/coveragePlan'
import { distanceToOutside } from '../sim/distance'
import type { Terrain } from '../sim/terrain'
import { ZONE_NONE, ZONE_SLOPE, traceRegion, type ZoningResult } from '../sim/zoning'
import { OVERLAY_PALETTE, Ribbon, emptySegments } from './overlay/ribbon'

// 重ねる種類。0 は何も重ねない(乗用機で刈れて、出発点から届く所)
const KIND_UNREACHABLE = 1
const KIND_SLOPE = 2
const KIND_NONE = 3
const KIND_COLORS = [
  '#000000',
  OVERLAY_PALETTE.sky, // 乗用機で刈れるが、出発点から届かない
  OVERLAY_PALETTE.gold, // 斜面用の機種で刈る
  OVERLAY_PALETTE.coral // 刈らない
]

/** 塗りの、輪郭のすぐ内側の濃さ。内側ほど薄くなる */
const FILL_OPACITY = 0.42
/** 範囲の中央の濃さ(輪郭のすぐ内側に対する割合) */
const FILL_FLOOR = 0.16
// グラデーションの幅。範囲の中央から輪郭までの距離に対する割合と、その下限と上限(m)
const GRADIENT_SHARE = 0.22
const GRADIENT_MIN = 3
const GRADIENT_MAX = 12

/** 縁取りを地面から浮かせる高さ(m) */
const LINE_LIFT = 0.2
/** 縁取りの太さ(画素) */
const OUTLINE_WIDTH = 3.5
/** 輪郭線をならす回数。多いほどなめらかで、細かな出入りが消える */
const OUTLINE_SMOOTHING = 6
/** 輪郭線を地形に沿わせるために刻む長さ(m) */
const LINE_STEP = 2

export class ZoneOverlay {
  /** 塗りの色(RGB)と濃さ(A)。地面のシェーダーが読む */
  readonly texture: DataTexture
  /** シーンに追加するまとまり(縁取り) */
  readonly lines = new Group()
  private readonly pixels: Uint8Array
  private readonly outline = new Ribbon({ width: OUTLINE_WIDTH })

  constructor(private readonly terrain: Terrain) {
    const n = terrain.samples
    this.pixels = new Uint8Array(n * n * 4)
    this.texture = new DataTexture(this.pixels, n, n, RGBAFormat, UnsignedByteType)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = LinearFilter
    this.texture.magFilter = LinearFilter
    this.texture.wrapS = ClampToEdgeWrapping
    this.texture.wrapT = ClampToEdgeWrapping
    this.outline.mesh.renderOrder = 2
    this.lines.add(this.outline.mesh)
    this.lines.visible = false
  }

  set visible(on: boolean) {
    this.lines.visible = on
  }

  /** 区分けの結果を表示に反映する */
  update(result: ZoningResult): void {
    const { zones, labels, regions, samples: n } = result
    const { cell } = this.terrain.options
    const kinds = new Uint8Array(zones.length)
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i]
      kinds[i] =
        zone === ZONE_NONE
          ? KIND_NONE
          : zone === ZONE_SLOPE
            ? KIND_SLOPE
            : regions[labels[i]].reachable
              ? 0
              : KIND_UNREACHABLE
    }

    // 塗り: 種類ごとに、輪郭までの距離から濃さを決める
    this.pixels.fill(0)
    const mask = new Uint8Array(zones.length)
    const color = new Color()
    for (let kind = 1; kind < KIND_COLORS.length; kind++) {
      let any = false
      for (let i = 0; i < kinds.length; i++) {
        mask[i] = kinds[i] === kind ? 1 : 0
        if (mask[i] === 1) any = true
      }
      if (!any) continue
      const distance = distanceToOutside(mask, n)
      let deepest = 0
      for (let i = 0; i < distance.length; i++) deepest = Math.max(deepest, distance[i])
      const width = Math.min(Math.max(deepest * cell * GRADIENT_SHARE, GRADIENT_MIN), GRADIENT_MAX)
      // 色は sRGB のままテクスチャに入れる(読むときに光の強さに比例する値へ変換される)
      color.set(KIND_COLORS[kind])
      const r = Math.round(color.clone().convertLinearToSRGB().r * 255)
      const g = Math.round(color.clone().convertLinearToSRGB().g * 255)
      const b = Math.round(color.clone().convertLinearToSRGB().b * 255)
      for (let i = 0; i < kinds.length; i++) {
        if (mask[i] === 0) continue
        // 格子点は輪郭から半マス内側にあるので、その分を引く
        const glow = Math.exp(-Math.max(distance[i] - 0.5, 0) * cell / width)
        const alpha = FILL_OPACITY * (FILL_FLOOR + (1 - FILL_FLOOR) * glow)
        this.pixels[i * 4] = r
        this.pixels[i * 4 + 1] = g
        this.pixels[i * 4 + 2] = b
        this.pixels[i * 4 + 3] = Math.round(alpha * 255)
      }
    }
    this.texture.needsUpdate = true

    // 縁取り: 種類ごとの範囲の輪郭を、その色の光る線で描く
    const origin = this.terrain.origin
    const segments = emptySegments()
    const kindLabels = new Int32Array(zones.length)
    for (let kind = 1; kind < KIND_COLORS.length; kind++) {
      let any = false
      for (let i = 0; i < kinds.length; i++) {
        kindLabels[i] = kinds[i] === kind ? 1 : 0
        if (kindLabels[i] === 1) any = true
      }
      if (!any) continue
      color.set(KIND_COLORS[kind])
      for (const raw of traceRegion(kindLabels, n, 1)) {
        // 格子に沿った輪郭は斜めの所が階段状になるので、ならしてから描く
        const loop = smoothLoop(
          raw.map((v) => origin + v * cell),
          1,
          OUTLINE_SMOOTHING
        )
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length
          this.addDraped(segments, loop[i], loop[i + 1], loop[j], loop[j + 1], color)
        }
      }
    }
    this.outline.setSegments(segments)
  }

  /** 線分を短く刻み、地形に沿わせて追加する */
  private addDraped(
    segments: ReturnType<typeof emptySegments>,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    color: Color
  ): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / LINE_STEP))
    let px = ax
    let pz = az
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const qx = ax + (bx - ax) * t
      const qz = az + (bz - az) * t
      segments.starts.push(px, this.terrain.heightAt(px, pz) + LINE_LIFT, pz)
      segments.ends.push(qx, this.terrain.heightAt(qx, qz) + LINE_LIFT, qz)
      segments.progress.push(0, 0)
      segments.colors.push(color.r, color.g, color.b)
      px = qx
      pz = qz
    }
  }
}
