// 芝刈り機 1 台分。機体の状態、刈り跡と車輪の跡の描き込み、自動運転の経路、モデルをまとめる。
// 複数台を同時に動かすため、main.ts はこれを台数分並べて扱う。
// 芝状態マップと被覆の格子は全台で共有する(どの機体が刈っても、同じ地面に跡が残る)。

import type { CoveragePlan } from './sim/coveragePlan'
import type { CoverageGrid } from './sim/coverage'
import type { PathFollower } from './sim/pathFollower'
import type { Terrain } from './sim/terrain'
import {
  createVehicleState,
  deckSegment,
  reelSegments,
  stepVehicle,
  wheelPositions,
  type VehicleInput,
  type VehicleParams,
  type VehicleState
} from './sim/vehicle'
import type { MowMap } from './render/mowMap'
import { MowerModel } from './render/mowerModel'

/** 刈った芝を倒す強さ(長さ 1 で完全に寝る) */
const CUT_LEAN = 0.8
/** 刈刃が上がりきる、下がりきるまでの時間(秒) */
const DECK_MOVE_TIME = 0.5
/** 刈刃を上げきったときに、刈高に足される高さ(m) */
const DECK_LIFT_HEIGHT = 0.1
/** 刈刃がこれより上がっていたら刈らない(0 が下げきり、1 が上げきり) */
const DECK_CUT_LIMIT = 0.8
/** 車輪の跡を描き込む間隔(m) */
const TRACK_STEP = 0.12

export interface RouteState {
  /** 経路を作り直す必要があるか */
  dirty: boolean
  plan: CoveragePlan | null
  follower: PathFollower | null
  /** 経路のパネルに出す値 */
  text: { plot: string; area: string; lines: string; cut: string; transit: string; time: string }
}

/** 1 刻み進めるのに要る、全台で共有するもの */
export interface StepContext {
  terrain: Terrain
  mowMap: MowMap
  coverage: CoverageGrid
  /** 刈高(m) */
  cutHeight: number
  /** 芝丈が「刈っていない」とみなされる上限(車輪の跡は芝丈を変えないので、これを渡す) */
  maxGrassHeight: number
  dt: number
  /** まだ刈っていない所を刈ったとき。newCells は新しく刈った被覆の格子の数 */
  onCut: (unit: MowerUnit, newCells: number, deck: { lx: number; lz: number; rx: number; rz: number }) => void
}

export class MowerUnit {
  state: VehicleState
  autoDrive = false
  /** 走った距離(m) */
  distance = 0
  /** 自動運転で受け持つ区画の番号。-1 は未定 */
  plot = -1
  readonly route: RouteState = {
    dirty: true,
    plan: null,
    follower: null,
    text: { plot: '-', area: '-', lines: '-', cut: '-', transit: '-', time: '-' }
  }
  readonly model: MowerModel
  /** カメラが追う位置。タイムラプスでは、コマごとに飛ぶ機体をなめらかに追わせる */
  readonly cameraTarget: VehicleState
  private deckLift = 0
  private readonly unitsNow: Float64Array
  private readonly unitsPrev: Float64Array
  private unitsStarted = false
  private readonly wheelsNow: Float64Array
  private readonly wheelsPrev: Float64Array
  private tracksStarted = false

  constructor(
    /** 0 から始まる番号 */
    readonly index: number,
    readonly params: VehicleParams,
    x: number,
    z: number,
    heading: number
  ) {
    this.state = createVehicleState(x, z, heading)
    this.cameraTarget = { ...this.state }
    this.model = new MowerModel(params)
    this.model.root.userData.mowerIndex = index
    this.unitsNow = new Float64Array(params.reels.length * 4)
    this.unitsPrev = new Float64Array(params.reels.length * 4)
    this.wheelsNow = new Float64Array(params.wheels.length * 2)
    this.wheelsPrev = new Float64Array(params.wheels.length * 2)
  }

  /** 画面に出す名前(1 号機、2 号機、…) */
  get name(): string {
    return `${this.index + 1} 号機`
  }

  /** 出発点に戻す。自動運転は止め、経路と受け持つ区画も忘れる */
  reset(x: number, z: number, heading: number): void {
    this.state = createVehicleState(x, z, heading)
    Object.assign(this.cameraTarget, this.state)
    this.autoDrive = false
    this.distance = 0
    this.plot = -1
    this.route.dirty = true
    this.route.plan = null
    this.route.follower = null
    this.deckLift = 0
    this.unitsStarted = false
    this.tracksStarted = false
  }

