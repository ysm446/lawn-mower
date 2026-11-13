// 芝刈り機のモデル。寸法は実寸(m)。原点は後輪軸の中央の接地点。+Z が前。
// Blender で作ったモデル(tools/blender/build_mower.py が書き出す mower.glb)を読み込む。
// 読み込みが終わるまで、または失敗したときは、箱を組み合わせた仮のモデルを表示する。
// 車体(車輪、車軸、刈刃以外)は、ばねで支えられているように揺らす。加速と減速で前後に、旋回で外側に傾き、
// 地面の凹凸で上下に弾む(BodySpring)。

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import mowerUrl from '../assets/models/mower.glb?url'
import type { Terrain } from '../sim/terrain'
import type { VehicleParams, VehicleState } from '../sim/vehicle'

const WHEEL_RADIUS = 0.32

/** 車体の揺れの固有振動数(Hz)と減衰比。減衰比が小さいほど、揺れ戻しが長く続く */
const SPRING_HZ = 1.8
const SPRING_DAMPING = 0.3
/** 前後の加速度(m/s²)1 あたりに、車体が前後に傾く角度(ラジアン)。加速で前が浮き、減速で沈む */
const PITCH_PER_ACCEL = 0.02
/** 横向きの加速度(m/s²)1 あたりに、車体が外側へ傾く角度(ラジアン) */
const ROLL_PER_ACCEL = 0.018
/** 車台の上下の加速度(m/s²)1 あたりに、車体が遅れて沈む・浮く量(m)。凹凸で弾む */
const HEAVE_PER_ACCEL = 0.012
/** 揺れの大きさの上限(傾きはラジアン、上下は m) */
const MAX_TILT = 0.06
const MAX_HEAVE = 0.05
/** 揺れを計算する刻み(秒)。これより長いコマ(倍速など)は、刻みに分けて進める */
const SPRING_STEP = 1 / 120
/** これより長いコマ(高い倍速)では揺らさず、傾きの目標にそのまま合わせる */
const SPRING_MAX_FRAME = 0.25
/** 車体を傾ける中心(後輪軸から前へ、車軸の高さより少し上)の高さ(m) */
const BODY_PIVOT_HEIGHT = 0.55

/** 1 つの向きの揺れ。ばねとダンパーで、目標の値のまわりを揺れながら落ち着く */
class Spring {
  value = 0
  velocity = 0

  /** dt 秒進める。target は落ち着く先、push は外から加わる加速度(ばねの伸びを直接動かす) */
  step(target: number, push: number, dt: number): void {
    const w = 2 * Math.PI * SPRING_HZ
    const accel = -w * w * (this.value - target) - 2 * SPRING_DAMPING * w * this.velocity + push
    this.velocity += accel * dt
    this.value += this.velocity * dt
  }

  /** 揺れを止めて、target に合わせる */
  settle(target: number): void {
    this.value = target
    this.velocity = 0
  }
}

/** 車体の揺れ(前後の傾き、左右の傾き、上下)。機体の動きから毎コマ求める */
class BodySpring {
  readonly pitch = new Spring()
  readonly roll = new Spring()
  readonly heave = new Spring()
  private started = false
  private speed = 0
  private heading = 0
  private height = 0
  private climb = 0
  private x = 0
  private z = 0

  /**
   * 機体の状態と車台の高さ(後輪軸の中央の地面の高さ)から、揺れを dt 秒進める。
   * 倍速でコマが長いときは揺らさず、傾きの目標に合わせる
   */
  update(state: VehicleState, height: number, dt: number): void {
    if (dt <= 0) return
    // 最初のコマと、やり直しなどで位置が飛んだときは、そこから測り直す(飛んだ分で弾まないように)
    const jump = Math.hypot(state.x - this.x, state.z - this.z)
    if (!this.started || jump > Math.max(5, Math.abs(state.speed) * dt * 3)) {
      this.started = true
      this.x = state.x
      this.z = state.z
      this.speed = state.speed
      this.heading = state.heading
      this.height = height
      this.climb = 0
      this.pitch.settle(0)
      this.roll.settle(0)
      this.heave.settle(0)
      return
    }
    this.x = state.x
    this.z = state.z
    const accel = (state.speed - this.speed) / dt
    const turn = Math.atan2(Math.sin(state.heading - this.heading), Math.cos(state.heading - this.heading)) / dt
    // 左へ曲がると(向きが増える)、車体は右(外側)へ傾く。右が沈むのは、前を軸に左が上がる回転
    const lateral = state.speed * turn
    const climb = (height - this.height) / dt
    const lift = (climb - this.climb) / dt
    this.speed = state.speed
    this.heading = state.heading
    this.height = height
    this.climb = climb

    // 加速すると前が浮く(前を下げる回転を正とするので、負)
    const pitchTarget = clamp(-accel * PITCH_PER_ACCEL, MAX_TILT)
    const rollTarget = clamp(lateral * ROLL_PER_ACCEL, MAX_TILT)
    if (dt > SPRING_MAX_FRAME) {
      this.pitch.settle(pitchTarget)
      this.roll.settle(rollTarget)
      this.heave.settle(0)
      return
    }
    // 車台が持ち上げられると、車体は遅れて沈む(上下の加速度と逆向きに押される)
    const w = 2 * Math.PI * SPRING_HZ
    const push = clamp(-lift * HEAVE_PER_ACCEL, MAX_HEAVE * 4) * w * w
    const steps = Math.max(1, Math.ceil(dt / SPRING_STEP))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      this.pitch.step(pitchTarget, 0, h)
      this.roll.step(rollTarget, 0, h)
      this.heave.step(0, push, h)
    }
    this.pitch.value = clamp(this.pitch.value, MAX_TILT)
    this.roll.value = clamp(this.roll.value, MAX_TILT)
    this.heave.value = clamp(this.heave.value, MAX_HEAVE)
  }
}

