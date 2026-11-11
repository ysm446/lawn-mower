import { describe, expect, it } from 'vitest'
import { Terrain, terrainHeight } from './terrain'

const DEG = Math.PI / 180

describe('Terrain', () => {
  const terrain = new Terrain({ seed: 7, size: 256, cell: 1 })

  it('同じシード値なら同じ地形、違うシード値なら違う地形になる', () => {
    const same = new Terrain({ seed: 7, size: 256, cell: 1 })
    const other = new Terrain({ seed: 8, size: 256, cell: 1 })
    expect(Array.from(same.heights.slice(0, 500))).toEqual(Array.from(terrain.heights.slice(0, 500)))
    expect(other.heightAt(30, 40)).not.toBeCloseTo(terrain.heightAt(30, 40), 3)
  })

  it('格子点では式の値と一致し、格子の中は滑らかに補間される', () => {
    expect(terrain.heightAt(12, -31)).toBeCloseTo(terrainHeight(12, -31, 7), 4)
    // 格子の間でも、式の値との差は小さい
    expect(Math.abs(terrain.heightAt(12.5, -30.5) - terrainHeight(12.5, -30.5, 7))).toBeLessThan(0.02)
  })

  it('格子の外でも高さが切れ目なく続く', () => {
    const edge = 128
    expect(terrain.heightAt(edge + 0.001, 10)).toBeCloseTo(terrain.heightAt(edge - 0.001, 10), 2)
  })

  it('刈る範囲に、平らに近い所と急な斜面の両方がある', () => {
    let gentle = 0
    let steep = 0
    let tooSteep = 0
    let count = 0
    for (let z = -126; z <= 126; z += 2) {
      for (let x = -126; x <= 126; x += 2) {
        const slope = terrain.slopeAt(x, z)
        if (slope <= 15 * DEG) gentle++
        else if (slope <= 30 * DEG) steep++
        else tooSteep++
        count++
      }
    }
    expect(gentle / count).toBeGreaterThan(0.4)
    expect(steep / count).toBeGreaterThan(0.08)
    // なだらかな丘なので、刈れないほど急な所はわずか
    expect(tooSteep / count).toBeLessThan(0.1)
  })

  it('進行方向の傾きは、向きを反転すると符号が変わる', () => {
    const up = terrain.gradeAlong(20, 20, 0.7)
    const down = terrain.gradeAlong(20, 20, 0.7 + Math.PI)
    expect(up).toBeCloseTo(-down, 6)
  })
})
