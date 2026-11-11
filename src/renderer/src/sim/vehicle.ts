// 芝刈り機の運動学モデル(自転車モデル)。描画に依存しない。
// 座標系: Y が上。heading = 0 で +Z を向き、正の回転で +X 側(進行方向の左)へ曲がる。
// 基準点は後輪軸の中央。単位は m、秒、ラジアン。

export interface VehicleParams {
  /** 前後輪の軸間距離 */
  wheelbase: number
  /** 最大操舵角 */
  maxSteer: number
  /** 前進の最高速度 */
  maxSpeed: number
  /** 後退の最高速度 */
  maxReverseSpeed: number
  /** 加速度 */
  accel: number
  /** 減速度 */
  brake: number
  /** 操舵角の変化速度 */
  steerRate: number
  /** 刈り幅 */
  cutWidth: number
  /** 後輪軸から刈刃までの前方距離 */
  deckOffset: number
}

export interface VehicleState {
  x: number
  z: number
  heading: number
  speed: number
  steer: number
  deckDown: boolean
}

export interface VehicleInput {
  /** -1(後退)〜 1(前進) */
  throttle: number
  /** -1(右)〜 1(左) */
  steer: number
}

export interface DeckSegment {
  lx: number
  lz: number
  rx: number
  rz: number
}

/** 乗用フェアウェイモアを想定した初期値 */
export const FAIRWAY_MOWER: VehicleParams = {
  wheelbase: 1.5,
  maxSteer: (35 * Math.PI) / 180,
  maxSpeed: 12 / 3.6,
  maxReverseSpeed: 5 / 3.6,
  accel: 1.5,
  brake: 3.0,
  steerRate: (70 * Math.PI) / 180,
  cutWidth: 3.0,
  deckOffset: 2.3
}

export function createVehicleState(x = 0, z = 0, heading = 0): VehicleState {
  return { x, z, heading, speed: 0, steer: 0, deckDown: true }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target)
  return Math.max(current - maxDelta, target)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export function minTurnRadius(params: VehicleParams): number {
  return params.wheelbase / Math.tan(params.maxSteer)
}

/**
 * 状態を dt 秒だけ進める(state を書き換える)。
 * grade は進行方向の地面の傾き(高さ / 水平距離)。速度は地面に沿った速さなので、
 * 斜面では水平方向に進む距離がその分だけ短くなる。
 */
export function stepVehicle(
  state: VehicleState,
  input: VehicleInput,
  params: VehicleParams,
  dt: number,
  grade = 0
): void {
  const throttle = clamp(input.throttle, -1, 1)
  const targetSpeed = throttle >= 0 ? throttle * params.maxSpeed : throttle * params.maxReverseSpeed
  // 目標速度の絶対値が今より小さい、または逆向きなら減速として扱う
  const slowing = Math.abs(targetSpeed) < Math.abs(state.speed) || targetSpeed * state.speed < 0
  state.speed = approach(state.speed, targetSpeed, (slowing ? params.brake : params.accel) * dt)

  const targetSteer = clamp(input.steer, -1, 1) * params.maxSteer
  state.steer = approach(state.steer, targetSteer, params.steerRate * dt)

  const travel = (state.speed * dt) / Math.sqrt(1 + grade * grade)
  state.x += Math.sin(state.heading) * travel
  state.z += Math.cos(state.heading) * travel
  state.heading += (travel / params.wheelbase) * Math.tan(state.steer)
}

/** 刈刃の左右端の位置 */
export function deckSegment(state: VehicleState, params: VehicleParams): DeckSegment {
  const fx = Math.sin(state.heading)
  const fz = Math.cos(state.heading)
  // 進行方向の左
  const lx = fz
  const lz = -fx
  const cx = state.x + fx * params.deckOffset
  const cz = state.z + fz * params.deckOffset
  const half = params.cutWidth / 2
  return {
    lx: cx + lx * half,
    lz: cz + lz * half,
    rx: cx - lx * half,
    rz: cz - lz * half
  }
}
