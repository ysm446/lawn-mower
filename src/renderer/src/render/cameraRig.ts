// カメラ。物理カメラの設定値(焦点距離など)を持ち、視点の切り替えを受け持つ。

import { PerspectiveCamera, Spherical, Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  DEFAULT_CAMERA_SETTINGS,
  exposureFromSettings,
  type CameraSettings
} from '../camera/exposure'
import type { Terrain } from '../sim/terrain'
import type { VehicleState } from '../sim/vehicle'

/** カメラが地面に潜らないように保つ、地面からの最低の高さ(m) */
const MIN_CLEARANCE = 1.2

// 追従視点: 機体の少し上の点を中心に、後ろ斜め上から見る
const CHASE_PIVOT_HEIGHT = 0.6
const CHASE_BACK = 9
const CHASE_UP = 3.6
const CHASE_RADIUS = Math.hypot(CHASE_BACK, CHASE_UP)
const CHASE_ELEVATION = Math.atan2(CHASE_UP, CHASE_BACK)
/** ドラッグをやめてから、背後に戻り始めるまでの時間(秒) */
const CHASE_RETURN_DELAY = 2

// 定点の視点のキー操作。weather-globe の旋回モードに合わせてある。
// Q / E: 1 回押すごとに自動の旋回の段を変える。手を離しても回り続ける
/** 自動の旋回の段の数(右回りと左回りのそれぞれ) */
export const ORBIT_LEVELS = 5
/** 1 段目の速さ(度/秒)。1 段ごとに ORBIT_STEP_RATIO 倍にする */
const ORBIT_DEGREES_PER_SECOND = 1.2
const ORBIT_STEP_RATIO = 2
/** 速さを変えるときの時定数(秒) */
const ORBIT_SECONDS = 0.8
// W / A / S / D: 押している間だけアームを回す(A / D が方角、W / S が傾き)
const ARM_YAW_DEGREES_PER_SECOND = 15
const ARM_TILT_DEGREES_PER_SECOND = 12
/** 押し始めと離したときに、動きをならす時定数(秒) */
const ARM_EASE_SECONDS = 0.35
/** アームを起こせる限界。真上から見下ろす手前で止める(ラジアン。真上が 0) */
const ARM_MIN_POLAR = 0.06

/** 段から旋回の速さ(度/秒)を求める。段の途中(速さを変えている間)もなめらかにつなぐ */
function orbitDegreesPerSecond(throttle: number): number {
  const size = Math.abs(throttle)
  const rate = size < 1 ? ORBIT_DEGREES_PER_SECOND * size : ORBIT_DEGREES_PER_SECOND * ORBIT_STEP_RATIO ** (size - 1)
  return Math.sign(throttle) * rate
}

export type CameraMode = 'chase' | 'orbit' | 'top' | 'fixed'

export const CAMERA_MODES: CameraMode[] = ['chase', 'orbit', 'top', 'fixed']

export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  chase: '追従',
  orbit: 'ドローン',
  top: '俯瞰',
  fixed: '定点'
}

