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

  it('斜めに見下ろした線が地面に当たる距離を求める。空へ向けた線は上限を返す', () => {
    const py = terrain.heightAt(10, 10) + 30
    const d = { x: 0.6, y: -0.64, z: 0.48 }
    const t = terrain.rayDistance(10, py, 10, d.x, d.y, d.z, 1000)
    expect(t).toBeGreaterThan(10)
    expect(t).toBeLessThan(1000)
    // 当たった点は地面の上にある
    expect(py + d.y * t).toBeCloseTo(terrain.heightAt(10 + d.x * t, 10 + d.z * t), 1)
    expect(terrain.rayDistance(10, py, 10, 0, 1, 0, 1000)).toBe(1000)
  })

  it('進行方向の傾きは、向きを反転すると符号が変わる', () => {
    const up = terrain.gradeAlong(20, 20, 0.7)
    const down = terrain.gradeAlong(20, 20, 0.7 + Math.PI)
    expect(up).toBeCloseTo(-down, 6)
  })
})
