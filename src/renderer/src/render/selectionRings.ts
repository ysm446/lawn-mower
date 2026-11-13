// 管制の視点で選んでいる機体のまわりに出す輪。経路の太い矢印(pathLine.ts)と同じ描き方にそろえる:
// 半透明の帯(縁を少し濃く)と、その内と外の縁を光る線(Ribbon)で囲む。帯は地面の起伏に沿わせる。
// 色は機体の経路の色。選んだときに少し大きい所から縮んで現れ、ゆっくり回る切れ目で「選んでいる」ことを示す。

import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, ShaderMaterial, type Color } from 'three'
import type { Terrain } from '../sim/terrain'
import { Ribbon, emptySegments } from './overlay/ribbon'

/** 輪の帯の中心の半径(m)と、帯の太さ(m)。機体(長さ約 3 m)を囲む大きさ */
const RING_RADIUS = 2.9
const RING_WIDTH = 0.5
/** 輪を何分割するか */
const RING_SEGMENTS = 64
/** 切れ目の数と、1 つの切れ目が輪を占める割合 */
const RING_GAPS = 4
const GAP_SHARE = 0.035
/** 切れ目が回る速さ(1 秒あたりの回転) */
const SPIN_PER_SECOND = 0.06
/** 地面から浮かせる高さ(m)。塗りを下、線を上にする */
const FILL_LIFT = 0.22
const LINE_LIFT = 0.26
// 塗りの濃さ(中央と、縁で足す分)。矢印と同じ
const RING_FILL = 0.5
const RING_EDGE = 0.2
/** 選んだときに縮んで現れる時間(秒)と、始めの大きさ */
const APPEAR_SECONDS = 0.25
const APPEAR_SCALE = 1.35

const RING_VS = /* glsl */ `
attribute float aSide;
attribute vec3 aColor;
attribute float aFade;
varying float vSide;
varying vec3 vColor;
varying float vFade;
void main() {
  vSide = aSide;
  vColor = aColor;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const RING_FS = /* glsl */ `
varying float vSide;
varying vec3 vColor;
varying float vFade;
void main() {
  // 帯の縁を少し濃くする
  float edge = smoothstep(0.45, 1.0, abs(vSide));
  gl_FragColor = vec4(vColor, (${RING_FILL.toFixed(2)} + ${RING_EDGE.toFixed(2)} * edge) * vFade);
}
`

/** 輪を出す機体 1 台ぶん */
export interface RingTarget {
  /** 区別のための番号(機体の番号)。選び直したときの現れ方に使う */
  id: number
  x: number
  z: number
  color: Color
}

export class SelectionRings {
  readonly fill: Mesh
  readonly outline = new Ribbon({ width: 2.5 })
  private readonly material: ShaderMaterial
  private spin = 0
  /** 機体ごとの、現れてからの時間(秒) */
  private readonly ages = new Map<number, number>()

  constructor(private readonly terrain: Terrain) {
    this.material = new ShaderMaterial({
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      side: DoubleSide,
      transparent: true,
      depthWrite: false
    })
    this.fill = new Mesh(new BufferGeometry(), this.material)
    this.fill.frustumCulled = false
    this.fill.renderOrder = 1
    this.outline.mesh.renderOrder = 2
    this.fill.visible = false
    this.outline.mesh.visible = false
  }

  /** 毎フレーム呼ぶ。targets は選んでいる機体 */
  update(targets: RingTarget[], dt: number): void {
    const shown = targets.length > 0
    this.fill.visible = shown
    this.outline.mesh.visible = shown
    // 選ばれなくなった機体は忘れる(また選んだら、あらためて現れる)
    for (const id of [...this.ages.keys()]) if (!targets.some((t) => t.id === id)) this.ages.delete(id)
    if (!shown) return
    this.spin = (this.spin + dt * SPIN_PER_SECOND) % 1

    const positions: number[] = []
    const sides: number[] = []
    const colors: number[] = []
    const fades: number[] = []
    const lines = emptySegments()
    for (const target of targets) {
      const age = (this.ages.get(target.id) ?? 0) + dt
      this.ages.set(target.id, age)
      const t = Math.min(age / APPEAR_SECONDS, 1)
      const ease = 1 - (1 - t) * (1 - t)
      const scale = APPEAR_SCALE + (1 - APPEAR_SCALE) * ease
      const inner = (RING_RADIUS - RING_WIDTH / 2) * scale
      const outer = (RING_RADIUS + RING_WIDTH / 2) * scale
      const { r, g, b } = target.color
      const point = (radius: number, angle: number, lift: number): [number, number, number] => {
        const x = target.x + Math.cos(angle) * radius
        const z = target.z + Math.sin(angle) * radius
        return [x, this.terrain.heightAt(x, z) + lift, z]
      }
      // 切れ目と切れ目の間の弧を、回った角度から直接作る(分割の区切りごとに切れ目を飛ばすと、
      // 切れ目が 1 区切りずつ跳んで動き、なめらかに回らない)
      const arc = 1 / RING_GAPS - GAP_SHARE
      const pieces = Math.max(1, Math.round(RING_SEGMENTS / RING_GAPS))
      for (let i = 0; i < RING_GAPS * pieces; i++) {
        const k = Math.floor(i / pieces)
        const j = i % pieces
        const start = k / RING_GAPS + GAP_SHARE / 2 - this.spin
        const a0 = (start + (arc * j) / pieces) * Math.PI * 2
        const a1 = (start + (arc * (j + 1)) / pieces) * Math.PI * 2
        const i0 = point(inner, a0, FILL_LIFT)
        const o0 = point(outer, a0, FILL_LIFT)
        const i1 = point(inner, a1, FILL_LIFT)
        const o1 = point(outer, a1, FILL_LIFT)
        positions.push(...i0, ...o0, ...o1, ...i0, ...o1, ...i1)
        sides.push(-1, 1, 1, -1, 1, -1)
        for (let k = 0; k < 6; k++) {
          colors.push(r, g, b)
          fades.push(ease)
        }
        for (const radius of [inner, outer]) {
          lines.starts.push(...point(radius, a0, LINE_LIFT))
          lines.ends.push(...point(radius, a1, LINE_LIFT))
          lines.progress.push(0, 0)
          lines.colors.push(r * ease, g * ease, b * ease)
        }
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1))
    geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
    geometry.setAttribute('aFade', new Float32BufferAttribute(fades, 1))
    this.fill.geometry.dispose()
    this.fill.geometry = geometry
    this.outline.setSegments(lines)
  }
}
