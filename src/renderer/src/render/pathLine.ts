// 経路の表示。weather-globe の矢印の描き方に合わせている。
//   刈る区間: 太さのある矢印(半透明の帯と、幅の広い矢じり)。縁を光る線で囲む。向きがひと目で分かる
//   刈刃を上げて移動する区間: 細い破線
// すでに走り終えた所は薄くする。

import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  type Color
} from 'three'
import type { DrivePath } from '../sim/pathFollower'
import type { Terrain } from '../sim/terrain'
import { OVERLAY_PALETTE, Ribbon, emptySegments, overlayColor } from './overlay/ribbon'
import { buildThickArrow, type ArrowVertex } from './overlay/thickArrow'

/** 地面から浮かせる高さ(m)。塗りを下、線を上にする */
const FILL_LIFT = 0.22
const LINE_LIFT = 0.26
/** 矢印の帯の太さ(m) */
const ARROW_WIDTH = 0.8
/** 矢印の道筋を区切る間隔(m)。地形に沿わせる細かさでもある */
const ARROW_STEP = 1
/** 移動の破線を地形に沿わせるために刻む長さ(m)と、破線 1 組の長さ(m) */
const TRANSIT_STEP = 2
const DASH_LENGTH = 1.6
// 塗りの濃さ(中央と、縁で足す分)
const ARROW_FILL = 0.5
const ARROW_EDGE = 0.2
// 現れる時間と消える時間(秒)
const FADE_IN_SECONDS = 0.6
const FADE_OUT_SECONDS = 0.45

const ARROW_VS = /* glsl */ `
attribute float aProgress;
attribute float aSide;
varying float vProgress;
varying float vSide;
void main() {
  vProgress = aProgress;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const ARROW_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uDone;
uniform float uFade;
varying float vProgress;
varying float vSide;
void main() {
  // 帯の縁を少し濃くする
  float edge = smoothstep(0.45, 1.0, abs(vSide));
  float done = vProgress < uDone ? 0.14 : 1.0;
  gl_FragColor = vec4(uColor, (${ARROW_FILL.toFixed(2)} + ${ARROW_EDGE.toFixed(2)} * edge) * done * uFade);
}
`

export class PathLine {
  /** シーンに追加するまとまり */
  readonly lines = new Group()
  private readonly fill: Mesh
  private readonly fillMaterial: ShaderMaterial
  private readonly outline = new Ribbon({ width: 2.5 })
  private readonly transit = new Ribbon({ width: 2.5, opacity: 0.75 })
  private readonly cutColor: Color
  private readonly transitColor: Color = overlayColor(OVERLAY_PALETTE.snow)
  private shown = false
  private opacity = 0

  constructor(
    private readonly terrain: Terrain,
    /** 刈る区間の色(OVERLAY_PALETTE の色)。複数台の経路を並べて出すときに、機体ごとに変える */
    cutColor: string = OVERLAY_PALETTE.teal
  ) {
    this.cutColor = overlayColor(cutColor)
    this.fillMaterial = new ShaderMaterial({
      uniforms: { uColor: { value: this.cutColor }, uDone: { value: 0 }, uFade: { value: 0 } },
      vertexShader: ARROW_VS,
      fragmentShader: ARROW_FS,
      // 三角形の向きは道筋の向きで変わるので、両面を描く(片面だと上から見えず、塗りが抜ける)
      side: DoubleSide,
      transparent: true,
      depthWrite: false
    })
    this.fill = new Mesh(new BufferGeometry(), this.fillMaterial)
    this.fill.frustumCulled = false
    this.fill.renderOrder = 1
    this.outline.mesh.renderOrder = 2
    this.transit.mesh.renderOrder = 2
    this.lines.add(this.fill, this.outline.mesh, this.transit.mesh)
    this.lines.visible = false
  }

  /** 表示するか。切り替えると、ふわっと現れ、ふわっと消える(tick で進める) */
  set visible(on: boolean) {
    this.shown = on
  }

  /** 毎フレーム呼ぶ。現れたり消えたりする途中の濃さを進める */
  tick(dt: number): void {
    const target = this.shown ? 1 : 0
    if (this.opacity !== target) {
      const step = dt / (this.shown ? FADE_IN_SECONDS : FADE_OUT_SECONDS)
      this.opacity = this.shown ? Math.min(1, this.opacity + step) : Math.max(0, this.opacity - step)
    }
    // 始まりと終わりをゆるやかにする
    const eased = this.opacity * this.opacity * (3 - 2 * this.opacity)
    this.fillMaterial.uniforms.uFade.value = eased
    this.outline.fade = eased
    this.transit.fade = eased
    this.lines.visible = this.opacity > 0
  }

