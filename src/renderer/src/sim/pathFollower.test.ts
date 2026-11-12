import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLLOWER, PathFollower, type DrivePath } from './pathFollower'
import { FAIRWAY_MOWER, createVehicleState, stepVehicle } from './vehicle'

const DT = 1 / 120

/** 直線 straight m → 半径 radius の半円 → 直線 straight m の経路(点の間隔 0.25 m) */
function uTurnPath(straight: number, radius: number): DrivePath {
  const pts: number[] = []
  for (let s = 0; s < straight; s += 0.25) pts.push(0, s)
  const arcSteps = Math.ceil((Math.PI * radius) / 0.25)
  for (let k = 0; k <= arcSteps; k++) {
    const a = (Math.PI * k) / arcSteps
    pts.push(radius - radius * Math.cos(a), straight + radius * Math.sin(a))
  }
  for (let s = straight - 0.25; s >= 0; s -= 0.25) pts.push(radius * 2, s)
  const points = new Float32Array(pts)
  const cut = new Uint8Array(points.length / 2 - 1).fill(1)
  return { points, cut }
}

describe('PathFollower のカーブ減速', () => {
  it('直線では最高速度、半円の中では √(横加速度 × 半径) が上限になる', () => {
    const radius = 4
    const follower = new PathFollower(uTurnPath(30, radius), FAIRWAY_MOWER)
    expect(follower.speedLimitAt(2)).toBeCloseTo(FAIRWAY_MOWER.maxSpeed, 3)
    const arcMiddle = 30 + (Math.PI * radius) / 2
    expect(follower.speedLimitAt(arcMiddle)).toBeCloseTo(Math.sqrt(DEFAULT_FOLLOWER.lateralAccel * radius), 1)
  })

  it('カーブの手前で、減速が間に合うように上限が下がっていく', () => {
    const follower = new PathFollower(uTurnPath(30, 4), FAIRWAY_MOWER)
    const decel = FAIRWAY_MOWER.brake * DEFAULT_FOLLOWER.curveBrake
    let prev = follower.speedLimitAt(20)
    for (let s = 20.5; s <= 30; s += 0.5) {
      const v = follower.speedLimitAt(s)
      expect(v).toBeLessThanOrEqual(prev + 1e-4)
      // 0.5 m 進む間に落とす速さは、減速度で間に合う範囲
      expect(prev * prev - v * v).toBeLessThanOrEqual(2 * decel * 0.5 + 1e-3)
      prev = v
    }
  })

  it('実際に走らせると、半円の中では上限を大きく超えず、経路からも大きく外れない', () => {
    const radius = 4
    const path = uTurnPath(30, radius)
    const follower = new PathFollower(path, FAIRWAY_MOWER)
    const state = createVehicleState(0, 0, 0)
    const limit = Math.sqrt(DEFAULT_FOLLOWER.lateralAccel * radius)
    let worstSpeed = 0
    let worstOffset = 0
    for (let i = 0; i < 120 * 60; i++) {
      const out = follower.update(state)
      if (out.finished) break
      stepVehicle(state, out, FAIRWAY_MOWER, DT)
      // 半円の入口と出口の付近は、曲がり具合を前後 1 m で均すぶん上限が高めなので、中ほどだけを見る
      if (state.z > 30 + radius * 0.5) {
        worstSpeed = Math.max(worstSpeed, state.speed)
        worstOffset = Math.max(worstOffset, Math.abs(Math.hypot(state.x - radius, state.z - 30) - radius))
      }
    }
    expect(follower.progress).toBeGreaterThan(0.98)
    expect(worstSpeed).toBeLessThan(limit * 1.1)
    expect(worstOffset).toBeLessThan(0.6)
  })
})
