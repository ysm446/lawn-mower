import { describe, expect, it } from 'vitest'
import { CoverageGrid } from './coverage'
import {
  FAIRWAY_MOWER,
  createVehicleState,
  deckSegment,
  minTurnRadius,
  stepVehicle
} from './vehicle'

const DT = 1 / 120

describe('stepVehicle', () => {
  it('前進の入力で +Z に進み、最高速度で頭打ちになる', () => {
    const s = createVehicleState()
    for (let i = 0; i < 120 * 10; i++) stepVehicle(s, { throttle: 1, steer: 0 }, FAIRWAY_MOWER, DT)
    expect(s.speed).toBeCloseTo(FAIRWAY_MOWER.maxSpeed, 5)
    expect(s.z).toBeGreaterThan(20)
    expect(s.x).toBeCloseTo(0, 6)
    expect(s.heading).toBeCloseTo(0, 6)
  })

  it('斜面では、水平方向に進む距離が傾きの分だけ短くなる', () => {
    const flat = createVehicleState()
    const slope = createVehicleState()
    for (let i = 0; i < 120 * 10; i++) {
      stepVehicle(flat, { throttle: 1, steer: 0 }, FAIRWAY_MOWER, DT)
      stepVehicle(slope, { throttle: 1, steer: 0 }, FAIRWAY_MOWER, DT, Math.tan(Math.PI / 6))
    }
    expect(slope.z / flat.z).toBeCloseTo(Math.cos(Math.PI / 6), 6)
  })

  it('左いっぱいに切ると、最小旋回半径の円を左回りに描く', () => {
    const s = createVehicleState()
    let maxX = 0
    for (let i = 0; i < 120 * 30; i++) {
      stepVehicle(s, { throttle: 0.5, steer: 1 }, FAIRWAY_MOWER, DT)
      maxX = Math.max(maxX, s.x)
    }
    expect(s.heading).toBeGreaterThan(0)
    // 操舵が切れるまでの助走分だけ円より少し大きくなる
    const diameter = 2 * minTurnRadius(FAIRWAY_MOWER)
    expect(maxX).toBeGreaterThan(diameter * 0.95)
    expect(maxX).toBeLessThan(diameter * 1.4)
  })

  it('入力をやめると止まる', () => {
    const s = createVehicleState()
    for (let i = 0; i < 600; i++) stepVehicle(s, { throttle: 1, steer: 0 }, FAIRWAY_MOWER, DT)
    for (let i = 0; i < 600; i++) stepVehicle(s, { throttle: 0, steer: 0 }, FAIRWAY_MOWER, DT)
    expect(s.speed).toBe(0)
  })
})

describe('deckSegment', () => {
  it('刈刃は機体の前方にあり、幅は刈り幅に等しい', () => {
    const s = createVehicleState(10, 20, 0)
    const d = deckSegment(s, FAIRWAY_MOWER)
    expect(d.lz).toBeCloseTo(20 + FAIRWAY_MOWER.deckOffset)
    expect(d.rz).toBeCloseTo(20 + FAIRWAY_MOWER.deckOffset)
    // heading = 0 では左が +X
    expect(d.lx - d.rx).toBeCloseTo(FAIRWAY_MOWER.cutWidth)
  })
})

describe('CoverageGrid', () => {
  it('通った格子だけを数え、重ねても増えない', () => {
    const g = new CoverageGrid(0, 0, 10, 10, 0.5)
    g.markSegment(0.1, 0.25, 2.9, 0.25)
    expect(g.coveredArea).toBeCloseTo(6 * 0.25)
    g.markSegment(0.1, 0.25, 2.9, 0.25)
    expect(g.coveredArea).toBeCloseTo(6 * 0.25)
    expect(g.isCovered(1, 0.25)).toBe(true)
    expect(g.isCovered(1, 5)).toBe(false)
  })

  it('範囲外は無視する', () => {
    const g = new CoverageGrid(0, 0, 10, 10, 0.5)
    g.markSegment(-5, -5, -1, -1)
    expect(g.coveredArea).toBe(0)
  })
})
