import { describe, expect, it } from 'vitest'
import { ev100, exposureFromEv100, horizontalFov } from './exposure'

describe('ev100', () => {
  it('F1.0、1 秒、ISO 100 で EV 0', () => {
    expect(ev100(1, 1, 100)).toBeCloseTo(0)
  })

  it('晴天の目安(F16、1/100 秒、ISO 100)は EV 14.6 前後', () => {
    expect(ev100(16, 1 / 100, 100)).toBeCloseTo(14.64, 1)
  })

  it('ISO を 2 倍にすると 1 段下がる', () => {
    expect(ev100(8, 1 / 250, 200)).toBeCloseTo(ev100(8, 1 / 250, 100) - 1)
  })
})

describe('exposureFromEv100', () => {
  it('EV が 1 上がると半分になり、補正 +1 で元に戻る', () => {
    const base = exposureFromEv100(12)
    expect(exposureFromEv100(13)).toBeCloseTo(base / 2)
    expect(exposureFromEv100(13, 1)).toBeCloseTo(base)
  })
})

describe('horizontalFov', () => {
  it('フルサイズの 18 mm で水平 90 度', () => {
    expect((horizontalFov(36, 18) * 180) / Math.PI).toBeCloseTo(90)
  })
})
