import { describe, expect, it } from 'vitest'
import { DEFAULT_PLOTS, clusterPlots, type PlotResult } from './plots'

/** 一辺 n の格子で、heightAt の形の地形と、inside の範囲を作って区画に分ける */
function cluster(
  n: number,
  targetArea: number,
  heightAt: (ix: number, iz: number) => number = () => 0,
  inside: (ix: number, iz: number) => boolean = () => true
): { result: PlotResult; mask: Uint8Array } {
  const mask = new Uint8Array(n * n)
  const heights = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      mask[iz * n + ix] = inside(ix, iz) ? 1 : 0
      heights[iz * n + ix] = heightAt(ix, iz)
    }
  }
  const result = clusterPlots(mask, heights, n, 1, { ...DEFAULT_PLOTS, targetArea }, 2, 2)
  return { result, mask }
}

/** 区画ごとに、ひとつながりになっているかを調べる */
function connected(result: PlotResult): boolean {
  const { labels, samples: n, plots } = result
  for (const plot of plots) {
    const start = labels.indexOf(plot.id)
    const seen = new Uint8Array(labels.length)
    const stack = [start]
    seen[start] = 1
    let reached = 0
    while (stack.length > 0) {
      const i = stack.pop() as number
      reached++
      const ix = i % n
      for (const j of [ix > 0 ? i - 1 : -1, ix < n - 1 ? i + 1 : -1, i - n, i + n]) {
        if (j < 0 || j >= labels.length || seen[j] === 1 || labels[j] !== plot.id) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (reached !== Math.round(plot.area)) return false
  }
  return true
}

describe('clusterPlots', () => {
  it('刈る範囲の点はすべてどれかの区画に入り、範囲の外は -1 になる', () => {
    const { result, mask } = cluster(80, 1600, undefined, (ix, iz) => Math.hypot(ix - 40, iz - 40) < 36)
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) expect(result.labels[i]).toBeGreaterThanOrEqual(0)
      else expect(result.labels[i]).toBe(-1)
    }
  })

  it('区画の数は、面積を広さの目安で割った数に近い', () => {
    const { result } = cluster(80, 1600)
    expect(result.plots.length).toBeGreaterThanOrEqual(3)
    expect(result.plots.length).toBeLessThanOrEqual(4)
    const total = result.plots.reduce((sum, plot) => sum + plot.area, 0)
    expect(total).toBe(80 * 80)
  })

  it('広さの目安が範囲より広ければ、区画は 1 つになる', () => {
    const { result } = cluster(60, 100000)
    expect(result.plots.length).toBe(1)
    expect(result.plots[0].area).toBe(3600)
  })

  it('どの区画もひとつながりで、狭すぎる区画は残らない', () => {
    // 入り組んだ形: 中央に壁のある範囲と、うねった地形
    const { result } = cluster(
      96,
      1200,
      (ix, iz) => Math.sin(ix * 0.15) * 4 + Math.cos(iz * 0.11) * 3,
      (ix, iz) => !(ix > 44 && ix < 52 && iz < 70)
    )
    expect(result.plots.length).toBeGreaterThan(2)
    expect(connected(result)).toBe(true)
    for (const plot of result.plots) expect(plot.area).toBeGreaterThanOrEqual(1200 * 0.3)
  })

  it('出発点のある区画が最初になり、番号は刈る順に続く', () => {
    const { result } = cluster(80, 1600)
    expect(result.labels[2 * 80 + 2]).toBe(0)
    expect(result.plots.map((plot) => plot.id)).toEqual(result.plots.map((_, i) => i))
  })

  it('屋根の形の地形では、棟(斜面の向きの変わり目)が区画の境目になる', () => {
    // x = 40 を棟とする、両側へ下る屋根
    const { result } = cluster(80, 3200, (ix) => -Math.abs(ix - 40) * 0.2)
    expect(result.plots.length).toBe(2)
    // 棟から離れた点は、棟の同じ側ならどれも同じ区画に入る
    const left = result.labels[40 * 80 + 10]
    const right = result.labels[40 * 80 + 70]
    expect(left).not.toBe(right)
    for (const iz of [5, 40, 75]) {
      expect(result.labels[iz * 80 + 30]).toBe(left)
      expect(result.labels[iz * 80 + 50]).toBe(right)
    }
  })

  it('同じ入力なら、いつも同じ結果になる', () => {
    const a = cluster(64, 900, (ix, iz) => Math.sin(ix * 0.2) * 2 + iz * 0.05).result
    const b = cluster(64, 900, (ix, iz) => Math.sin(ix * 0.2) * 2 + iz * 0.05).result
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels))
  })
})
