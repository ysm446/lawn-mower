import { describe, expect, it } from 'vitest'
import {
  blurDiameter,
  ev100,
  ev100FromLuminance,
  exposureFromEv100,
  horizontalFov,
  shutterTimeForEv100
} from './exposure'

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

describe('自動露出の計算', () => {
  it('測った輝度から決めた露出では、平均の明るさが輝度によらず一定になる', () => {
    const a = 4000 * exposureFromEv100(ev100FromLuminance(4000))
    const b = 250 * exposureFromEv100(ev100FromLuminance(250))
    expect(a).toBeCloseTo(b, 6)
    expect(a).toBeCloseTo(12.5 / 120, 6)
  })

  it('露出値からシャッター速度を求めると、元の露出値に戻る', () => {
    const t = shutterTimeForEv100(13.2, 5.6, 200)
    expect(ev100(5.6, t, 200)).toBeCloseTo(13.2, 6)
  })
})

describe('blurDiameter', () => {
  it('ピントを合わせた距離ではぼけず、離れるほどぼける', () => {
    expect(blurDiameter(50, 2.8, 10, 10)).toBeCloseTo(0, 9)
    expect(blurDiameter(50, 2.8, 10, 40)).toBeGreaterThan(blurDiameter(50, 2.8, 10, 20))
  })

  it('絞りを開けるほど、焦点距離が長いほどぼける', () => {
    expect(blurDiameter(50, 2.8, 10, 20)).toBeGreaterThan(blurDiameter(50, 8, 10, 20))
    expect(blurDiameter(100, 2.8, 10, 20)).toBeGreaterThan(blurDiameter(50, 2.8, 10, 20))
  })

  it('ミニチュア倍率を上げると、ほぼ倍率に比例してぼける', () => {
    const real = blurDiameter(50, 5.6, 60, 90)
    const mini = blurDiameter(50, 5.6, 60, 90, 20)
    expect(mini / real).toBeGreaterThan(20)
    expect(mini / real).toBeLessThan(21)
  })
})
