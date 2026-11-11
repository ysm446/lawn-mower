// 仮の芝刈り機モデル。寸法は実寸(m)。Blender 製のモデルができたら置き換える。
// 原点は後輪軸の中央の接地点。+Z が前。

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Object3D
} from 'three'
import type { Terrain } from '../sim/terrain'
import type { VehicleParams, VehicleState } from '../sim/vehicle'

const WHEEL_RADIUS = 0.32
const TRACK = 1.3

export class MowerModel {
  readonly root = new Group()
  private readonly deck = new Group()
  private readonly frontWheels: Object3D[] = []
  private readonly allWheels: Mesh[] = []
  private readonly reels: Mesh[] = []
  private deckLift = 0
  private readonly left = new Vector3()
  private readonly up = new Vector3()
  private readonly forward = new Vector3()
  private readonly basis = new Matrix4()

  constructor(private readonly params: VehicleParams) {
    const bodyMat = new MeshStandardMaterial({ color: 0xb3261e, roughness: 0.45, metalness: 0.1 })
    const darkMat = new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.8 })
    const metalMat = new MeshStandardMaterial({ color: 0x8d9094, roughness: 0.35, metalness: 0.8 })
    const seatMat = new MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.9 })

    const wheelRadius = WHEEL_RADIUS
    const track = TRACK

    const body = new Mesh(new BoxGeometry(1.15, 0.55, 2.1), bodyMat)
    body.position.set(0, 0.72, 0.65)
    const hood = new Mesh(new BoxGeometry(1.0, 0.35, 0.9), bodyMat)
    hood.position.set(0, 1.12, 0.0)
    const seat = new Mesh(new BoxGeometry(0.5, 0.12, 0.5), seatMat)
    seat.position.set(0, 1.08, 0.85)
    const seatBack = new Mesh(new BoxGeometry(0.5, 0.5, 0.1), seatMat)
    seatBack.position.set(0, 1.33, 0.6)
    const column = new Mesh(new CylinderGeometry(0.03, 0.03, 0.55), darkMat)
    column.position.set(0, 1.25, 1.35)
    column.rotation.x = -0.5
    const wheel = new Mesh(new CylinderGeometry(0.19, 0.19, 0.04, 20), darkMat)
    wheel.position.set(0, 1.5, 1.22)
    wheel.rotation.x = Math.PI / 2 - 0.5
    this.root.add(body, hood, seat, seatBack, column, wheel)

    const wheelGeo = new CylinderGeometry(wheelRadius, wheelRadius, 0.3, 24)
    wheelGeo.rotateZ(Math.PI / 2)
    for (const z of [0, params.wheelbase]) {
      for (const side of [-1, 1]) {
        const pivot = new Group()
        pivot.position.set((side * track) / 2, wheelRadius, z)
        const mesh = new Mesh(wheelGeo, darkMat)
        pivot.add(mesh)
        this.root.add(pivot)
        this.allWheels.push(mesh)
        if (z > 0) this.frontWheels.push(pivot)
      }
    }

    // 刈刃: リールを 3 連で並べる
    const units = 3
    const gap = 0.06
    const unitWidth = (params.cutWidth - gap * (units - 1)) / units
    const reelGeo = new CylinderGeometry(0.1, 0.1, unitWidth, 12)
    reelGeo.rotateZ(Math.PI / 2)
    for (let i = 0; i < units; i++) {
      const x = (i - (units - 1) / 2) * (unitWidth + gap)
      // 中央は少し前、左右は少し後ろに置く(実機の千鳥配置に近づける)
      const z = i === 1 ? 0.25 : -0.25
      const cover = new Mesh(new BoxGeometry(unitWidth, 0.1, 0.42), bodyMat)
      cover.position.set(x, 0.3, z)
      const reel = new Mesh(reelGeo, metalMat)
      reel.position.set(x, 0.12, z)
      this.deck.add(cover, reel)
      this.reels.push(reel)
    }
    const arm = new Mesh(new BoxGeometry(0.12, 0.08, 0.9), darkMat)
    arm.position.set(0, 0.42, -0.5)
    this.deck.add(arm)
    this.deck.position.set(0, 0, params.deckOffset)
    this.root.add(this.deck)

    this.root.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })
  }

  /**
   * 車両の状態を見た目に反映する。4 輪の接地点の高さから、機体の高さと傾きを決める。
   * dt は見た目の補間に使う
   */
  sync(state: VehicleState, dt: number, terrain: Terrain): void {
    const { wheelbase, deckOffset } = this.params
    const fx = Math.sin(state.heading)
    const fz = Math.cos(state.heading)
    // 進行方向の左
    const lx = fz
    const lz = -fx
    const half = TRACK / 2
    const frontX = state.x + fx * wheelbase
    const frontZ = state.z + fz * wheelbase
    const rearLeft = terrain.heightAt(state.x + lx * half, state.z + lz * half)
    const rearRight = terrain.heightAt(state.x - lx * half, state.z - lz * half)
    const frontLeft = terrain.heightAt(frontX + lx * half, frontZ + lz * half)
    const frontRight = terrain.heightAt(frontX - lx * half, frontZ - lz * half)
    const rear = (rearLeft + rearRight) / 2
    const front = (frontLeft + frontRight) / 2

    this.forward.set(fx * wheelbase, front - rear, fz * wheelbase).normalize()
    this.left
      .set(lx * TRACK, (rearLeft + frontLeft - rearRight - frontRight) / 2, lz * TRACK)
      .normalize()
    this.up.crossVectors(this.forward, this.left).normalize()
    this.left.crossVectors(this.up, this.forward)
    this.basis.makeBasis(this.left, this.up, this.forward)
    this.root.quaternion.setFromRotationMatrix(this.basis)
    this.root.position.set(state.x, rear, state.z)

    for (const pivot of this.frontWheels) pivot.rotation.y = state.steer

    const spin = (state.speed * dt) / WHEEL_RADIUS
    for (const w of this.allWheels) w.rotation.x += spin

    // 刈刃は機体の前に張り出しているので、その位置の地面の高さに合わせて浮き沈みさせる
    const deckGround = terrain.heightAt(state.x + fx * deckOffset, state.z + fz * deckOffset)
    const deckPlane = rear + ((front - rear) * deckOffset) / wheelbase
    const follow = Math.min(Math.max(deckGround - deckPlane, -0.3), 0.3)

    const targetLift = state.deckDown ? 0 : 1
    this.deckLift += (targetLift - this.deckLift) * Math.min(1, dt * 6)
    this.deck.position.y = this.deckLift * 0.25 + follow
    this.deck.rotation.x = -this.deckLift * 0.15
    if (state.deckDown) {
      for (const r of this.reels) r.rotation.x += dt * 30
    }
  }
}
