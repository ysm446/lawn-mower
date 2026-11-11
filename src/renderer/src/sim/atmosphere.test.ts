import { describe, expect, it } from 'vitest'
import {
  MIE_BETA,
  MIE_EXTINCTION,
  MIE_HEIGHT,
  RAYLEIGH_BETA,
  RAYLEIGH_HEIGHT,
  sunTransmittance
} from './atmosphere'

describe('sunTransmittance', () => {
  it('真上の太陽では、密度を真上へ積分した解析解に近い', () => {
    const haze = 3
    const [r, g, b] = sunTransmittance(90, haze, 1)
    // 指数で薄くなる層を真上へ積分すると、係数 × 高さ(大気の上端で打ち切る分は小さい)
    const expected = (beta: number): number =>
      Math.exp(-beta * RAYLEIGH_HEIGHT - MIE_BETA * haze * MIE_EXTINCTION * MIE_HEIGHT)
    expect(r).toBeCloseTo(expected(RAYLEIGH_BETA[0]), 2)
    expect(g).toBeCloseTo(expected(RAYLEIGH_BETA[1]), 2)
    expect(b).toBeCloseTo(expected(RAYLEIGH_BETA[2]), 2)
  })

  it('青ほど弱まり、太陽が低いほど弱まって赤みが増す', () => {
    const high = sunTransmittance(60, 3)
    const low = sunTransmittance(5, 3)
    expect(high[0]).toBeGreaterThan(high[1])
    expect(high[1]).toBeGreaterThan(high[2])
    for (let c = 0; c < 3; c++) expect(low[c]).toBeLessThan(high[c])
    expect(low[0] / low[2]).toBeGreaterThan(high[0] / high[2])
  })

  it('霞が濃いほど弱まる', () => {
    const clear = sunTransmittance(30, 1)
    const hazy = sunTransmittance(30, 8)
    for (let c = 0; c < 3; c++) expect(hazy[c]).toBeLessThan(clear[c])
  })

  it('地平線の下の太陽からは、光が届かない', () => {
    expect(sunTransmittance(-5, 3)).toEqual([0, 0, 0])
  })
})
