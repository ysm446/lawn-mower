import { describe, expect, it } from 'vitest'
import { GrassField, LENGTH_FACTOR_MAX, LENGTH_FACTOR_MIN } from './grassField'

describe('GrassField', () => {
  const field = new GrassField({ seed: 7, size: 128, resolution: 256 })

  it('長さの倍率は決めた範囲に収まり、場所によって違う', () => {
    let lo = Infinity
    let hi = -Infinity
    for (let z = -60; z <= 60; z += 3) {
      for (let x = -60; x <= 60; x += 3) {
        const f = field.lengthFactorAt(x, z)
        lo = Math.min(lo, f)
        hi = Math.max(hi, f)
      }
    }
    expect(lo).toBeGreaterThanOrEqual(LENGTH_FACTOR_MIN)
    expect(hi).toBeLessThanOrEqual(LENGTH_FACTOR_MAX)
    expect(hi - lo).toBeGreaterThan(0.6)
  })

  it('同じシード値なら同じ値になり、範囲の外は端の値になる', () => {
    const same = new GrassField({ seed: 7, size: 128, resolution: 256 })
    expect(same.lengthFactorAt(12.3, -45.6)).toBe(field.lengthFactorAt(12.3, -45.6))
    expect(field.lengthFactorAt(500, 10)).toBeCloseTo(field.lengthFactorAt(63.9, 10), 1)
  })
})