function clamp(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit)
}

export class MowerModel {
  readonly root = new Group()
  private deck: Object3D = new Group()
  private frontWheels: Object3D[] = []
  private allWheels: Object3D[] = []
  private reels: Object3D[] = []
  private readonly placeholder = new Group()
  private deckLift = 0
  /** ばねで揺らす車体のまとまり。読み込んだモデルでだけ作る(仮のモデルは揺らさない) */
  private body: Object3D | null = null
  private readonly spring = new BodySpring()
  /** 片付けたか。片付けたあとに読み込みが終わっても、モデルは足さない */
  private disposed = false
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
    const track = params.track

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
    this.placeholder.add(body, hood, seat, seatBack, column, wheel)

    const wheelGeo = new CylinderGeometry(wheelRadius, wheelRadius, 0.3, 24)
    wheelGeo.rotateZ(Math.PI / 2)
    for (const z of [0, params.wheelbase]) {
      for (const side of [-1, 1]) {
        const pivot = new Group()
        pivot.position.set((side * track) / 2, wheelRadius, z)
        const mesh = new Mesh(wheelGeo, darkMat)
        pivot.add(mesh)
        this.placeholder.add(pivot)
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
    this.placeholder.add(this.deck)
    this.root.add(this.placeholder)
    this.enableShadows(this.root)
    this.loadModel()
  }

  private enableShadows(object: Object3D): void {
    object.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })
  }

  /**
   * 車体の部品(車輪、車軸、刈刃以外)を 1 つのまとまりに移す。まとまりの原点は車体を傾ける中心
   * (前後の車軸の中間、車軸より少し上)に置き、そこを中心に揺らす
   */
  private groupBody(frame: Object3D): Object3D {
    const body = new Group()
    body.name = 'body'
    body.position.set(0, BODY_PIVOT_HEIGHT, this.params.wheelbase / 2)
    const parts = frame.children.filter((child) => !/^(axle_|steer_|deck$)/.test(child.name))
    frame.add(body)
    frame.updateMatrixWorld(true)
    // 見た目の位置は変えずに移す
    for (const part of parts) body.attach(part)
    return body
  }

  /** Blender 製のモデルを読み込み、仮のモデルと入れ替える */
  private loadModel(): void {
    new GLTFLoader().load(
      mowerUrl,
      (gltf) => {
        const model = gltf.scene
        if (this.disposed) {
          disposeObject(model)
          return
        }
        const find = (name: string): Object3D | null => model.getObjectByName(name) ?? null
        const deck = find('deck')
        // 部品は、機種の定義(mowers/*.json)の並び順の番号で名前がついている
        const spec = this.params
        const wheels = spec.wheels.map((_, i) => find(`wheel_${i}`))
        const steers = spec.wheels
          .map((wheel, i) => (wheel.steered ? find(`steer_${i}`) : undefined))
          .filter((part) => part !== undefined)
        const reels = spec.reels.map((_, i) => find(`reel_${i}`))
        const parts = [deck, ...wheels, ...steers, ...reels]
        if (parts.some((part) => part === null)) {
          console.warn('mower.glb に必要な部品が見つからないため、仮のモデルを使います')
          return
        }
        this.deck = deck as Object3D
        this.allWheels = wheels as Object3D[]
        this.frontWheels = steers as Object3D[]
        this.reels = reels as Object3D[]
        this.enableShadows(model)
        this.body = this.groupBody(find('mower') ?? model)
        // 部品(ボルト 1 本、刃 1 枚まで別々で、1 台 170 ほど)を、一緒に動くまとまりごと、材質ごとに 1 つの形にまとめる。
        // 部品ごとに描くと、画面と影の地図 3 段で 1 台 700 回近く描くことになり、台数が増えると重い
        mergeRigidParts(model, [
          model,
          find('mower'),
          this.body,
          this.deck,
          ...this.allWheels,
          ...this.frontWheels,
          ...this.reels
        ])
        this.root.remove(this.placeholder)
        this.root.add(model)
      },
      undefined,
      (error) => console.warn('mower.glb を読み込めないため、仮のモデルを使います', error)
    )
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
    const track = this.params.track
    const half = track / 2
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
      .set(lx * track, (rearLeft + frontLeft - rearRight - frontRight) / 2, lz * track)
      .normalize()
    this.up.crossVectors(this.forward, this.left).normalize()
    this.left.crossVectors(this.up, this.forward)
    this.basis.makeBasis(this.left, this.up, this.forward)
    this.root.quaternion.setFromRotationMatrix(this.basis)
    this.root.position.set(state.x, rear, state.z)

    // 車体の揺れ。加速と減速で前後に、旋回で外側に傾き、地面の凹凸で上下に弾む
    this.spring.update(state, rear, dt)
    if (this.body) {
      this.body.position.y = BODY_PIVOT_HEIGHT + this.spring.heave.value
      this.body.rotation.set(this.spring.pitch.value, 0, this.spring.roll.value)
    }

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

  /** 形と材質を片付ける。台数を減らして機体を消すときに呼ぶ(シーンからは呼ぶ側で外す) */
  dispose(): void {
    this.disposed = true
    disposeObject(this.root)
    disposeObject(this.placeholder)
  }
}

