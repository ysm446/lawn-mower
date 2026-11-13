// 管制の視点で、機体を選んでいる間にマウスの下の区画を浮かび上がらせる表示(右クリックで指示する前に、行き先を見せる)。
// 区分けの表示(zoneOverlay.ts)と同じ「範囲」の描き方にそろえる:
//   塗り: 区画の輪郭を多角形として三角形に分け、地形に沿わせた面で描く。輪郭のすぐ内側だけを光らせ、
//         数 m 内側で消える(区画の中ほどは塗らない。大きな区画でも画面の全体が色づかないように)
//   縁取り: 画面の上で一定の太さを持つ、光る線。塗りと同じ輪郭を使う
// 色は選んでいる機体の経路の色。形は区画ごとに一度だけ作って取っておく。
// 右クリックで指示したときは、その区画を 2 回点滅させてから消す(confirm。指示が通ったことのサイン)。

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  ShapeUtils,
  Vector2
} from 'three'
import { smoothLoop } from '../sim/coveragePlan'
import { distanceToOutside } from '../sim/distance'
import type { PlotResult } from '../sim/plots'
import type { Terrain } from '../sim/terrain'
import { loopArea, traceRegion } from '../sim/zoning'
import { Ribbon, emptySegments, type RibbonSegments } from './overlay/ribbon'

/** 塗りの、輪郭のすぐ内側の濃さ。内側ほど薄くなり、GRADIENT_WIDTH の数倍で消える */
const FILL_OPACITY = 0.5
/** グラデーションの幅(m)。輪郭からこの距離で濃さが約 1/3 になる。区画の大きさによらず一定 */
const GRADIENT_WIDTH = 2.5
/** 地面から浮かせる高さ(m)。区画の線(plotOverlay.ts、0.36 m)より上にして、重なっても見えるようにする */
const FILL_LIFT = 0.38
const LINE_LIFT = 0.4
/** 縁取りの太さ(画素) */
const OUTLINE_WIDTH = 3.5
/** 輪郭線をならす回数。区画の線と揃える */
const OUTLINE_SMOOTHING = 6
/** 塗りの三角形の辺の長さの上限(m)。地形に沿わせ、グラデーションをなめらかにする細かさ */
const MAX_TRIANGLE_EDGE = 4
/** 現れる時間と消える時間(秒)。ふわっと現れ、すっと消える */
const FADE_IN_SECONDS = 0.35
const FADE_OUT_SECONDS = 0.2
/** 別の区画に移るとき、前の区画を消す時間(秒)。消えきってから次の区画が現れる */
const SWITCH_OUT_SECONDS = 0.1
/** 指示したときのサインの長さ(秒)と、その間の点滅の回数 */
const CONFIRM_SECONDS = 0.8
const CONFIRM_BLINKS = 2

const FILL_VS = /* glsl */ `
attribute float aEdge;  // 輪郭までの距離(m)
attribute float aWidth; // グラデーションの幅(m)
varying float vEdge;
varying float vWidth;
void main() {
  vEdge = aEdge;
  vWidth = aWidth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FILL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uFade;
varying float vEdge;
varying float vWidth;
void main() {
  float glow = clamp(exp(-max(vEdge, 0.0) / max(vWidth, 0.5)), 0.0, 1.0);
  float alpha = ${FILL_OPACITY.toFixed(2)} * glow;
  gl_FragColor = vec4(uColor * (1.0 + glow * 0.25), alpha * uFade);
}
`

/** 区画 1 つぶんの形(色は持たない) */
interface PlotShape {
  positions: Float32Array
  edges: Float32Array
  widths: Float32Array
  /** 縁取りの線分(色は白。描くときに色を入れる) */
  outline: RibbonSegments
}

