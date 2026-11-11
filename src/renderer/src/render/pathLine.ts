// 経路の表示。刈る区間は明るい線、刈刃を上げて移動する区間は暗い線で、地形に沿わせて描く。

import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three'
import type { DrivePath } from '../sim/pathFollower'
import type { Terrain } from '../sim/terrain'

/** 線を地面から浮かせる高さ(m) */
const LINE_LIFT = 0.25
/** 線を地形に沿わせるために刻む長さ(m) */
const LINE_STEP = 2
const CUT_SHADE = 1
const TRANSIT_SHADE = 0.3

export class PathLine {
  readonly lines: LineSegments

  constructor(private readonly terrain: Terrain) {
    const material = new LineBasicMaterial({ vertexColors: true, fog: false, toneMapped: false })
    this.lines = new LineSegments(new BufferGeometry(), material)
    this.lines.frustumCulled = false
    this.lines.visible = false
  }

  set visible(on: boolean) {
    this.lines.visible = on
  }

  update(path: DrivePath | null): void {
    const positions: number[] = []
    const colors: number[] = []
    if (path) {
      const p = path.points
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i]
        const az = p[i + 1]
        const bx = p[i + 2]
        const bz = p[i + 3]
        const shade = path.cut[i / 2] === 1 ? CUT_SHADE : TRANSIT_SHADE
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / LINE_STEP))
        let px = ax
        let pz = az
        for (let s = 1; s <= steps; s++) {
          const t = s / steps
          const qx = ax + (bx - ax) * t
          const qz = az + (bz - az) * t
          positions.push(px, this.terrain.heightAt(px, pz) + LINE_LIFT, pz)
          positions.push(qx, this.terrain.heightAt(qx, qz) + LINE_LIFT, qz)
          colors.push(shade, shade, shade, shade, shade, shade)
          px = qx
          pz = qz
        }
      }
    }
    this.lines.geometry.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
    this.lines.geometry = geometry
  }
}
