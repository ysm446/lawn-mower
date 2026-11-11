import { describe, expect, it } from 'vitest'
import {
  advanceHour,
  daylightHours,
  DECLINATION_DEG,
  formatHour,
  LATITUDE_DEG,
  MIN_SUN_ELEVATION_DEG,
  sunAngles
} from './sunPath'

describe('sunAngles', () => {
  it('南中の高度は 90° - 緯度 + 赤緯 になる', () => {
    expect(sunAngles(12).elevation).toBeCloseTo(90 - LATITUDE_DEG + DECLINATION_DEG, 6)
  })

  it('午前と午後で高度は対称になり、昼に向かって高くなる', () => {
    expect(sunAngles(9).elevation).toBeCloseTo(sunAngles(15).elevation, 6)
    expect(sunAngles(9).elevation).toBeGreaterThan(sunAngles(7).elevation)
  })

  it('朝 7 時半の太陽は、既定の向き(高度 28°、方位 125°)の近くに来る', () => {
    const sun = sunAngles(7.5)
    expect(Math.abs(sun.elevation - 28)).toBeLessThan(3)
    expect(Math.abs(sun.azimuth - 125)).toBeLessThan(3)
  })

  it('方位は一日を通して同じ向きに回る', () => {
    let previous = sunAngles(6).azimuth
    for (let hour = 6.5; hour <= 18; hour += 0.5) {
      const azimuth = sunAngles(hour).azimuth
      const step = (((previous - azimuth) % 360) + 360) % 360
      expect(step).toBeGreaterThan(0)
      expect(step).toBeLessThan(90)
      previous = azimuth
    }
  })
})

describe('daylightHours', () => {
  it('昼の時間帯の両端で、太陽の高度が下限になる', () => {
    const { start, end } = daylightHours()
    expect(sunAngles(start).elevation).toBeCloseTo(MIN_SUN_ELEVATION_DEG, 4)
    expect(sunAngles(end).elevation).toBeCloseTo(MIN_SUN_ELEVATION_DEG, 4)
    expect(start + end).toBeCloseTo(24, 6)
  })
})

describe('advanceHour', () => {
  it('昼の間は、進めた秒数だけ時刻が進む', () => {
    expect(advanceHour(9, 1800)).toBeCloseTo(9.5, 9)
  })

  it('日の入りを過ぎると、次の日の出へ飛ぶ', () => {
    const { start, end } = daylightHours()
    expect(advanceHour(end - 0.1, 720)).toBeCloseTo(start + 0.1, 9)
  })
})

describe('formatHour', () => {
  it('時と分にする', () => {
    expect(formatHour(7.5)).toBe('7:30')
    expect(formatHour(13 + 5 / 60)).toBe('13:05')
    expect(formatHour(9.9999)).toBe('10:00')
  })
})