/** 点が輪(x と z を交互に並べたもの)の内側にあるか */
function insideLoop(x: number, z: number, loop: number[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    const xi = loop[i]
    const zi = loop[i + 1]
    const xj = loop[j]
    const zj = loop[j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

const toVectors = (loop: number[]): Vector2[] => {
  const out: Vector2[] = []
  for (let i = 0; i < loop.length; i += 2) out.push(new Vector2(loop[i], loop[i + 1]))
  return out
}

export class PlotHover {
  /** シーンに追加するまとまり(塗りと縁取り) */
  readonly lines = new Group()
  private readonly fill: Mesh
  private readonly outline = new Ribbon({ width: OUTLINE_WIDTH })
  private readonly color = { value: new Color() }
  private readonly fade = { value: 0 }
  private result: PlotResult | null = null
  private readonly shapes = new Map<number, PlotShape>()
  /** 今描いている区画(-1 はなし)と、色 */
  private drawn = -1
  private readonly drawnColor = new Color()
  /** 出したい区画(-1 は消す) */
  private wanted = -1
  private readonly wantedColor = new Color()
  private opacity = 0
  /** 指示のサインを出している区画(-1 はなし)と、出してからの時間(秒) */
  private confirmPlot = -1
  private confirmAge = 0

  constructor(private readonly terrain: Terrain) {
    const material = new ShaderMaterial({
      uniforms: { uColor: this.color, uFade: this.fade },
      vertexShader: FILL_VS,
      fragmentShader: FILL_FS,
      side: DoubleSide,
      transparent: true,
      depthWrite: false
    })
    this.fill = new Mesh(new BufferGeometry(), material)
    this.fill.frustumCulled = false
    this.fill.renderOrder = 3
    this.outline.mesh.renderOrder = 4
    this.lines.add(this.fill, this.outline.mesh)
    this.lines.visible = false
  }

  /** 区画分けの結果が変わったとき。取っておいた形は捨てる */
  setResult(result: PlotResult | null): void {
    if (result === this.result) return
    this.result = result
    this.shapes.clear()
    this.drawn = -1
    this.wanted = -1
    this.opacity = 0
    this.confirmPlot = -1
  }

  /** 指示した区画に、点滅して消えるサインを出す。その間は、マウスの下の区画より優先する */
  confirm(plot: number, color: Color): void {
    const shape = plot >= 0 ? this.shapeOf(plot) : null
    if (!shape) return
    this.draw(shape, color)
    this.drawn = plot
    this.drawnColor.copy(color)
    this.confirmPlot = plot
    this.confirmAge = 0
  }

  /** 浮かび上がらせる区画と色を伝える(毎フレーム呼んでよい)。plot が -1 なら消す */
  show(plot: number, color: Color): void {
    // 指示のサインを出している間は、マウスの下の区画に替えない
    if (this.confirmPlot >= 0) return
    this.wanted = plot
    this.wantedColor.copy(color)
    // 同じ区画で色だけ変わったとき(選ぶ機体を変えたとき)は、すぐに塗り直す。
    // 別の区画に移ったときは、前の区画が消えきってから tick で描き替える
    if (plot >= 0 && plot === this.drawn && !color.equals(this.drawnColor)) {
      const shape = this.shapeOf(plot)
      if (shape) this.draw(shape, color)
      this.drawnColor.copy(color)
    }
  }

  /** 毎フレーム呼ぶ。現れたり消えたりする途中の濃さを進める */
  tick(dt: number): void {
    if (this.confirmPlot >= 0) {
      this.confirmAge += dt
      const t = this.confirmAge / CONFIRM_SECONDS
      if (t < 1) {
        // 明るく始まり、CONFIRM_BLINKS 回点滅しながら弱まる
        const blink = 0.55 + 0.45 * Math.cos(t * CONFIRM_BLINKS * Math.PI * 2)
        const value = Math.sqrt(1 - t) * blink
        this.fade.value = value
        this.outline.fade = value
        this.lines.visible = true
        return
      }
      // サインが終わったら、マウスの下の区画の表示に戻る(あらためて現れる)
      this.confirmPlot = -1
      this.wanted = -1
      this.opacity = 0
    }
    // 前の区画が消えきったら(または何も出ていなければ)、出したい区画に描き替える
    if (this.wanted >= 0 && this.wanted !== this.drawn && this.opacity === 0) {
      const shape = this.shapeOf(this.wanted)
      if (shape) {
        this.draw(shape, this.wantedColor)
        this.drawn = this.wanted
        this.drawnColor.copy(this.wantedColor)
      } else this.wanted = -1
    }
    const shown = this.wanted >= 0 && this.wanted === this.drawn
    if (shown) this.opacity = Math.min(1, this.opacity + dt / FADE_IN_SECONDS)
    else {
      // 別の区画へ移る途中は早めに消し、何も指していないときはゆっくり消す
      const out = this.wanted >= 0 ? SWITCH_OUT_SECONDS : FADE_OUT_SECONDS
      this.opacity = Math.max(0, this.opacity - dt / out)
    }
    const eased = this.opacity * this.opacity * (3 - 2 * this.opacity)
    this.fade.value = eased
    this.outline.fade = eased
    this.lines.visible = this.opacity > 0
  }

  private draw(shape: PlotShape, color: Color): void {
    this.color.value.copy(color)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(shape.positions, 3))
    geometry.setAttribute('aEdge', new Float32BufferAttribute(shape.edges, 1))
    geometry.setAttribute('aWidth', new Float32BufferAttribute(shape.widths, 1))
    this.fill.geometry.dispose()
    this.fill.geometry = geometry
    const segments = { ...shape.outline, colors: shape.outline.colors.map((_, i) => [color.r, color.g, color.b][i % 3]) }
    this.outline.setSegments(segments)
  }

  /** 区画の形(なければ作って取っておく) */
  private shapeOf(plot: number): PlotShape | null {
    const cached = this.shapes.get(plot)
    if (cached) return cached
    const result = this.result
    if (!result || plot >= result.plots.length) return null
    const n = result.samples
    const { cell } = this.terrain.options
    const origin = this.terrain.origin
    const terrain = this.terrain

    const mask = new Uint8Array(n * n)
    let any = false
    for (let i = 0; i < mask.length; i++) {
      if (result.labels[i] === plot) {
        mask[i] = 1
        any = true
      }
    }
    if (!any) return null

    // 輪郭までの距離(格子から求める)。塗りの濃さを決めるのに使う
    const distance = distanceToOutside(mask, n)
    const width = GRADIENT_WIDTH
    const edgeAt = (x: number, z: number): number => {
      const gx = Math.min(Math.max((x - origin) / cell, 0), n - 1.001)
      const gz = Math.min(Math.max((z - origin) / cell, 0), n - 1.001)
      const ix = Math.floor(gx)
      const iz = Math.floor(gz)
      const fx = gx - ix
      const fz = gz - iz
      const i = iz * n + ix
      const top = distance[i] + (distance[i + 1] - distance[i]) * fx
      const bottom = distance[i + n] + (distance[i + n + 1] - distance[i + n]) * fx
      // 格子点は輪郭から半マス内側にあるので、その分を引く
      return Math.max((top + (bottom - top) * fz - 0.5) * cell, 0)
    }

    const positions: number[] = []
    const edges: number[] = []
    const pushVertex = (x: number, z: number): void => {
      positions.push(x, terrain.heightAt(x, z) + FILL_LIFT, z)
      edges.push(edgeAt(x, z))
    }
    // 三角形を、地形に沿う細かさになるまで、いちばん長い辺の中点で 2 つに分けていく(zoneOverlay.ts と同じ)
    const subdivide = (a: Vector2, b: Vector2, c: Vector2, depth: number): void => {
      const ab = a.distanceTo(b)
      const bc = b.distanceTo(c)
      const ca = c.distanceTo(a)
      const longest = Math.max(ab, bc, ca)
      if (longest <= MAX_TRIANGLE_EDGE || depth > 24) {
        pushVertex(a.x, a.y)
        pushVertex(b.x, b.y)
        pushVertex(c.x, c.y)
        return
      }
      if (longest === ab) {
        const m = a.clone().add(b).multiplyScalar(0.5)
        subdivide(a, m, c, depth + 1)
        subdivide(m, b, c, depth + 1)
      } else if (longest === bc) {
        const m = b.clone().add(c).multiplyScalar(0.5)
        subdivide(a, b, m, depth + 1)
        subdivide(a, m, c, depth + 1)
      } else {
        const m = c.clone().add(a).multiplyScalar(0.5)
        subdivide(a, b, m, depth + 1)
        subdivide(m, b, c, depth + 1)
      }
    }

    // 区画の線(plotOverlay.ts)と同じく、格子に沿った輪郭をならしてから使う
    const loops = traceRegion(result.labels, n, plot).map((raw) =>
      smoothLoop(
        raw.map((v) => origin + v * cell),
        1,
        OUTLINE_SMOOTHING
      )
    )
    // 外周(面積が正)と穴(面積が負)に分け、穴は自分を囲む外周に入れる
    const outers = loops.filter((loop) => loopArea(loop) > 0)
    const holes = loops.filter((loop) => loopArea(loop) < 0)
    for (const outer of outers) {
      const inner = holes.filter((hole) => insideLoop(hole[0], hole[1], outer))
      const contour = toVectors(outer)
      const holeVectors = inner.map(toVectors)
      const all = contour.concat(...holeVectors)
      for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holeVectors)) {
        subdivide(all[a], all[b], all[c], 0)
      }
    }

    const outline = emptySegments()
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i += 2) {
        const j = (i + 2) % loop.length
        outline.starts.push(loop[i], terrain.heightAt(loop[i], loop[i + 1]) + LINE_LIFT, loop[i + 1])
        outline.ends.push(loop[j], terrain.heightAt(loop[j], loop[j + 1]) + LINE_LIFT, loop[j + 1])
        outline.progress.push(0, 0)
        outline.colors.push(1, 1, 1)
      }
    }

    const shape: PlotShape = {
      positions: new Float32Array(positions),
      edges: new Float32Array(edges),
      widths: new Float32Array(edges.length).fill(width),
      outline
    }
    this.shapes.set(plot, shape)
    return shape
  }
}
