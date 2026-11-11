// 区分けの表示。区分ごとの色を地面に重ねるためのテクスチャと、領域の輪郭線を受け持つ。

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  RGBAFormat,
  UnsignedByteType
} from 'three'
import type { Terrain } from '../sim/terrain'
import {
  ZONE_NONE,
  ZONE_RIDE,
  ZONE_SLOPE,
  simplifyLoop,
  traceRegion,
  type ZoningResult
} from '../sim/zoning'

// 重ねる色(R, G, B, 濃さ)。乗用機で刈れて出発点から届く所は、芝の色をそのまま見せる
const COLOR_RIDE = [0, 0, 0, 0]
const COLOR_RIDE_UNREACHABLE = [30, 80, 150, 140]
const COLOR_SLOPE = [170, 110, 10, 150]
const COLOR_NONE = [150, 25, 15, 165]

/** 輪郭線を地面から浮かせる高さ(m) */
const LINE_LIFT = 0.15
/** 輪郭線を地形に沿わせるために刻む長さ(m) */
const LINE_STEP = 2

export class ZoneOverlay {
  readonly texture: DataTexture
  readonly lines: LineSegments
  private readonly pixels: Uint8Array

  constructor(private readonly terrain: Terrain) {
    const n = terrain.samples
    this.pixels = new Uint8Array(n * n * 4)
    this.texture = new DataTexture(this.pixels, n, n, RGBAFormat, UnsignedByteType)
    this.texture.minFilter = LinearFilter
    this.texture.magFilter = LinearFilter
    this.texture.wrapS = ClampToEdgeWrapping
    this.texture.wrapT = ClampToEdgeWrapping

    const material = new LineBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false })
    this.lines = new LineSegments(new BufferGeometry(), material)
    this.lines.frustumCulled = false
    this.lines.visible = false
  }

  set visible(on: boolean) {
    this.lines.visible = on
  }

  /** 区分けの結果を表示に反映する */
  update(result: ZoningResult): void {
    const { zones, labels, regions, samples: n } = result
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i]
      const color =
        zone === ZONE_NONE
          ? COLOR_NONE
          : zone === ZONE_SLOPE
            ? COLOR_SLOPE
            : regions[labels[i]].reachable
              ? COLOR_RIDE
              : COLOR_RIDE_UNREACHABLE
      this.pixels.set(color, i * 4)
    }
    this.texture.needsUpdate = true

    // 乗用機の領域と刈らない領域の輪郭を描けば、区分の境目はすべて描かれる
    const { cell } = this.terrain.options
    const origin = this.terrain.origin
    const points: number[] = []
    for (const region of regions) {
      if (region.zone !== ZONE_RIDE && region.zone !== ZONE_NONE) continue
      for (const raw of traceRegion(labels, n, region.id)) {
        const loop = simplifyLoop(raw, 0.75)
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length
          this.addDraped(
            points,
            origin + loop[i] * cell,
            origin + loop[i + 1] * cell,
            origin + loop[j] * cell,
            origin + loop[j + 1] * cell
          )
        }
      }
    }
    this.lines.geometry.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3))
    this.lines.geometry = geometry
  }

  /** 線分を短く刻み、地形に沿わせて追加する */
  private addDraped(points: number[], ax: number, az: number, bx: number, bz: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / LINE_STEP))
    let px = ax
    let pz = az
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const qx = ax + (bx - ax) * t
      const qz = az + (bz - az) * t
      points.push(px, this.terrain.heightAt(px, pz) + LINE_LIFT, pz)
      points.push(qx, this.terrain.heightAt(qx, qz) + LINE_LIFT, qz)
      px = qx
      pz = qz
    }
  }
}
