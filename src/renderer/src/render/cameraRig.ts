// カメラ。物理カメラの設定値(焦点距離など)を持ち、視点の切り替えを受け持つ。

import { PerspectiveCamera, Vector3 } from 'three'
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

export type CameraMode = 'chase' | 'orbit' | 'top'

export const CAMERA_MODES: CameraMode[] = ['chase', 'orbit', 'top']

export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  chase: '追従',
  orbit: 'ドローン',
  top: '俯瞰'
}

/** 視点ごとの焦点距離の初期値(mm) */
const MODE_FOCAL_LENGTH: Record<CameraMode, number> = {
  chase: 28,
  orbit: 50,
  top: 85
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(50, 1, 0.3, 6000)
  readonly settings: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS }
  mode: CameraMode = 'chase'
  private readonly controls: OrbitControls
  private readonly focus = new Vector3()
  private readonly lastFocus = new Vector3()
  private readonly tmp = new Vector3()
  private initialized = false
  // 追従視点でドラッグして回した分。手を離してしばらくすると 0 に戻る
  private chaseYaw = 0
  private chasePitch = 0
  private chaseDragging = false
  private chaseIdle = 0

  constructor(domElement: HTMLElement) {
    this.camera.filmGauge = this.settings.sensorWidth
    this.controls = new OrbitControls(this.camera, domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03
    this.controls.minDistance = 4
    this.controls.maxDistance = 600
    this.controls.enabled = false
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
    domElement.addEventListener('pointerup', endDrag)
    domElement.addEventListener('pointercancel', endDrag)
  }

  get exposure(): number {
    return exposureFromSettings(this.settings)
  }

  setMode(mode: CameraMode): void {
    this.mode = mode
    this.settings.focalLength = MODE_FOCAL_LENGTH[mode]
    this.controls.enabled = mode === 'orbit'
    this.chaseYaw = 0
    this.chasePitch = 0
    this.chaseDragging = false
    this.initialized = false
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
      const flat = Math.cos(elevation) * CHASE_RADIUS
      this.tmp.set(
        state.x - Math.sin(yaw) * flat,
        ground + CHASE_PIVOT_HEIGHT + Math.sin(elevation) * CHASE_RADIUS,
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
    } else {
      this.tmp.set(this.focus.x - 60, this.focus.y + 150, this.focus.z - 110)
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