  /** シミュレーションを 1 刻み進める。manual は手で運転するときの入力(自動運転中は使わない) */
  step(manual: VehicleInput, ctx: StepContext, onFinished: () => void): void {
    const state = this.state
    const params = this.params
    let vehicleInput = manual
    if (this.autoDrive && this.route.follower) {
      const out = this.route.follower.update(state)
      vehicleInput = out
      state.deckDown = out.deckDown
      if (out.finished) onFinished()
    }

    const grade = ctx.terrain.gradeAlong(state.x, state.z, state.heading, params.wheelbase)
    stepVehicle(state, vehicleInput, params, ctx.dt, grade)
    this.distance += Math.abs(state.speed) * ctx.dt

    // 刈刃は一瞬では上下しない。下りきるまでの間は、高めに刈る(刈り始めと刈り終わりがなだらかになる)
    const liftTarget = state.deckDown ? 0 : 1
    const liftStep = ctx.dt / DECK_MOVE_TIME
    this.deckLift += Math.min(Math.max(liftTarget - this.deckLift, -liftStep), liftStep)
    const cutting = this.deckLift < DECK_CUT_LIMIT && Math.abs(state.speed) > 0.01

    // リールは 1 連ずつ別々の帯として描き込む(位置と幅は機種の定義による)
    const hx = Math.sin(state.heading)
    const hz = Math.cos(state.heading)
    const unitsNow = this.unitsNow
    const unitsPrev = this.unitsPrev
    reelSegments(state, params, unitsNow)
    const deck = deckSegment(state, params)
    if (cutting && this.unitsStarted) {
      const sign = state.speed >= 0 ? 1 : -1
      const height = ctx.cutHeight + this.deckLift * DECK_LIFT_HEIGHT
      for (let k = 0; k < unitsNow.length; k += 4) {
        ctx.mowMap.addQuad(
          unitsPrev[k],
          unitsPrev[k + 1],
          unitsPrev[k + 2],
          unitsPrev[k + 3],
          unitsNow[k + 2],
          unitsNow[k + 3],
          unitsNow[k],
          unitsNow[k + 1],
          hx * sign * CUT_LEAN,
          hz * sign * CUT_LEAN,
          height
        )
      }
      // まだ刈っていない所を通った分だけ、刈りカスが出る
      if (this.deckLift < 0.4) {
        const newCells = ctx.coverage.markSegment(deck.lx, deck.lz, deck.rx, deck.rz)
        if (newCells > 0) ctx.onCut(this, newCells, deck)
      }
    }
    unitsPrev.set(unitsNow)
    this.unitsStarted = cutting

    // 車輪の跡: 芝丈は変えずに、踏んだ所の芝を進行方向へ寝かせる。
    // 刈刃は車輪より前にあるので、刈った直後の芝の上にも跡が重なる
    const wheelsNow = this.wheelsNow
    const wheelsPrev = this.wheelsPrev
    wheelPositions(state, params, wheelsNow)
    if (!this.tracksStarted) {
      wheelsPrev.set(wheelsNow)
      this.tracksStarted = true
    }
    const moved = Math.hypot(wheelsNow[0] - wheelsPrev[0], wheelsNow[1] - wheelsPrev[1])
    if (moved > 5) {
      // やり直しなどで位置が飛んだときは、線を引かない
      wheelsPrev.set(wheelsNow)
    } else if (moved >= TRACK_STEP) {
      const sign = state.speed >= 0 ? 1 : -1
      const dirX = hx * sign
      const dirZ = hz * sign
      for (let i = 0; i < wheelsNow.length; i += 2) {
        const width = params.wheels[i / 2].width
        const halfX = (Math.cos(state.heading) * width) / 2
        const halfZ = (-Math.sin(state.heading) * width) / 2
        ctx.mowMap.addQuad(
          wheelsPrev[i] + halfX,
          wheelsPrev[i + 1] + halfZ,
          wheelsPrev[i] - halfX,
          wheelsPrev[i + 1] - halfZ,
          wheelsNow[i] - halfX,
          wheelsNow[i + 1] - halfZ,
          wheelsNow[i] + halfX,
          wheelsNow[i + 1] + halfZ,
          dirX,
          dirZ,
          ctx.maxGrassHeight,
          0.3
        )
      }
      wheelsPrev.set(wheelsNow)
    }
  }

  /**
   * カメラが追う位置を進める。タイムラプスでは、コマごとに飛ぶ機体をなめらかに追わせる。
   * smooth が false なら、そのまま機体の位置に合わせる
   */
  followCamera(dt: number, smooth: boolean): void {
    const target = this.state
    const c = this.cameraTarget
    const jump = Math.hypot(target.x - c.x, target.z - c.z)
    if (smooth && jump < 150) {
      const follow = 1 - Math.exp(-dt * 6)
      const x = c.x + (target.x - c.x) * follow
      const z = c.z + (target.z - c.z) * follow
      const turn = Math.atan2(Math.sin(target.heading - c.heading), Math.cos(target.heading - c.heading))
      const heading = c.heading + turn * follow
      Object.assign(c, target, { x, z, heading })
    } else {
      Object.assign(c, target)
    }
  }
}
