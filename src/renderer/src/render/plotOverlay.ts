// 区画の表示。区画の輪郭を、画面の上で一定の太さの線で描く。
// 今刈る区画は太く明るい線、刈り終えた区画は別の色、残りは細く薄い線にする。

import { Color, Group } from 'three'
import { smoothLoop } from '../sim/coveragePlan'
import type { PlotResult } from '../sim/plots'
import type { Terrain } from '../sim/terrain'
import { traceRegion } from '../sim/zoning'
import { OVERLAY_PALETTE, Ribbon, emptySegments } from './overlay/ribbon'

/** 線を地面から浮かせる高さ(m)。区分けの縁取りより少し上にする */
const LINE_LIFT = 0.36
/** 輪郭線をならす回数。区分けの縁取り(zoneOverlay.ts)と揃える */
const OUTLINE_SMOOTHING = 6
// 現れる時間と消える時間(秒)。経路の表示(pathLine.ts)と揃える
const FADE_IN_SECONDS = 0.6
const FADE_OUT_SECONDS = 0.45

const COLOR_CURRENT = new Color(OVERLAY_PALETTE.snow)
const COLOR_DONE = new Color(OVERLAY_PALETTE.sky)
const COLOR_OTHER = new Color(OVERLAY_PALETTE.leaf)

export class PlotOverlay {
  /** シーンに追加するまとまり */
  readonly lines = new Group()
  private readonly others = new Ribbon({ width: 2, opacity: 0.6 })
  private readonly current = new Ribbon({ width: 4 })
  // 区画ごとの輪郭(ワールド座標。x と z を交互に並べた 1 周の集まり)
  private loops: number[][][] = []
  private shown = false
  private opacity = 0

  constructor(private readonly terrain: Terrain) {
    this.others.mesh.renderOrder = 2
    this.current.mesh.renderOrder = 3
    this.lines.add(this.others.mesh, this.current.mesh)
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
    const eased = this.opacity * this.opacity * (3 - 2 * this.opacity)
    this.others.fade = eased
    this.current.fade = eased
    this.lines.visible = this.opacity > 0
  }

  /** 区画分けの結果から輪郭を作る。このあと setState を呼ぶ */
  update(result: PlotResult): void {
    const { cell } = this.terrain.options
    const origin = this.terrain.origin
    // 格子に沿った輪郭は斜めの所が階段状になるので、ならしてから使う
    this.loops = result.plots.map((plot) =>
      traceRegion(result.labels, result.samples, plot.id).map((raw) =>
        smoothLoop(
          raw.map((v) => origin + v * cell),
          1,
          OUTLINE_SMOOTHING
        )
      )
    )
  }

  /** 今刈る区画と、刈り終えた区画を伝えて、線を描き直す */
  setState(currentPlot: number, done: ReadonlySet<number>): void {
    const terrain = this.terrain
    const others = emptySegments()
    const current = emptySegments()
    this.loops.forEach((loops, id) => {
      const segments = id === currentPlot ? current : others
      const color = id === currentPlot ? COLOR_CURRENT : done.has(id) ? COLOR_DONE : COLOR_OTHER
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length
          segments.starts.push(loop[i], terrain.heightAt(loop[i], loop[i + 1]) + LINE_LIFT, loop[i + 1])
          segments.ends.push(loop[j], terrain.heightAt(loop[j], loop[j + 1]) + LINE_LIFT, loop[j + 1])
          segments.progress.push(0, 0)
          segments.colors.push(color.r, color.g, color.b)
        }
      }
    })
    this.others.setSegments(others)
    this.current.setSegments(current)
  }
}
