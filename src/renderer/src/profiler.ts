// 動作確認用: どこが重いかを測る(?profile=1)。
// 1 フレームの処理を区間に分け、区間ごとに CPU の時間(performance.now)と GPU の時間(タイマークエリ)を測る。
// 機能を 1 つずつ止めた状態(変種)を順に作り、それぞれ数秒ずつ測って、最後に表をログに出す。
// 区間は入れ子にしない(GPU のタイマークエリは同時に 1 つしか測れない)。

const GPU_EXT = 'EXT_disjoint_timer_query_webgl2'

interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

interface Totals {
  cpu: number
  gpu: number
  gpuCount: number
}

interface Variant {
  name: string
  /** この変種にする。返す関数で元に戻す */
  apply: () => () => void
}

export interface ProfilerOptions {
  /** 測り始めるまでの待ち時間(秒)。読み込み直後の重い処理を外す */
  warmup: number
  /** 変種ごとに、慣らす時間と測る時間(秒) */
  settle: number
  measure: number
  variants: Variant[]
  /** 測り終えたら呼ぶ。表の文字列を渡す */
  onDone: (report: string) => void
}

export class Profiler {
  private readonly ext: TimerExt | null
  private readonly pending: { query: WebGLQuery; name: string; variant: number }[] = []
  private readonly totals: Map<string, Totals>[] = []
  private readonly frameCounts: number[] = []
  private readonly frameTimes: number[] = []
  private current: { name: string; start: number; query: WebGLQuery | null } | null = null
  private time = 0
  private variant = -1
  private restore: (() => void) | null = null
  private done = false

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly options: ProfilerOptions
  ) {
    this.ext = gl.getExtension(GPU_EXT) as TimerExt | null
    for (let i = 0; i < options.variants.length; i++) {
      this.totals.push(new Map())
      this.frameCounts.push(0)
      this.frameTimes.push(0)
    }
  }

  /** 区間を始める。前の区間が開いていれば閉じる */
  begin(name: string): void {
    this.end()
    if (!this.measuring) return
    let query: WebGLQuery | null = null
    if (this.ext) {
      query = this.gl.createQuery()
      if (query) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    }
    this.current = { name, start: performance.now(), query }
  }

  end(): void {
    const c = this.current
    if (!c) return
    this.current = null
    const cpu = performance.now() - c.start
    if (c.query && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.pending.push({ query: c.query, name: c.name, variant: this.variant })
    }
    this.entry(this.variant, c.name).cpu += cpu
  }

  /** フレームの終わりに呼ぶ。dt は前のフレームからの時間(秒) */
  frame(dt: number): void {
    this.end()
    this.collect()
    if (this.done) return
    if (this.measuring) {
      this.frameCounts[this.variant]++
      this.frameTimes[this.variant] += dt
    }
    this.time += dt
    const { warmup, settle, measure, variants } = this.options
    const slot = settle + measure
    const index = this.time < warmup ? -1 : Math.floor((this.time - warmup) / slot)
    const phase = this.time < warmup ? 0 : (this.time - warmup) % slot
    if (index !== this.variant && index < variants.length) {
      this.restore?.()
      this.variant = index
      this.restore = variants[index].apply()
    }
    this.measuringNow = index >= 0 && index < variants.length && phase >= settle
    if (index >= variants.length && this.pending.length === 0) {
      this.restore?.()
      this.restore = null
      this.done = true
      this.options.onDone(this.report())
    }
  }

  private measuringNow = false
  private get measuring(): boolean {
    return this.measuringNow && !this.done
  }

  private entry(variant: number, name: string): Totals {
    const map = this.totals[variant]
    let t = map.get(name)
    if (!t) {
      t = { cpu: 0, gpu: 0, gpuCount: 0 }
      map.set(name, t)
    }
    return t
  }

  /** 結果の出たタイマークエリを読む */
  private collect(): void {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.pending.length > 0) {
      const p = this.pending[0]
      if (!disjoint && !gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break
      this.pending.shift()
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number
        const t = this.entry(p.variant, p.name)
        t.gpu += ns / 1e6
        t.gpuCount++
      }
      gl.deleteQuery(p.query)
    }
  }

  private report(): string {
    const lines: string[] = []
    lines.push(`GPU タイマー: ${this.ext ? 'あり' : 'なし(CPU だけ)'}`)
    this.options.variants.forEach((variant, i) => {
      const frames = this.frameCounts[i]
      if (frames === 0) return
      const fps = frames / this.frameTimes[i]
      let cpuSum = 0
      let gpuSum = 0
      const rows: string[] = []
      for (const [name, t] of this.totals[i]) {
        const cpu = t.cpu / frames
        // 1 フレームに何度も始まる区間があるので、フレーム数で割る(測り終える前に結果はすべて読んでいる)
        const gpu = t.gpu / frames
        cpuSum += cpu
        gpuSum += gpu
        rows.push(`    ${name.padEnd(14)} CPU ${cpu.toFixed(2).padStart(6)} ms   GPU ${gpu.toFixed(2).padStart(6)} ms`)
      }
      lines.push(
        `[${variant.name}] ${fps.toFixed(1)} fps  CPU 計 ${cpuSum.toFixed(2)} ms  GPU 計 ${gpuSum.toFixed(2)} ms`
      )
      lines.push(...rows)
    })
    return lines.join('\n')
  }
}
