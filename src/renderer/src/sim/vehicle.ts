// 芝刈り機の運動学モデル(自転車モデル)。描画に依存しない。
// 座標系: Y が上。heading = 0 で +Z を向き、正の回転で +X 側(進行方向の左)へ曲がる。
// 基準点は後輪軸の中央。単位は m、秒、ラジアン。
// 機種ごとの寸法(車輪やリールの位置と幅など)は mowers/*.json に書き、ここで読み込む。
// 同じ JSON を Blender のモデル作成スクリプトも読むので、見た目と計算の寸法がずれない。

import fairwaySpec from './mowers/fairway.json'

/** 車輪 1 本。位置は後輪軸の中央から測る */
export interface WheelSpec {
  /** 左右の位置(m)。左が正 */
  side: number
  /** 前後の位置(m)。前が正 */
  ahead: number
  /** 幅(m) */
  width: number
  /** 半径(m) */
  radius: number
  /** 操舵で向きが変わるか */
  steered: boolean
}

/** リール(刈刃)1 連。位置は後輪軸の中央から測る */
export interface ReelSpec {
  side: number
  ahead: number
  /** 刈る幅(m) */
  width: number
}

/** 機種の定義(mowers/*.json の形)。角度は度、速度は km/h で書く */
export interface MowerSpec {
  name: string
  /** モデルのファイル名(src/renderer/src/assets/models/ の中) */
  model: string
  wheelbase: number
  maxSteerDeg: number
  maxSpeedKmh: number
  maxReverseSpeedKmh: number
  accel: number
  brake: number
  steerRateDeg: number
  deckOffset: number
  wheels: WheelSpec[]
  reels: ReelSpec[]
}

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
  /** 刈り幅(リール全体の左端から右端まで) */
  cutWidth: number
  /** 後輪軸から刈刃までの前方距離(経路計画で使う代表値) */
  deckOffset: number
  /** 左右の車輪の間隔(最も外側の車輪どうし) */
  track: number
  wheels: WheelSpec[]
  reels: ReelSpec[]
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

/** 機種の定義から、計算で使う値を作る */
export function mowerFromSpec(spec: MowerSpec): VehicleParams {
  const left = Math.max(...spec.reels.map((r) => r.side + r.width / 2))
  const right = Math.min(...spec.reels.map((r) => r.side - r.width / 2))
  const sides = spec.wheels.map((w) => w.side)
  return {
    wheelbase: spec.wheelbase,
    maxSteer: (spec.maxSteerDeg * Math.PI) / 180,
    maxSpeed: spec.maxSpeedKmh / 3.6,
    maxReverseSpeed: spec.maxReverseSpeedKmh / 3.6,
    accel: spec.accel,
    brake: spec.brake,
    steerRate: (spec.steerRateDeg * Math.PI) / 180,
    cutWidth: left - right,
    deckOffset: spec.deckOffset,
    track: Math.max(...sides) - Math.min(...sides),
    wheels: spec.wheels,
    reels: spec.reels
  }
}

/** 乗用フェアウェイモア(3 連リール) */
export const FAIRWAY_MOWER: VehicleParams = mowerFromSpec(fairwaySpec)

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

/**
 * 各車輪の接地点の位置。out に (x, z) を params.wheels の順で書き込む
 */
export function wheelPositions(state: VehicleState, params: VehicleParams, out: Float64Array): void {
  const fx = Math.sin(state.heading)
  const fz = Math.cos(state.heading)
  // 進行方向の左は (fz, -fx)
  for (let i = 0; i < params.wheels.length; i++) {
    const wheel = params.wheels[i]
    out[i * 2] = state.x + fx * wheel.ahead + fz * wheel.side
    out[i * 2 + 1] = state.z + fz * wheel.ahead - fx * wheel.side
  }
}

/**
 * 各リールの左右端の位置。out に (左 x, 左 z, 右 x, 右 z) を params.reels の順で書き込む
 */
export function reelSegments(state: VehicleState, params: VehicleParams, out: Float64Array): void {
  const fx = Math.sin(state.heading)
  const fz = Math.cos(state.heading)
  for (let i = 0; i < params.reels.length; i++) {
    const reel = params.reels[i]
    const cx = state.x + fx * reel.ahead + fz * reel.side
    const cz = state.z + fz * reel.ahead - fx * reel.side
    const half = reel.width / 2
    out[i * 4] = cx + fz * half
    out[i * 4 + 1] = cz - fx * half
    out[i * 4 + 2] = cx - fz * half
    out[i * 4 + 3] = cz + fx * half
  }
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
