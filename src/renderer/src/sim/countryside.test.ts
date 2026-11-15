import { describe, expect, it } from 'vitest'
import { Terrain } from './terrain'
import { findMap } from './maps'
import { createCountryside, countrysidePlots, roadOffset } from './countryside'
import { computeZoning, DEFAULT_ZONING } from './zoning'

describe('田園丘陵', () => {
  const map = findMap('countryside')
  const terrain = new Terrain({ seed: map.seed, size: 512, cell: 1, shape: map.shape })
  const farm = createCountryside(terrain)

  it('八つの土地を持ち、農道を刈る区画に含めない', () => {
    const n = terrain.samples
    const zones = computeZoning({ samples: n, cell: 1, heights: terrain.heights }, DEFAULT_ZONING, 46, 236)
    const reach = Uint8Array.from(zones.labels, (label) => zones.regions[label].reachable ? 1 : 0)
    const result = countrysidePlots(farm, reach, n, 1)
    expect(result.plots.length).toBe(8)
    const lands = new Map<number, Set<number>>()
    for (let i = 0; i < result.labels.length; i++) {
      const plot = result.labels[i]
      if (farm.surface[i * 4 + 2] > 0) expect(plot).toBe(-1)
      if (plot < 0) continue
      const ids = lands.get(plot) ?? new Set<number>()
      ids.add(farm.parcels[i])
      lands.set(plot, ids)
    }
    expect([...lands.values()].every((ids) => ids.size === 1)).toBe(true)
    expect(result.plots.every((plot) => plot.area > 1000)).toBe(true)
  })

  it('ならした農道にも急な上り下りがなく、起点と終点が保たれる', () => {
    for (const road of farm.roads) {
      expect(roadOffset(road, -230)).toBe(roadOffset(road, 230))
      let maxGrade = 0
      for (let s = -230; s < 230; s++) {
        const a = roadOffset(road, s), b = roadOffset(road, s + 1)
        const h0 = road.vertical ? terrain.heightAt(a, s) : terrain.heightAt(s, a)
        const h1 = road.vertical ? terrain.heightAt(b, s + 1) : terrain.heightAt(s + 1, b)
        maxGrade = Math.max(maxGrade, Math.abs(h1 - h0) / Math.hypot(1, b - a))
      }
      expect(maxGrade).toBeLessThan(0.25)
    }
  })

  it('既存の既定マップを変えず、土地配置を再現できる', () => {
    expect(findMap(null).id).toBe('hills')
    expect(createCountryside(terrain).parcels).toEqual(farm.parcels)
  })
})
