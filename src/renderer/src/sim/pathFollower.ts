// 経路への追従(Pure Pursuit)。経路の少し先の点を目標にして、そこへ向かう円弧の操舵角を出す。
// 経路の作り方(coveragePlan.ts)とは切り離してあり、どんな折れ線でも追える。

import type { VehicleInput, VehicleParams, VehicleState } from './vehicle'

export interface DrivePath {
  /** 経路の点(後輪軸の中央が通る位置)。x と z を交互に並べる */
  points: Float32Array
  /** 区間ごとに、刈刃を下げて走るなら 1。区間 i は点 i から点 i + 1 まで */
  cut: Uint8Array
}

export interface FollowerOutput extends VehicleInput {
  deckDown: boolean
  finished: boolean
}

export interface FollowerOptions {
  /** 目標点までの距離(m) */
  lookahead: number
  /** 刈刃を上げて移動するときの速度(最高速度に対する割合) */
  transitThrottle: number
  /** 最寄りの点を探す範囲(今の位置から先の区間数) */
  searchWindow: number
}

export const DEFAULT_FOLLOWER: FollowerOptions = {
  lookahead: 2.2,
  transitThrottle: 0.6,
  searchWindow: 40
}

/** 最寄りの点を探す範囲(今の位置から先の道のり、m) */
const SEARCH_DISTANCE = 6

function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  if (r < -Math.PI) r += Math.PI * 2
  return r
}

export class PathFollower {
  /** 今いる区間 */
  segment = 0
  /** 経路の始点からの道のり(m) */
  travelled = 0
  readonly totalLength: number
  private readonly cumulative: Float32Array
  private readonly count: number

  constructor(
    readonly path: DrivePath,
    private readonly params: VehicleParams,
    private readonly options: FollowerOptions = DEFAULT_FOLLOWER
  ) {
    const p = path.points
    this.count = p.length / 2
    this.cumulative = new Float32Array(this.count)
    for (let i = 1; i < this.count; i++) {
      this.cumulative[i] =
        this.cumulative[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1])
    }
    this.totalLength = this.count > 0 ? this.cumulative[this.count - 1] : 0
  }

  /** 進み具合(0〜1) */
  get progress(): number {
    return this.totalLength > 0 ? Math.min(this.travelled / this.totalLength, 1) : 1
  }

  update(state: VehicleState): FollowerOutput {
    const p = this.path.points
    const last = this.count - 2
    if (last < 0) return { throttle: 0, steer: 0, deckDown: false, finished: true }

    // 最寄りの位置を、今の区間から先だけで探す(経路が交差していても後戻りしないように)
    let bestSegment = this.segment
    let bestT = 0
    let bestDist = Infinity
    const end = Math.min(last, this.segment + this.options.searchWindow)
    for (let i = this.segment; i <= end; i++) {
      // 道のりで離れすぎた区間は見ない(近くを通る別の列に飛び移らないように)
      if (i > this.segment && this.cumulative[i] - this.travelled > SEARCH_DISTANCE) break
      const ax = p[i * 2]
      const az = p[i * 2 + 1]
      const dx = p[i * 2 + 2] - ax
      const dz = p[i * 2 + 3] - az
      const len2 = dx * dx + dz * dz
      let t = len2 > 0 ? ((state.x - ax) * dx + (state.z - az) * dz) / len2 : 0
      t = Math.min(Math.max(t, 0), 1)
      const dist = (state.x - ax - dx * t) ** 2 + (state.z - az - dz * t) ** 2
      if (dist < bestDist - 1e-9) {
        bestDist = dist
        bestSegment = i
        bestT = t
      }
    }
    this.segment = bestSegment
    const here = this.cumulative[bestSegment]
    this.travelled = here + (this.cumulative[bestSegment + 1] - here) * bestT

    if (this.totalLength - this.travelled < 0.15) {
      return { throttle: 0, steer: 0, deckDown: false, finished: true }
    }

    // 経路に沿って lookahead だけ先の点を目標にする
    const targetS = this.travelled + this.options.lookahead
    let i = bestSegment
    while (i < last && this.cumulative[i + 1] < targetS) i++
    const segLength = this.cumulative[i + 1] - this.cumulative[i]
    // 終点より先は、最後の区間をそのまま延ばした先を目標にする
    const t = segLength > 0 ? (targetS - this.cumulative[i]) / segLength : 1
    const tx = p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t
    const tz = p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t

    const dist = Math.hypot(tx - state.x, tz - state.z)
    const alpha = wrapAngle(Math.atan2(tx - state.x, tz - state.z) - state.heading)
    const steerAngle = Math.atan2(2 * this.params.wheelbase * Math.sin(alpha), Math.max(dist, 0.5))
    const steer = Math.min(Math.max(steerAngle / this.params.maxSteer, -1), 1)

    const cutting = this.path.cut[bestSegment] === 1
    // 大きく切っているときと、終点の手前では速度を落とす
    let throttle = cutting ? 1 : this.options.transitThrottle
    throttle *= 1 - 0.45 * Math.abs(steer)
    const remaining = this.totalLength - this.travelled
    if (remaining < 4) throttle = Math.min(throttle, 0.2 + 0.2 * remaining)

    return { throttle, steer, deckDown: cutting, finished: false }
  }
}
