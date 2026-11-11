import { describe, expect, it } from 'vitest'
import { Terrain } from './terrain'
import {
  DEFAULT_ZONING,
  ZONE_NONE,
  ZONE_RIDE,
  ZONE_SLOPE,
  computeSlopeDeg,
  computeZoning,
  loopArea,
  simplifyLoop,
  traceRegion,
  type HeightGrid
} from './zoning'

/** x 方向に、左から 平ら → 20° → 40° と傾きが変わる地形 */
function steppedGrid(n: number): HeightGrid {
  const heights = new Float32Array(n * n)
  const third = Math.floor(n / 3)
  for (let iz = 0; iz < n; iz++) {
    let h = 0
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = h
      const deg = ix < third ? 0 : ix < third * 2 ? 20 : 40
      h += Math.tan((deg * Math.PI) / 180)
    }
  }
  return { samples: n, cell: 1, heights }
}

describe('computeSlopeDeg', () => {
  it('一定の傾きの面では、その角度になる', () => {
    const n = 20
    const heights = new Float32Array(n * n)
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) heights[iz * n + ix] = ix * 2 * Math.tan(Math.PI / 9)
    }
    const slope = computeSlopeDeg({ samples: n, cell: 2, heights }, 0)
    expect(slope[5 * n + 7]).toBeCloseTo(20, 4)
    expect(slope[0]).toBeCloseTo(20, 4)
  })
})

describe('computeZoning', () => {
  const options = { ...DEFAULT_ZONING, smoothRadius: 0, majorityRadius: 0, minArea: 0 }

  it('勾配の閾値で 3 つの区分に分かれる', () => {
    const n = 60
    const result = computeZoning(steppedGrid(n), options, 5, 30)
    expect(result.zones[30 * n + 5]).toBe(ZONE_RIDE)
    expect(result.zones[30 * n + 30]).toBe(ZONE_SLOPE)
    expect(result.zones[30 * n + 55]).toBe(ZONE_NONE)
    expect(result.regions).toHaveLength(3)
    expect(result.zoneArea.reduce((a, b) => a + b)).toBe(n * n)
    expect(result.reachableArea).toBe(result.zoneArea[ZONE_RIDE])
  })

  it('狭い領域は周りに吸収され、出発点から届かない平地は届かない扱いになる', () => {
    const n = 60
    const grid = steppedGrid(n)
    // 20° の斜面の中に、平らな小さい棚(3 マス四方)と大きい棚(10 マス四方)を作る
    const flatten = (x0: number, z0: number, size: number): void => {
      for (let iz = z0; iz < z0 + size; iz++) {
        for (let ix = x0; ix < x0 + size; ix++) grid.heights[iz * n + ix] = grid.heights[z0 * n + x0]
      }
    }
    flatten(26, 10, 4)
    flatten(25, 35, 11)
    const result = computeZoning(grid, { ...options, minArea: 30 }, 5, 30)
    expect(result.zones[11 * n + 27]).toBe(ZONE_SLOPE)
    expect(result.zones[40 * n + 30]).toBe(ZONE_RIDE)
    const shelf = result.regions[result.labels[40 * n + 30]]
    expect(shelf.reachable).toBe(false)
    expect(result.reachableArea).toBeLessThan(result.zoneArea[ZONE_RIDE])
  })

  it('手続き生成の地形で、領域がまとまった形になる', () => {
    const terrain = new Terrain({ seed: 7, size: 256, cell: 1 })
    const result = computeZoning(
      { samples: terrain.samples, cell: 1, heights: terrain.heights },
      DEFAULT_ZONING,
      107,
      73
    )
    expect(result.zoneArea[ZONE_RIDE]).toBeGreaterThan(result.zoneArea[ZONE_SLOPE])
    expect(result.zoneArea[ZONE_SLOPE]).toBeGreaterThan(0)
    for (const region of result.regions) expect(region.area).toBeGreaterThanOrEqual(DEFAULT_ZONING.minArea)
    expect(result.regions.length).toBeLessThan(40)
  })
})

describe('traceRegion', () => {
  it('穴のある領域は、外周(正の面積)と穴(負の面積)になり、合計がマスの数に一致する', () => {
    const n = 12
    const labels = new Int32Array(n * n)
    let cells = 0
    for (let iz = 2; iz < 10; iz++) {
      for (let ix = 3; ix < 9; ix++) {
        const hole = iz >= 5 && iz < 7 && ix >= 5 && ix < 7
        if (!hole) {
          labels[iz * n + ix] = 1
          cells++
        }
      }
    }
    const loops = traceRegion(labels, n, 1)
    expect(loops).toHaveLength(2)
    const areas = loops.map(loopArea).sort((a, b) => a - b)
    expect(areas[0]).toBe(-4)
    expect(areas[1]).toBe(48)
    expect(areas[0] + areas[1]).toBe(cells)
    // 長方形なので、頂点は 4 つずつ
    for (const loop of loops) expect(loop.length).toBe(8)
  })

  it('斜めに接するだけのマスは、別々の輪郭になる', () => {
    const n = 4
    const labels = new Int32Array(n * n)
    labels[1 * n + 1] = 1
    labels[2 * n + 2] = 1
    const loops = traceRegion(labels, n, 1)
    expect(loops).toHaveLength(2)
    for (const loop of loops) expect(loopArea(loop)).toBe(1)
  })
})

describe('simplifyLoop', () => {
  it('階段状の斜めの辺を、ずれの範囲内でまっすぐにする', () => {
    const n = 40
    const labels = new Int32Array(n * n)
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) if (ix + iz < 30) labels[iz * n + ix] = 1
    }
    const loop = traceRegion(labels, n, 1)[0]
    const simple = simplifyLoop(loop, 1)
    expect(loop.length / 2).toBeGreaterThan(50)
    expect(simple.length / 2).toBeLessThan(8)
    expect(Math.abs(loopArea(simple) - loopArea(loop))).toBeLessThan(40)
  })
})
