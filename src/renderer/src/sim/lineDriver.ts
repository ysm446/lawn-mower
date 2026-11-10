// 仮の自動運転。Z 軸に平行な直線を往復する。
// 刈り跡の試作(M1)を手放しで確認するためのもので、
// 本来の経路計画と追従制御(M4)ができたら置き換える。

import type { VehicleInput, VehicleParams, VehicleState } from './vehicle'

export interface LineDriverConfig {
  /** 最初の列の X 座標 */
  startX: number
  /** 列の間隔(刈り幅より少し狭くして重ねる) */
  spacing: number
  /** 列の本数 */
  lines: number
  /** 刈る範囲の Z の下限と上限 */
  zMin: number
  zMax: number
  /** 範囲の外で折り返すための余白 */
  headland: number
}

export interface LineDriverOutput extends VehicleInput {
  deckDown: boolean
  finished: boolean
}

function wrapAngle(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2)
  if (r < 0) r += Math.PI * 2
  return r - Math.PI
}

export class LineDriver {
  private line = 0

  constructor(
    private readonly config: LineDriverConfig,
    private readonly params: VehicleParams
  ) {}

  get currentLine(): number {
    return this.line
  }

  update(state: VehicleState): LineDriverOutput {
    const c = this.config
    if (this.line >= c.lines) {
      return { throttle: 0, steer: 0, deckDown: false, finished: true }
    }

    // 偶数列は +Z 向き、奇数列は -Z 向き
    let forward = this.line % 2 === 0
    const progress = forward ? state.z : -state.z
    const end = forward ? c.zMax : -c.zMin
    if (progress > end + c.headland) {
      this.line++
      if (this.line >= c.lines) {
        return { throttle: 0, steer: 0, deckDown: false, finished: true }
      }
      forward = !forward
    }

    const lineX = c.startX + this.line * c.spacing
    const lineHeading = forward ? 0 : Math.PI
    // 列から見て左にどれだけずれているか
    const crossTrack = forward ? state.x - lineX : -(state.x - lineX)
    const lookahead = 3.0
    const desired = lineHeading - Math.atan2(crossTrack, lookahead)
    const headingError = wrapAngle(desired - state.heading)

    const steer = Math.min(Math.max((headingError * 2.0) / this.params.maxSteer, -1), 1)
    const throttle = Math.abs(headingError) > 0.3 ? 0.6 : 1
    // 刈刃の位置が範囲内にある間だけ下ろす
    const deckZ = state.z + Math.cos(state.heading) * this.params.deckOffset
    const deckDown = deckZ >= c.zMin && deckZ <= c.zMax
    return { throttle, steer, deckDown, finished: false }
  }
}
