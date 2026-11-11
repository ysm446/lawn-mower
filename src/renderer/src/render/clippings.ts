// 刈りカス。刈刃から飛び出す細かい葉を、粒として描く。
// 粒は飛んで落ち、地面にしばらく残ってから消える。位置の計算は CPU で行い、インスタンシングで描く。

import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three'
import type { Terrain } from '../sim/terrain'

const CAPACITY = 5000
/** 重力(m/s²)。実際より少し弱くして、ふわりと舞うようにする */
const GRAVITY = 6.5
/** 空気抵抗(1/s) */
const DRAG = 1.4
/** 粒の幅(m)。実物より大きくして、少し離れても見えるようにする */
const WIDTH = 0.022

const DEAD = 0
const FLYING = 1
const LANDED = 2

export class Clippings {
  readonly mesh: InstancedMesh
  private readonly state = new Uint8Array(CAPACITY)
  private readonly position = new Float32Array(CAPACITY * 3)
  private readonly velocity = new Float32Array(CAPACITY * 3)
  private readonly axis = new Float32Array(CAPACITY * 3)
  private readonly angle = new Float32Array(CAPACITY)
  private readonly spin = new Float32Array(CAPACITY)
  private readonly length = new Float32Array(CAPACITY)
  private readonly age = new Float32Array(CAPACITY)
  private readonly life = new Float32Array(CAPACITY)
  private next = 0
  private readonly matrix = new Matrix4()
  private readonly quaternion = new Quaternion()
  private readonly tmpAxis = new Vector3()
  private readonly tmpPosition = new Vector3()
  private readonly tmpScale = new Vector3()
  private readonly color = new Color()
  private readonly flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
  private readonly yaw = new Quaternion()
  private readonly up = new Vector3(0, 1, 0)

  constructor(private readonly terrain: Terrain) {
    const material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: DoubleSide })
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, CAPACITY)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    const hidden = new Matrix4().makeScale(0, 0, 0)
    for (let i = 0; i < CAPACITY; i++) {
      this.mesh.setMatrixAt(i, hidden)
      this.mesh.setColorAt(i, this.color.setRGB(0.1, 0.23, 0.03))
    }
  }

  /** 粒を 1 つ飛ばす。位置と速度はワールド座標 */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.next
    this.next = (this.next + 1) % CAPACITY
    this.state[i] = FLYING
    this.position.set([x, y, z], i * 3)
    this.velocity.set([vx, vy, vz], i * 3)
    this.tmpAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.axis.set([this.tmpAxis.x, this.tmpAxis.y, this.tmpAxis.z], i * 3)
    this.angle[i] = Math.random() * Math.PI * 2
    this.spin[i] = (Math.random() - 0.5) * 30
    this.length[i] = 0.04 + Math.random() * 0.06
    this.age[i] = 0
    // 地面に落ちてから残る時間(秒)
    this.life[i] = 4 + Math.random() * 5
    // 芝と同じ色みで、明るさと黄みを少しばらつかせる
    const shade = 0.85 + Math.random() * 0.6
    this.mesh.setColorAt(
      i,
      this.color.setRGB(0.1 * shade * (1 + Math.random() * 0.25), 0.23 * shade, 0.03 * shade)
    )
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** 毎フレーム呼ぶ。dt は粒の時間で進める秒数 */
  update(dt: number): void {
    const p = this.position
    const v = this.velocity
    const damping = Math.exp(-DRAG * dt)
    for (let i = 0; i < CAPACITY; i++) {
      const s = this.state[i]
      if (s === DEAD) continue
      const k = i * 3
      let shrink = 1
      if (s === FLYING) {
        v[k + 1] -= GRAVITY * dt
        v[k] *= damping
        v[k + 1] *= damping
        v[k + 2] *= damping
        p[k] += v[k] * dt
        p[k + 1] += v[k + 1] * dt
        p[k + 2] += v[k + 2] * dt
        this.angle[i] += this.spin[i] * dt
        const ground = this.terrain.heightAt(p[k], p[k + 2]) + 0.02
        if (p[k + 1] <= ground && v[k + 1] < 0) {
          p[k + 1] = ground
          this.state[i] = LANDED
          this.age[i] = 0
        }
        this.tmpAxis.set(this.axis[k], this.axis[k + 1], this.axis[k + 2])
        this.quaternion.setFromAxisAngle(this.tmpAxis, this.angle[i])
      } else {
        this.age[i] += dt
        const left = this.life[i] - this.age[i]
        if (left <= 0) {
          this.state[i] = DEAD
          shrink = 0
        } else {
          // 消える前の 1 秒で小さくする
          shrink = Math.min(left, 1)
        }
        // 地面に寝かせる。向きは飛んでいたときの角度から決める
        this.yaw.setFromAxisAngle(this.up, this.angle[i])
        this.quaternion.copy(this.yaw).multiply(this.flat)
      }
      this.tmpPosition.set(p[k], p[k + 1], p[k + 2])
      this.tmpScale.set(WIDTH * shrink, this.length[i] * shrink, 1)
      this.matrix.compose(this.tmpPosition, this.quaternion, this.tmpScale)
      this.mesh.setMatrixAt(i, this.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  /** すべての粒を消す */
  clear(): void {
    this.state.fill(DEAD)
    this.matrix.makeScale(0, 0, 0)
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, this.matrix)
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
