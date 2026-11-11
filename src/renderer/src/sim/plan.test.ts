import { describe, expect, it } from 'vitest'
import { CoverageGrid } from './coverage'
import { planCoverage, type PlanGrid, type PlanOptions } from './coveragePlan'
import { distanceToOutside } from './distance'
import { dubinsPath } from './dubins'
import { PathFollower } from './pathFollower'
import { Terrain } from './terrain'
import { FAIRWAY_MOWER, createVehicleState, deckSegment, minTurnRadius, stepVehicle } from './vehicle'
import { DEFAULT_ZONING, computeZoning } from './zoning'

const DT = 1 / 120

const OPTIONS: PlanOptions = {
  cutWidth: FAIRWAY_MOWER.cutWidth,
  overlap: 0.2,
  angleDeg: 0,
  headlandPasses: 3,
  turnRadius: minTurnRadius(FAIRWAY_MOWER) * 1.15,
  deckOffset: FAIRWAY_MOWER.deckOffset,
  runIn: 1
}

/** 経路を最後まで走らせ、刈った所を記録する */
function drive(
  grid: PlanGrid,
  options: PlanOptions,
  startX: number,
  startZ: number
): { coverage: CoverageGrid; finished: boolean; cutLength: number } {
  const plan = planCoverage(grid, options, startX, startZ, 0)
  const follower = new PathFollower(plan.path, FAIRWAY_MOWER)
  const state = createVehicleState(startX, startZ, 0)
  const size = (grid.samples - 1) * grid.cell
  const coverage = new CoverageGrid(grid.origin, grid.origin, size, size, 0.5)
  let finished = false
  const maxSteps = Math.ceil(((plan.cutLength + plan.transitLength) / 1.0) * 120)
  for (let i = 0; i < maxSteps && !finished; i++) {
    const out = follower.update(state)
    finished = out.finished
    state.deckDown = out.deckDown
    stepVehicle(state, out, FAIRWAY_MOWER, DT)
    if (state.deckDown) {
      const d = deckSegment(state, FAIRWAY_MOWER)
      coverage.markSegment(d.lx, d.lz, d.rx, d.rz)
    }
  }
  return { coverage, finished, cutLength: plan.cutLength }
}

/** mask の中で、刈られた割合 */
function coveredRatio(grid: PlanGrid, coverage: CoverageGrid): number {
  let inside = 0
  let covered = 0
  for (let iz = 0; iz < grid.samples; iz++) {
    for (let ix = 0; ix < grid.samples; ix++) {
      if (grid.mask[iz * grid.samples + ix] === 0) continue
      inside++
      if (coverage.isCovered(grid.origin + ix * grid.cell, grid.origin + iz * grid.cell)) covered++
    }
  }
  return covered / inside
}

describe('distanceToOutside', () => {
  it('範囲の外と格子の端までの距離になる', () => {
    const n = 11
    const mask = new Uint8Array(n * n).fill(1)
    mask[5 * n + 5] = 0
    const d = distanceToOutside(mask, n)
    expect(d[5 * n + 5]).toBe(0)
    expect(d[5 * n + 7]).toBeCloseTo(2)
    expect(d[7 * n + 6]).toBeCloseTo(Math.hypot(1, 2))
    // 格子の端の点は、外まで 1
    expect(d[0]).toBeCloseTo(1)
    expect(d[2 * n + 1]).toBeCloseTo(2)
  })
})

describe('dubinsPath', () => {
  it('どの組み合わせでも、目的の位置に目的の向きで着く', () => {
    const radius = 2.5
    let seed = 1
    const random = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 300; i++) {
      const x1 = (random() - 0.5) * 30
      const z1 = (random() - 0.5) * 30
      const h0 = random() * Math.PI * 2
      const h1 = random() * Math.PI * 2
      const { points, length } = dubinsPath(1, -2, h0, x1, z1, h1, radius, 0.05)
      const m = points.length
      expect(points[m - 2]).toBeCloseTo(x1, 3)
      expect(points[m - 1]).toBeCloseTo(z1, 3)
      // 最後の向き
      const heading = Math.atan2(points[m - 2] - points[m - 4], points[m - 1] - points[m - 3])
      expect(Math.cos(heading - h1)).toBeGreaterThan(0.999)
      // 最初の向き
      expect(Math.cos(Math.atan2(points[2] - points[0], points[3] - points[1]) - h0)).toBeGreaterThan(0.999)
      expect(length).toBeGreaterThanOrEqual(Math.hypot(x1 - 1, z1 + 2) - 1e-6)
    }
  })

  it('真後ろへの折り返しは、半円になる', () => {
    const { length } = dubinsPath(0, 0, 0, 6, 0, Math.PI, 3)
    expect(length).toBeCloseTo(Math.PI * 3, 4)
  })
})

describe('planCoverage と PathFollower', () => {
  it('四角い範囲を、往復刈りと外周刈りでほぼ刈り切る', () => {
    const n = 81
    const mask = new Uint8Array(n * n)
    for (let iz = 10; iz <= 70; iz++) for (let ix = 15; ix <= 65; ix++) mask[iz * n + ix] = 1
    const grid: PlanGrid = { samples: n, cell: 1, origin: -40, mask }
    const { coverage, finished } = drive(grid, OPTIONS, -10, -20)
    expect(finished).toBe(true)
    expect(coveredRatio(grid, coverage)).toBeGreaterThan(0.97)
  })

  it('穴とくびれのある範囲でも、最後まで走って大半を刈る', () => {
    const n = 121
    const mask = new Uint8Array(n * n)
    for (let iz = 5; iz <= 115; iz++) {
      for (let ix = 5; ix <= 115; ix++) {
        const hole = Math.hypot(ix - 40, iz - 45) < 12
        const notch = ix > 70 && iz > 50 && iz < 70
        if (!hole && !notch) mask[iz * n + ix] = 1
      }
    }
    const grid: PlanGrid = { samples: n, cell: 1, origin: -60, mask }
    const { coverage, finished } = drive(grid, { ...OPTIONS, angleDeg: 30 }, -40, -40)
    expect(finished).toBe(true)
    expect(coveredRatio(grid, coverage)).toBeGreaterThan(0.94)
  })

  it('手続き生成の地形の区分けから、経路が作れる', () => {
    const terrain = new Terrain({ seed: 7, size: 256, cell: 1 })
    const n = terrain.samples
    const zoning = computeZoning({ samples: n, cell: 1, heights: terrain.heights }, DEFAULT_ZONING, 107, 73)
    const mask = new Uint8Array(n * n)
    for (let i = 0; i < mask.length; i++) mask[i] = zoning.regions[zoning.labels[i]].reachable ? 1 : 0
    const plan = planCoverage({ samples: n, cell: 1, origin: terrain.origin, mask }, OPTIONS, -21, -55, 0)
    expect(plan.sweepCount).toBeGreaterThan(20)
    // 刈る距離 × 列の間隔が、届く範囲の面積におおよそ見合う
    const area = plan.cutLength * (OPTIONS.cutWidth - OPTIONS.overlap)
    expect(area / zoning.reachableArea).toBeGreaterThan(0.85)
    expect(area / zoning.reachableArea).toBeLessThan(1.35)
    expect(plan.transitLength).toBeLessThan(plan.cutLength * 0.5)
    for (const v of plan.path.points) expect(Number.isFinite(v)).toBe(true)
  })
})