  /** 走り終えた割合(0〜1)。そこまでを薄くする */
  set done(progress: number) {
    this.fillMaterial.uniforms.uDone.value = progress
    this.outline.done = progress
    this.transit.done = progress
  }

  update(path: DrivePath | null): void {
    // 経路を作り直したときは、新しい経路があらためて現れるようにする
    this.opacity = 0
    const positions: number[] = []
    const progress: number[] = []
    const sides: number[] = []
    const outline = emptySegments()
    const transit = emptySegments()
    let total = 0

    if (path) {
      const p = path.points
      const count = p.length / 2
      const along = new Float64Array(count)
      for (let i = 1; i < count; i++) {
        along[i] = along[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1])
      }
      total = Math.max(along[count - 1], 1e-6)

      // 刈る区間と移動の区間に分け、続いている区間を 1 本にまとめる
      let start = 0
      while (start < count - 1) {
        const cut = path.cut[start]
        let end = start + 1
        while (end < count - 1 && path.cut[end] === cut) end++
        const from = along[start] / total
        const to = along[end] / total
        const run = Array.from(p.subarray(start * 2, end * 2 + 2))
        if (cut === 1) this.addArrow(run, from, to, positions, progress, sides, outline)
        else this.addTransit(run, from, to, transit)
        start = end
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aProgress', new Float32BufferAttribute(progress, 1))
    geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1))
    this.fill.geometry.dispose()
    this.fill.geometry = geometry
    this.outline.setSegments(outline)
    this.transit.setSegments(transit)
    this.transit.dashes = total / DASH_LENGTH
  }

  /** 刈る区間 1 本を、太さのある矢印として追加する。from、to は経路全体での進み具合 */
  private addArrow(
    run: number[],
    from: number,
    to: number,
    positions: number[],
    progress: number[],
    sides: number[],
    outline: ReturnType<typeof emptySegments>
  ): void {
    const arrow = buildThickArrow(run, ARROW_WIDTH, ARROW_STEP)
    if (!arrow) return
    const global = (v: ArrowVertex): number => from + (to - from) * v.progress
    for (const triangle of arrow.triangles) {
      for (const v of triangle) {
        positions.push(v.x, this.terrain.heightAt(v.x, v.z) + FILL_LIFT, v.z)
        progress.push(global(v))
        sides.push(v.side)
      }
    }
    const color = this.cutColor
    for (const edge of [arrow.outline.left, arrow.outline.right]) {
      for (let i = 0; i + 1 < edge.length; i++) {
        const a = edge[i]
        const b = edge[i + 1]
        outline.starts.push(a.x, this.terrain.heightAt(a.x, a.z) + LINE_LIFT, a.z)
        outline.ends.push(b.x, this.terrain.heightAt(b.x, b.z) + LINE_LIFT, b.z)
        outline.progress.push(global(a), global(b))
        outline.colors.push(color.r, color.g, color.b)
      }
    }
  }

  /** 移動の区間 1 本を、破線として追加する */
  private addTransit(
    run: number[],
    from: number,
    to: number,
    transit: ReturnType<typeof emptySegments>
  ): void {
    let length = 0
    for (let i = 2; i < run.length; i += 2) length += Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1])
    if (length <= 0) return
    const color = this.transitColor
    let travelled = 0
    for (let i = 0; i + 3 < run.length; i += 2) {
      const ax = run[i]
      const az = run[i + 1]
      const bx = run[i + 2]
      const bz = run[i + 3]
      const segment = Math.hypot(bx - ax, bz - az)
      const steps = Math.max(1, Math.ceil(segment / TRANSIT_STEP))
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps
        const t1 = (s + 1) / steps
        const x0 = ax + (bx - ax) * t0
        const z0 = az + (bz - az) * t0
        const x1 = ax + (bx - ax) * t1
        const z1 = az + (bz - az) * t1
        transit.starts.push(x0, this.terrain.heightAt(x0, z0) + LINE_LIFT, z0)
        transit.ends.push(x1, this.terrain.heightAt(x1, z1) + LINE_LIFT, z1)
        transit.progress.push(
          from + ((to - from) * (travelled + segment * t0)) / length,
          from + ((to - from) * (travelled + segment * t1)) / length
        )
        transit.colors.push(color.r, color.g, color.b)
      }
      travelled += segment
    }
  }

  /** 形と材質を片付ける。台数を減らして機体を消すときに呼ぶ(シーンから外すのは呼ぶ側) */
  dispose(): void {
    this.fill.geometry.dispose()
    this.fillMaterial.dispose()
    this.outline.dispose()
    this.transit.dispose()
  }
}
