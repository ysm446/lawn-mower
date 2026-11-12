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
  /** カーブで許す横方向の加速度(m/s²)。曲がり具合からその点の速度の上限を決める */
  lateralAccel: number
  /** 曲がり具合を測る幅(前後それぞれ、m)。点の並びの細かな揺れや角を均す */
  curveWindow: number
  /** カーブの手前で減速するときに使う減速度の割合(機種の brake に対して)。余裕を残す */
  curveBrake: number
}

export const DEFAULT_FOLLOWER: FollowerOptions = {
  lookahead: 2.2,
  transitThrottle: 0.6,
  searchWindow: 40,
  lateralAccel: 1.5,
  curveWindow: 1,
  curveBrake: 0.6
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
  /** 点ごとの速度の上限(m/s)。カーブの曲がり具合と、その手前で減速が間に合うことから決める */
  readonly speedLimit: Float32Array
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
    this.speedLimit = this.buildSpeedLimit()
  }

  /**
   * 点ごとの速度の上限を作る。
   * 1. 前後 curveWindow の点を結んだ 2 本の向きの差を、その間の道のりで割って曲がり具合(1 / 半径)にし、
   *    横方向の加速度が lateralAccel を超えない速さ √(a × 半径) を上限にする。
   *    半径は最小旋回半径より小さくはしない(それより急な角も、最小旋回半径で回る)。
   * 2. 終点の側から始点の側へたどり、v² ≤ v次² + 2 × 減速度 × 距離 で上限を手前へ伝える。
   *    これで、カーブに入る前に減速が間に合う。
   */
  private buildSpeedLimit(): Float32Array {
    const p = this.path.points
    const n = this.count
    const c = this.cumulative
    const { maxSpeed, wheelbase, maxSteer, brake } = this.params
    const { lateralAccel, curveWindow, curveBrake } = this.options
    const maxCurvature = Math.tan(maxSteer) / wheelbase
    const limit = new Float32Array(n).fill(maxSpeed)
    let back = 0
    let ahead = 0
    for (let i = 0; i < n; i++) {
      while (back < i && c[i] - c[back + 1] >= curveWindow) back++
      if (ahead < i) ahead = i
      while (ahead < n - 1 && c[ahead] - c[i] < curveWindow) ahead++
      const l1 = c[i] - c[back]
      const l2 = c[ahead] - c[i]
      if (l1 < 1e-3 || l2 < 1e-3) continue
      const h1 = Math.atan2(p[i * 2] - p[back * 2], p[i * 2 + 1] - p[back * 2 + 1])
      const h2 = Math.atan2(p[ahead * 2] - p[i * 2], p[ahead * 2 + 1] - p[i * 2 + 1])
      const curvature = Math.min(Math.abs(wrapAngle(h2 - h1)) / ((l1 + l2) / 2), maxCurvature)
      if (curvature > 1e-6) limit[i] = Math.min(maxSpeed, Math.sqrt(lateralAccel / curvature))
    }
    const decel = brake * curveBrake
    for (let i = n - 2; i >= 0; i--) {
      const reach = Math.sqrt(limit[i + 1] * limit[i + 1] + 2 * decel * (c[i + 1] - c[i]))
      if (reach < limit[i]) limit[i] = reach
    }
    return limit
  }

  /** 道のり s の所の速度の上限(m/s) */
  speedLimitAt(s: number): number {
    const c = this.cumulative
    const n = this.count
    if (n === 0) return 0
    if (s <= 0) return this.speedLimit[0]
    if (s >= this.totalLength) return this.speedLimit[n - 1]
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (c[mid] <= s) lo = mid
      else hi = mid
    }
    const len = c[hi] - c[lo]
    const t = len > 0 ? (s - c[lo]) / len : 0
    return this.speedLimit[lo] + (this.speedLimit[hi] - this.speedLimit[lo]) * t
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
    // カーブの手前から速度を落とす(上限の表は前もって作ってある)。
    // 目標点が先にあるので、機体はカーブの少し手前から曲がり始める。その分だけ先の上限を見る
    let throttle = cutting ? 1 : this.options.transitThrottle
    const curveLimit = this.speedLimitAt(this.travelled + this.options.lookahead * 0.5) / this.params.maxSpeed
    throttle = Math.min(throttle, curveLimit)
    // 経路から外れて大きく切っているとき(表には出ない)も、少し落とす
    throttle *= 1 - 0.25 * Math.abs(steer)
    // 終点の手前では速度を落とす
    const remaining = this.totalLength - this.travelled
    if (remaining < 4) throttle = Math.min(throttle, 0.2 + 0.2 * remaining)

    return { throttle, steer, deckDown: cutting, finished: false }
  }
}
