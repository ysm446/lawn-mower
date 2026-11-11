// 太陽の向きを示すギズモ。太陽を手で動かしている間、画面に重ねて出す。
// 絵は terrain-graph(D:\GitHub\terrain-graph の DrawLightGizmoOverlay)と揃えてある。
//   地面の輪: 方位の目安
//   輪の中心から太陽の方位へ引いた線
//   その線から太陽の高度ぶん立ち上がる弧
//   光が来る向きの矢印(太陽の側から中心へ向かう)
//   今の方位と高度の数字
// 線は SVG で画面の上に描く(場面の中の物ではないので、露出やぼけの影響を受けない)。
// 色はテーマの変数から引かない。意味を持つ色として固定する。

import { Vector3, type PerspectiveCamera } from 'three'

/** 動かすのをやめてから、薄くなって消えるまでの時間(秒) */
const FADE_SECONDS = 0.35
const RING_SEGMENTS = 72
const ARC_SEGMENTS = 32
const COLOR_GUIDE = 'rgb(150, 160, 175)'
const COLOR_ARC = 'rgb(255, 206, 112)'
const COLOR_LIGHT = 'rgb(255, 188, 76)'
const SVG_NS = 'http://www.w3.org/2000/svg'

export class SunGizmo {
  private readonly ring: SVGPathElement
  private readonly heading: SVGPathElement
  private readonly arc: SVGPathElement
  private readonly shaft: SVGPathElement
  private readonly head: SVGPolygonElement
  private readonly center: SVGCircleElement
  /** 動かしている間は true。この間は消えない */
  held = false
  /** 表示を保つ残りの時間(秒)。0 になると消える */
  private remaining = 0
  private readonly point = new Vector3()
  private readonly a = { x: 0, y: 0, visible: false }
  private readonly b = { x: 0, y: 0, visible: false }

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly label: HTMLElement
  ) {
    const add = <K extends 'path' | 'polygon' | 'circle'>(
      tag: K,
      attributes: Record<string, string>
    ): SVGElementTagNameMap[K] => {
      const element = document.createElementNS(SVG_NS, tag)
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
      svg.append(element)
      return element
    }
    const line = (color: string, width: number, opacity: number): SVGPathElement =>
      add('path', {
        fill: 'none',
        stroke: color,
        'stroke-width': `${width}`,
        'stroke-opacity': `${opacity}`,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      })
    this.ring = line(COLOR_GUIDE, 1.6, 0.51)
    this.heading = line(COLOR_GUIDE, 1.8, 0.67)
    this.arc = line(COLOR_ARC, 1.6, 0.59)
    this.shaft = line(COLOR_LIGHT, 3.5, 0.96)
    this.head = add('polygon', { fill: COLOR_LIGHT, 'fill-opacity': '0.96' })
    this.center = add('circle', {
      r: '5',
      fill: 'none',
      stroke: 'rgb(200, 210, 220)',
      'stroke-width': '1.6',
      'stroke-opacity': '0.78'
    })
    svg.style.opacity = '0'
    label.style.opacity = '0'
  }

  /** 太陽を動かしたときに呼ぶ。しばらく表示を保つ */
  touch(): void {
    this.remaining = FADE_SECONDS
  }

  /**
   * 毎フレーム呼ぶ。center はギズモの中心(ワールド座標)、radius は輪の半径(m)。
   * azimuthDeg は太陽の方位(+Z から +X へ測る)、elevationDeg は高度。
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    center: Vector3,
    radius: number,
    azimuthDeg: number,
    elevationDeg: number
  ): void {
    if (this.held) this.remaining = FADE_SECONDS
    else this.remaining = Math.max(0, this.remaining - dt)
    const fade = this.held ? 1 : this.remaining / FADE_SECONDS
    const opacity = `${fade}`
    if (this.svg.style.opacity !== opacity) {
      this.svg.style.opacity = opacity
      this.label.style.opacity = opacity
    }
    if (fade <= 0) return

    const width = this.svg.clientWidth
    const height = this.svg.clientHeight
    /** ワールド座標の点を画面の座標にする。カメラの後ろに回った点は描かない */
    const project = (x: number, y: number, z: number, out: { x: number; y: number; visible: boolean }): void => {
      this.point.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
      out.visible = this.point.z < -camera.near
      this.point.applyMatrix4(camera.projectionMatrix)
      out.x = (this.point.x * 0.5 + 0.5) * width
      out.y = (0.5 - this.point.y * 0.5) * height
    }
    /** 点の並びを、見えている区間だけつないだ線にする */
    const trace = (count: number, at: (i: number, out: Vector3) => void): string => {
      const world = new Vector3()
      let path = ''
      let drawing = false
      for (let i = 0; i <= count; i++) {
        at(i, world)
        project(world.x, world.y, world.z, this.a)
        if (!this.a.visible) {
          drawing = false
          continue
        }
        path += `${drawing ? 'L' : 'M'}${this.a.x.toFixed(1)} ${this.a.y.toFixed(1)}`
        drawing = true
      }
      return path
    }

    const azimuth = (azimuthDeg * Math.PI) / 180
    const elevation = (elevationDeg * Math.PI) / 180
    const hx = Math.sin(azimuth)
    const hz = Math.cos(azimuth)

    // 地面の輪
    this.ring.setAttribute(
      'd',
      trace(RING_SEGMENTS, (i, out) => {
        const t = (i / RING_SEGMENTS) * Math.PI * 2
        out.set(center.x + Math.sin(t) * radius, center.y, center.z + Math.cos(t) * radius)
      })
    )
    // 太陽の方位への線と、そこから高度ぶん立ち上がる弧
    this.heading.setAttribute(
      'd',
      trace(1, (i, out) => out.set(center.x + hx * radius * i, center.y, center.z + hz * radius * i))
    )
    this.arc.setAttribute(
      'd',
      trace(ARC_SEGMENTS, (i, out) => {
        const angle = elevation * (i / ARC_SEGMENTS)
        const flat = Math.cos(angle) * radius
        out.set(center.x + hx * flat, center.y + Math.sin(angle) * radius, center.z + hz * flat)
      })
    )

    // 光が来る向きの矢印。太陽の側の輪の上から、中心の手前まで
    const dx = hx * Math.cos(elevation)
    const dy = Math.sin(elevation)
    const dz = hz * Math.cos(elevation)
    project(center.x + dx * radius, center.y + dy * radius, center.z + dz * radius, this.a)
    project(center.x + dx * radius * 0.22, center.y + dy * radius * 0.22, center.z + dz * radius * 0.22, this.b)
    const length = Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y)
    if (this.a.visible && this.b.visible && length > 0.001) {
      const ux = (this.b.x - this.a.x) / length
      const uy = (this.b.y - this.a.y) / length
      // 矢じりの長さと、幅の半分(画素)
      const baseX = this.b.x - ux * 14
      const baseY = this.b.y - uy * 14
      this.shaft.setAttribute('d', `M${this.a.x.toFixed(1)} ${this.a.y.toFixed(1)}L${baseX.toFixed(1)} ${baseY.toFixed(1)}`)
      this.head.setAttribute(
        'points',
        `${this.b.x.toFixed(1)},${this.b.y.toFixed(1)} ${(baseX - uy * 6).toFixed(1)},${(baseY + ux * 6).toFixed(1)} ${(baseX + uy * 6).toFixed(1)},${(baseY - ux * 6).toFixed(1)}`
      )
    } else {
      this.shaft.setAttribute('d', '')
      this.head.setAttribute('points', '')
    }

    project(center.x, center.y, center.z, this.a)
    this.center.setAttribute('visibility', this.a.visible ? 'visible' : 'hidden')
    this.center.setAttribute('cx', this.a.x.toFixed(1))
    this.center.setAttribute('cy', this.a.y.toFixed(1))

    // 今の値。動かしながら数字を確かめられるようにする
    const text = `方位 ${azimuthDeg.toFixed(0)}°   高度 ${elevationDeg.toFixed(0)}°`
    if (this.label.textContent !== text) this.label.textContent = text
  }
}
