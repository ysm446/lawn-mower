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

  constructor(domElement: HTMLElement) {
    this.camera.filmGauge = this.settings.sensorWidth
    this.controls = new OrbitControls(this.camera, domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03
    this.controls.minDistance = 4
    this.controls.maxDistance = 600
    this.controls.enabled = false
    this.setMode('chase')
  }

  get exposure(): number {
    return exposureFromSettings(this.settings)
  }

  setMode(mode: CameraMode): void {
    this.mode = mode
    this.settings.focalLength = MODE_FOCAL_LENGTH[mode]
    this.controls.enabled = mode === 'orbit'
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
      this.tmp.set(state.x - fx * 9, ground + 4.2, state.z - fz * 9)
      if (this.initialized) cam.position.lerp(this.tmp, Math.min(1, dt * 3))
      else cam.position.copy(this.tmp)
      this.keepAboveGround(terrain)
      const aheadX = state.x + fx * 4
      const aheadZ = state.z + fz * 4
      cam.lookAt(aheadX, terrain.heightAt(aheadX, aheadZ) + 0.6, aheadZ)
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
