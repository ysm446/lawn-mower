import { describe, expect, it } from 'vitest'
import { buildThickArrow } from './thickArrow'

describe('buildThickArrow', () => {
  it('まっすぐな矢印は、帯の太さが一定で、矢じりは帯より幅が広い', () => {
    const arrow = buildThickArrow([0, 0, 0, 20], 1, 0.5)
    expect(arrow).not.toBeNull()
    if (!arrow) return
    expect(arrow.length).toBeCloseTo(20, 6)
    const left = arrow.outline.left
    // 帯の縁は中心から 0.5 m
    expect(Math.abs(left[0].x)).toBeCloseTo(0.5, 6)
    expect(Math.abs(left[3].x)).toBeCloseTo(0.5, 6)
    // 矢じりの角は 0.95 m、先端は中心で、終点にある
    const corner = left[left.length - 2]
    const tip = left[left.length - 1]
    expect(Math.abs(corner.x)).toBeCloseTo(0.95, 6)
    expect(tip.x).toBeCloseTo(0, 6)
    expect(tip.z).toBeCloseTo(20, 6)
    expect(tip.progress).toBeCloseTo(1, 6)
  })

  it('角のある道筋でも、進み具合は根元から先端へ増え続ける', () => {
    const arrow = buildThickArrow([0, 0, 10, 0, 10, 10], 0.8, 0.5)
    expect(arrow).not.toBeNull()
    if (!arrow) return
    const left = arrow.outline.left
    for (let i = 1; i < left.length; i++) {
      expect(left[i].progress).toBeGreaterThanOrEqual(left[i - 1].progress)
    }
    // 角を丸めた分、折れ線の長さ(20 m)より少し短い
    expect(arrow.length).toBeLessThan(20)
    expect(arrow.length).toBeGreaterThan(18.5)
  })

  it('点が足りないとき、長さがないときは作らない', () => {
    expect(buildThickArrow([1, 1], 1, 0.5)).toBeNull()
    expect(buildThickArrow([1, 1, 1, 1], 1, 0.5)).toBeNull()
  })
})
