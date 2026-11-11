// 区分けの表示。weather-globe の「範囲」の描き方に合わせている。
//   塗り: 範囲の輪郭を多角形として三角形に分け、地形に沿わせた面で描く。
//         輪郭のすぐ内側が濃く、内側へ行くほど薄くなる(輪郭から内へ広がる光)
//   縁取り: 画面の上で一定の太さを持つ、光る線。塗りと同じ輪郭を使うので、ぴったり重なる
// 乗用機で刈れて出発点から届く所は、何も重ねずに芝をそのまま見せる。

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
import type { Terrain } from '../sim/terrain'
import { ZONE_NONE, ZONE_SLOPE, loopArea, traceRegion, type ZoningResult } from '../sim/zoning'
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

/** 塗りを地面から浮かせる高さ(m)。伸びた芝の葉より上にする */
const FILL_LIFT = 0.3
/** 縁取りを地面から浮かせる高さ(m) */
const LINE_LIFT = 0.32
/** 縁取りの太さ(画素) */
const OUTLINE_WIDTH = 3.5
/** 輪郭線をならす回数。多いほどなめらかで、細かな出入りが消える */
const OUTLINE_SMOOTHING = 6
// 現れる時間と消える時間(秒)。経路の表示(pathLine.ts)と揃える
const FADE_IN_SECONDS = 0.6
const FADE_OUT_SECONDS = 0.45
/** 塗りの三角形の辺の長さの上限(m)。地形に沿わせ、グラデーションをなめらかにする細かさ */
const MAX_TRIANGLE_EDGE = 4
/** 塗りの頂点の値の数の上限。これを超えたら、それ以上は細かく分けない(固まらないための歯止め) */
const MAX_FILL_VALUES = 3_000_000

const FILL_VS = /* glsl */ `
attribute float aEdge;  // 輪郭までの距離(m)
attribute float aWidth; // グラデーションの幅(m)
attribute vec3 aColor;
varying float vEdge;
varying float vWidth;
varying vec3 vColor;
void main() {
  vEdge = aEdge;
  vWidth = aWidth;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FILL_FS = /* glsl */ `
uniform float uFade; // 全体の濃さ(0〜1)。現れるときと消えるときに変える
varying float vEdge;
varying float vWidth;
varying vec3 vColor;
void main() {
  float glow = clamp(exp(-max(vEdge, 0.0) / max(vWidth, 1.0)), 0.0, 1.0);
  float alpha = ${FILL_OPACITY.toFixed(2)} * (${FILL_FLOOR.toFixed(2)} + ${(1 - FILL_FLOOR).toFixed(2)} * glow);
  gl_FragColor = vec4(vColor * (1.0 + glow * 0.25), alpha * uFade);
}
`

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

export class ZoneOverlay {
  /** シーンに追加するまとまり(塗りと縁取り) */
  readonly lines = new Group()
  private readonly fill: Mesh
  private readonly outline = new Ribbon({ width: OUTLINE_WIDTH })
  private readonly fade = { value: 0 }
  private shown = false
  private opacity = 0

  constructor(private readonly terrain: Terrain) {
    const material = new ShaderMaterial({
      uniforms: { uFade: this.fade },
      vertexShader: FILL_VS,
      fragmentShader: FILL_FS,
      side: DoubleSide,
      transparent: true,
      depthWrite: false
    })
    this.fill = new Mesh(new BufferGeometry(), material)
    this.fill.frustumCulled = false
    this.fill.renderOrder = 1
    this.outline.mesh.renderOrder = 2
    this.lines.add(this.fill, this.outline.mesh)
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
    this.fade.value = eased
    this.outline.fade = eased
    this.lines.visible = this.opacity > 0
  }

  /** 区分けの結果を表示に反映する */
  update(result: ZoningResult, blocked?: Uint8Array): void {
    const { zones, labels, regions, samples: n } = result
    const { cell } = this.terrain.options
    const origin = this.terrain.origin
    const terrain = this.terrain

    const positions: number[] = []
    const edges: number[] = []
    const widths: number[] = []
    const colors: number[] = []
    const segments = emptySegments()
    const mask = new Uint8Array(zones.length)
    const kindLabels = new Int32Array(zones.length)
    const color = new Color()

    for (let kind = 1; kind < KIND_COLORS.length; kind++) {
      let any = false
      for (let i = 0; i < zones.length; i++) {
        const zone = zones[i]
        // 樹木で入れない所は塗らない(木が立っているので、見れば分かる)
        const k =
          blocked && blocked[i] === 1
            ? 0
            : zone === ZONE_NONE
            ? KIND_NONE
            : zone === ZONE_SLOPE
              ? KIND_SLOPE
              : regions[labels[i]].reachable
                ? 0
                : KIND_UNREACHABLE
        mask[i] = k === kind ? 1 : 0
        kindLabels[i] = mask[i]
        if (mask[i] === 1) any = true
      }
      if (!any) continue
      color.set(KIND_COLORS[kind])

      // 輪郭までの距離(格子から求める)。塗りの濃さと、グラデーションの幅を決めるのに使う
      const distance = distanceToOutside(mask, n)
      let deepest = 0
      for (let i = 0; i < distance.length; i++) deepest = Math.max(deepest, distance[i])
      const width = Math.min(Math.max(deepest * cell * GRADIENT_SHARE, GRADIENT_MIN), GRADIENT_MAX)
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
      const pushVertex = (x: number, z: number): void => {
        positions.push(x, terrain.heightAt(x, z) + FILL_LIFT, z)
        edges.push(edgeAt(x, z))
        widths.push(width)
        colors.push(color.r, color.g, color.b)
      }
      // 三角形を、地形に沿う細かさになるまで分けていく。いちばん長い辺の中点で 2 つに分ける。
      // (4 つに分ける方法だと、多角形を三角形に分けたときにできる細長い三角形で、数が爆発的に増える)
      const subdivide = (a: Vector2, b: Vector2, c: Vector2, depth: number): void => {
        const ab = a.distanceTo(b)
        const bc = b.distanceTo(c)
        const ca = c.distanceTo(a)
        const longest = Math.max(ab, bc, ca)
        if (longest <= MAX_TRIANGLE_EDGE || depth > 24 || positions.length > MAX_FILL_VALUES) {
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

      // 格子に沿った輪郭は斜めの所が階段状になるので、ならしてから使う
      const loops = traceRegion(kindLabels, n, 1).map((raw) =>
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

      // 縁取り: 塗りと同じ輪郭を、その色の光る線で描く
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length
          segments.starts.push(loop[i], terrain.heightAt(loop[i], loop[i + 1]) + LINE_LIFT, loop[i + 1])
          segments.ends.push(loop[j], terrain.heightAt(loop[j], loop[j + 1]) + LINE_LIFT, loop[j + 1])
          segments.progress.push(0, 0)
          segments.colors.push(color.r, color.g, color.b)
        }
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1))
    geometry.setAttribute('aWidth', new Float32BufferAttribute(widths, 1))
    geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
    this.fill.geometry.dispose()
    this.fill.geometry = geometry
    this.outline.setSegments(segments)
  }
}
