import { describe, expect, it } from 'vitest'
import { findMap } from './maps'
import { blockedByTrees, clearingRadiusAt, generateTrees, inForest } from './trees'
import { Terrain } from './terrain'
import { DEFAULT_ZONING, ZONE_NONE, computeZoning } from './zoning'

const map = findMap('meadow')
const spec = map.trees!

describe('樹木の配置', () => {
  const trees = generateTrees(spec, map.seed, map.startX, map.startZ)

  it('同じシード値なら同じ配置になる', () => {
    const again = generateTrees(spec, map.seed, map.startX, map.startZ)
    expect(again.length).toBe(trees.length)
    expect(again[10]).toEqual(trees[10])
  })

  it('林の木は空き地の外に、1 本立ちの木は空き地の中にある', () => {
    const lone = trees.filter((t) => t.lone)
    expect(lone).toHaveLength(spec.lone)
    for (const tree of trees) {
      expect(inForest(spec, map.seed, tree.x, tree.z)).toBe(!tree.lone)
    }
    // 出発点の近くには立てない
    for (const tree of lone) {
      expect(Math.hypot(tree.x - map.startX, tree.z - map.startZ)).toBeGreaterThan(14)
    }
  })

  it('空き地の半径は、決めた幅の中で方角によって変わる', () => {
    let lo = Infinity
    let hi = -Infinity
    for (let a = 0; a < 360; a += 5) {
      const r = clearingRadiusAt(spec, map.seed, Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180))
      lo = Math.min(lo, r)
      hi = Math.max(hi, r)
    }
    expect(lo).toBeGreaterThan(spec.clearingRadius - spec.variation * 1.6)
    expect(hi).toBeLessThan(spec.clearingRadius + spec.variation * 1.6)
    expect(hi - lo).toBeGreaterThan(8)
  })

  it('区分けでは、林と木のまわりが「刈らない」になり、出発点から空き地に届く', () => {
    const terrain = new Terrain({ seed: map.seed, size: 256, cell: 1, shape: map.shape })
    const n = terrain.samples
    const blocked = blockedByTrees(trees, spec, map.seed, n, 1, terrain.origin)
    const startIx = Math.round(map.startX - terrain.origin)
    const startIz = Math.round(map.startZ - terrain.origin)
    const result = computeZoning(
      { samples: n, cell: 1, heights: terrain.heights },
      DEFAULT_ZONING,
      startIx,
      startIz,
      blocked
    )
    // 林の奥
    expect(result.zones[10 * n + 10]).toBe(ZONE_NONE)
    // 1 本立ちの木の根元
    const lone = trees.find((t) => t.lone)!
    const ix = Math.round(lone.x - terrain.origin)
    const iz = Math.round(lone.z - terrain.origin)
    expect(result.zones[iz * n + ix]).toBe(ZONE_NONE)
    // 空き地の大半に届く(半径 62 m の円の面積の 6 割以上)
    expect(result.reachableArea).toBeGreaterThan(Math.PI * 62 * 62 * 0.6)
  })
})
