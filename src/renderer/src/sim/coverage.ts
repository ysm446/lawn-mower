// 刈り済み範囲を CPU 側で粗い格子として記録する。統計用。
// GPU 上の芝状態マップを読み戻さずに面積を求めるために持つ。
// 格子ごとに、どの向きで刈ったかを 2 つの印(ビット)で持つ。チェッカー刈りで、
// 1 回目の向き(CUT_ALONG)と 2 回目の向き(CUT_ACROSS)の、どちらを刈り終えたかを見分けるため。

/** 往復刈りの列の向きに沿って刈った印 */
export const CUT_ALONG = 1
/** 列の向きと直交する向きに刈った印 */
export const CUT_ACROSS = 2
/** どちらかの向きで刈った */
export const CUT_ANY = CUT_ALONG | CUT_ACROSS

export class CoverageGrid {
  readonly cols: number
  readonly rows: number
  private readonly cells: Uint8Array
  private covered = 0

  constructor(
    readonly originX: number,
    readonly originZ: number,
    readonly sizeX: number,
    readonly sizeZ: number,
    readonly cellSize: number
  ) {
    this.cols = Math.ceil(sizeX / cellSize)
    this.rows = Math.ceil(sizeZ / cellSize)
    this.cells = new Uint8Array(this.cols * this.rows)
  }

  /**
   * 線分(刈刃の左右端)が通った格子を刈り済みにする。bit は刈った向きの印。
   * 新しく刈り済みになった(どの向きでもまだ刈っていなかった)格子の数を返す
   */
  markSegment(ax: number, az: number, bx: number, bz: number, bit = CUT_ALONG): number {
    const before = this.covered
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.ceil(len / (this.cellSize * 0.5)))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      this.markPoint(ax + (bx - ax) * t, az + (bz - az) * t, bit)
    }
    return this.covered - before
  }

  markPoint(x: number, z: number, bit = CUT_ALONG): void {
    const col = Math.floor((x - this.originX) / this.cellSize)
    const row = Math.floor((z - this.originZ) / this.cellSize)
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return
    const i = row * this.cols + col
    if (this.cells[i] === 0) this.covered++
    this.cells[i] |= bit
  }

  /** その地点を刈ったか。bits を渡すと、その向きの印のどれかがあるかを見る(既定はどの向きでも) */
  isCovered(x: number, z: number, bits = CUT_ANY): boolean {
    return (this.bitsAt(x, z) & bits) !== 0
  }

  /** その地点の、刈った向きの印 */
  bitsAt(x: number, z: number): number {
    const col = Math.floor((x - this.originX) / this.cellSize)
    const row = Math.floor((z - this.originZ) / this.cellSize)
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0
    return this.cells[row * this.cols + col]
  }

  /** 刈り済みの面積(m²) */
  get coveredArea(): number {
    return this.covered * this.cellSize * this.cellSize
  }

  reset(): void {
    this.cells.fill(0)
    this.covered = 0
  }
}