/**
 * 一緒に動くまとまり(movers。車体、車輪、刈刃、リールなど、sync で動かすもの)ごとに、その下のメッシュを
 * 材質ごとに 1 つの形にまとめる。メッシュは、いちばん近い祖先のまとまり(自分がまとまりならそれ自身)に属する。
 * 見た目と動きは変わらない(まとめた形は、まとまりの座標で持つので、まとまりと一緒に動く)。
 * まとまりそのものがメッシュのとき(子の部品を持つ車輪やリール)は、外せないので、そのメッシュは描かないようにする
 */
function mergeRigidParts(model: Object3D, movers: (Object3D | null)[]): void {
  const owners = new Set(movers.filter((m): m is Object3D => m !== null))
  model.updateMatrixWorld(true)
  /** まとまりごと、材質と頂点の属性の組ごとの、まとめるメッシュ */
  const buckets = new Map<Object3D, Map<string, { material: Material; meshes: Mesh[] }>>()
  model.traverse((obj) => {
    if (!(obj instanceof Mesh) || Array.isArray(obj.material)) return
    let owner: Object3D | null = obj
    while (owner && !owners.has(owner)) owner = owner.parent
    if (!owner) return
    const geometry = obj.geometry as BufferGeometry
    const key = `${obj.material.uuid}|${geometry.index ? 'i' : 'n'}|${Object.keys(geometry.attributes).sort().join(',')}`
    let byKey = buckets.get(owner)
    if (!byKey) buckets.set(owner, (byKey = new Map()))
    let bucket = byKey.get(key)
    if (!bucket) byKey.set(key, (bucket = { material: obj.material, meshes: [] }))
    bucket.meshes.push(obj)
  })
  const toOwner = new Matrix4()
  for (const [owner, byKey] of buckets) {
    const inverse = new Matrix4().copy(owner.matrixWorld).invert()
    for (const { material, meshes } of byKey.values()) {
      if (meshes.length < 2) continue
      const parts = meshes.map((mesh) => {
        toOwner.multiplyMatrices(inverse, mesh.matrixWorld)
        return (mesh.geometry as BufferGeometry).clone().applyMatrix4(toOwner)
      })
      const merged = mergeGeometries(parts)
      for (const part of parts) part.dispose()
      if (!merged) continue
      const mesh = new Mesh(merged, material)
      mesh.name = `${owner.name}_merged`
      mesh.castShadow = true
      mesh.receiveShadow = true
      owner.add(mesh)
      for (const original of meshes) {
        original.geometry.dispose()
        if (owners.has(original) || original.children.length > 0) {
          // 子を持つメッシュは外せない。描かないようにする(layers は子に効かないので、子は描かれる)
          original.geometry = new BufferGeometry()
          original.layers.disableAll()
        } else {
          original.removeFromParent()
        }
      }
    }
  }
}

/** その下にあるメッシュの形と材質を片付ける */
function disposeObject(object: Object3D): void {
  object.traverse((obj) => {
    if (!(obj instanceof Mesh)) return
    obj.geometry.dispose()
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) material.dispose()
  })
}