/** 視点ごとの焦点距離の初期値(mm) */
const MODE_FOCAL_LENGTH: Record<CameraMode, number> = {
  chase: 28,
  orbit: 50,
  top: 85,
  fixed: 50
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(50, 1, 0.3, 6000)
  readonly settings: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS }
  mode: CameraMode = 'chase'
  private readonly controls: OrbitControls
  private readonly focus = new Vector3()
  private readonly lastFocus = new Vector3()
  private readonly tmp = new Vector3()
  private readonly arm = new Spherical()
  private initialized = false
  // 定点の視点の、自動の旋回の段(-ORBIT_LEVELS〜ORBIT_LEVELS。正が右回り)と、なめらかにしたあとの値
  private orbitStep = 0
  private orbitThrottle = 0
  // 定点の視点の、キーでアームを回す向き(-1〜1)と、なめらかにしたあとの値
  private armYawGoal = 0
  private armTiltGoal = 0
  private armYaw = 0
  private armTilt = 0
  private controlsDragging = false
  // 追従視点でドラッグして回した分。手を離してしばらくすると 0 に戻る
  private chaseYaw = 0
  private chasePitch = 0
  private chaseDragging = false
  private chaseIdle = 0
  // ホイールで変える距離の倍率(1 が初期の距離)。視点ごとに覚えておく
  private chaseZoom = 1
  private topZoom = 1

  constructor(domElement: HTMLElement) {
    this.camera.filmGauge = this.settings.sensorWidth
    this.controls = new OrbitControls(this.camera, domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03
    this.controls.minDistance = 4
    this.controls.maxDistance = 600
    this.controls.enabled = false
    // ドラッグしている間は、自動の旋回を止める
    this.controls.addEventListener('start', () => {
      this.controlsDragging = true
    })
    this.controls.addEventListener('end', () => {
      this.controlsDragging = false
    })
    this.setMode('chase')

    // 追従視点の左ドラッグ: 機体を中心に回り込む
    domElement.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'chase' || e.button !== 0) return
      this.chaseDragging = true
      domElement.setPointerCapture(e.pointerId)
    })
    domElement.addEventListener('pointermove', (e) => {
      if (!this.chaseDragging) return
      const scale = (Math.PI * 2) / domElement.clientHeight
      this.chaseYaw -= e.movementX * scale
      this.chasePitch += e.movementY * scale
      const lo = (4 * Math.PI) / 180 - CHASE_ELEVATION
      const hi = (80 * Math.PI) / 180 - CHASE_ELEVATION
      this.chasePitch = Math.min(Math.max(this.chasePitch, lo), hi)
    })
    const endDrag = (e: PointerEvent): void => {
      if (!this.chaseDragging) return
      this.chaseDragging = false
      this.chaseIdle = 0
      if (domElement.hasPointerCapture(e.pointerId)) domElement.releasePointerCapture(e.pointerId)
    }
    // ホイール: カメラを近づける、離す(画角は変えない)。ドローン視点は OrbitControls が受け持つ
    domElement.addEventListener(
      'wheel',
      (e) => {
        if (this.mode === 'orbit' || this.mode === 'fixed') return
        e.preventDefault()
        const factor = Math.exp(e.deltaY * 0.0012)
        if (this.mode === 'chase') {
          this.chaseZoom = Math.min(Math.max(this.chaseZoom * factor, 0.35), 8)
        } else {
          this.topZoom = Math.min(Math.max(this.topZoom * factor, 0.15), 4)
        }
      },
      { passive: false }
    )
    domElement.addEventListener('pointerup', endDrag)
    domElement.addEventListener('pointercancel', endDrag)
  }

  /** 今の視点での焦点距離の初期値(mm) */
  get defaultFocalLength(): number {
    return MODE_FOCAL_LENGTH[this.mode]
  }

  get exposure(): number {
    return exposureFromSettings(this.settings)
  }

  setMode(mode: CameraMode): void {
    this.mode = mode
    this.settings.focalLength = MODE_FOCAL_LENGTH[mode]
    // 定点では、機体を追わずにその場に据える。左ドラッグで見回し、右ドラッグで位置を動かせる
    this.controls.enabled = mode === 'orbit' || mode === 'fixed'
    this.controls.enablePan = mode === 'fixed'
    this.chaseYaw = 0
    this.chasePitch = 0
    this.chaseDragging = false
    this.initialized = false
    this.orbitStep = 0
    this.orbitThrottle = 0
    this.armYaw = 0
    this.armTilt = 0
  }

  /** 定点の視点の、自動の旋回の段(正が右回り。カメラが右へ回り込む)。0 は止まっている */
  get orbitLevel(): number {
    return this.orbitStep
  }

  /** 自動の旋回の段を step だけ変える。定点の視点でだけ働く */
  stepOrbit(step: number): void {
    if (this.mode !== 'fixed') return
    this.orbitStep = Math.min(Math.max(this.orbitStep + step, -ORBIT_LEVELS), ORBIT_LEVELS)
  }

  /** キーでアームを回す向きを伝える。yaw は右が正、tilt は起こす(上から見下ろす)向きが正。毎フレーム呼ぶ */
  setArmInput(yaw: number, tilt: number): void {
    this.armYawGoal = yaw
    this.armTiltGoal = tilt
  }

  /** 定点の視点で、自動の旋回とキーの分だけ、注視点のまわりにアームを回す */
  private turnArm(dt: number): void {
    this.orbitThrottle += (this.orbitStep - this.orbitThrottle) * (1 - Math.exp(-dt / ORBIT_SECONDS))
    if (this.orbitStep === 0 && Math.abs(this.orbitThrottle) < 1e-3) this.orbitThrottle = 0
    const ease = 1 - Math.exp(-dt / ARM_EASE_SECONDS)
    this.armYaw += (this.armYawGoal - this.armYaw) * ease
    this.armTilt += (this.armTiltGoal - this.armTilt) * ease
    if (this.armYawGoal === 0 && Math.abs(this.armYaw) < 1e-3) this.armYaw = 0
    if (this.armTiltGoal === 0 && Math.abs(this.armTilt) < 1e-3) this.armTilt = 0

    const orbit = this.controlsDragging ? 0 : orbitDegreesPerSecond(this.orbitThrottle)
    const yaw = (orbit + this.armYaw * ARM_YAW_DEGREES_PER_SECOND) * dt
    const tilt = this.armTilt * ARM_TILT_DEGREES_PER_SECOND * dt
    if (yaw === 0 && tilt === 0) return
    const target = this.controls.target
    this.arm.setFromVector3(this.tmp.copy(this.camera.position).sub(target))
    // 右へ回り込むと、上から見て左回りに動く
    this.arm.theta += (yaw * Math.PI) / 180
    this.arm.phi = Math.min(Math.max(this.arm.phi - (tilt * Math.PI) / 180, ARM_MIN_POLAR), this.controls.maxPolarAngle)
    this.camera.position.setFromSpherical(this.arm).add(target)
  }

  /** 追従視点と俯瞰の距離の倍率を決める(動作確認用) */
  setZoom(zoom: number): void {
    this.chaseZoom = zoom
    this.topZoom = zoom
  }

  nextMode(): void {
    const i = CAMERA_MODES.indexOf(this.mode)
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
  }

  update(state: VehicleState, dt: number, terrain: Terrain): void {
    const cam = this.camera
    cam.filmGauge = this.settings.sensorWidth
    cam.setFocalLength(this.settings.focalLength)

    const fx = Math.sin(state.heading)
    const fz = Math.cos(state.heading)
    const ground = terrain.heightAt(state.x, state.z)
    this.focus.set(state.x + fx * 1.2, ground + 0.8, state.z + fz * 1.2)

    if (this.mode === 'chase') {
      // 手を離してしばらくしたら、回した分をなめらかに戻して背後に回る
      if (!this.chaseDragging) {
        this.chaseIdle += dt
        if (this.chaseIdle > CHASE_RETURN_DELAY) {
          // 遠回りしないように、半周を超えた分は反対回りに直す
          this.chaseYaw = Math.atan2(Math.sin(this.chaseYaw), Math.cos(this.chaseYaw))
          const keep = Math.exp(-dt * 2.5)
          this.chaseYaw *= keep
          this.chasePitch *= keep
        }
      }
      const yaw = state.heading + this.chaseYaw
      const elevation = CHASE_ELEVATION + this.chasePitch
      const radius = CHASE_RADIUS * this.chaseZoom
      const flat = Math.cos(elevation) * radius
      this.tmp.set(
        state.x - Math.sin(yaw) * flat,
        ground + CHASE_PIVOT_HEIGHT + Math.sin(elevation) * radius,
        state.z - Math.cos(yaw) * flat
      )
      // ドラッグ中は手の動きにすぐついてくるようにする
      const follow = this.chaseDragging ? 14 : 3
      if (this.initialized) cam.position.lerp(this.tmp, Math.min(1, dt * follow))
      else cam.position.copy(this.tmp)
      this.keepAboveGround(terrain)
      // 背後から見るときは機体の少し先を、回り込んだときは機体そのものを見る
      const lead = 4 * Math.max(0, Math.cos(this.chaseYaw))
      const aheadX = state.x + fx * lead
      const aheadZ = state.z + fz * lead
      cam.lookAt(aheadX, terrain.heightAt(aheadX, aheadZ) + CHASE_PIVOT_HEIGHT, aheadZ)
    } else if (this.mode === 'orbit') {
      if (!this.initialized) {
        cam.position.set(this.focus.x - 38, 26, this.focus.z - 46)
        this.controls.target.copy(this.focus)
      } else {
        // 注視点の移動分だけカメラも動かし、機体を追いかける
        this.tmp.copy(this.focus).sub(this.lastFocus)
        cam.position.add(this.tmp)
        this.controls.target.add(this.tmp)
      }
      this.controls.update()
      this.keepAboveGround(terrain)
    } else if (this.mode === 'fixed') {
      // 切り替えた時点のカメラの位置に据え、機体のいた所を見る。その後は機体を追わない
      if (!this.initialized) {
        if (cam.position.lengthSq() === 0) {
          cam.position.set(this.focus.x - 30, this.focus.y + 18, this.focus.z - 36)
        }
        this.controls.target.copy(this.focus)
      }
      this.turnArm(dt)
      this.controls.update()
      this.keepAboveGround(terrain)
    } else {
      const zoom = this.topZoom
      this.tmp.set(this.focus.x - 60 * zoom, this.focus.y + 150 * zoom, this.focus.z - 110 * zoom)
      if (this.initialized) cam.position.lerp(this.tmp, Math.min(1, dt * 2))
      else cam.position.copy(this.tmp)
      cam.lookAt(this.focus)
    }

    this.lastFocus.copy(this.focus)
    this.initialized = true
  }

  private keepAboveGround(terrain: Terrain): void {
    const p = this.camera.position
    const floor = terrain.heightAt(p.x, p.z) + MIN_CLEARANCE
    if (p.y < floor) p.y = floor
  }

  get focusPoint(): Vector3 {
    return this.focus
  }
}
