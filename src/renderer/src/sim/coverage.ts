// 刈り済み範囲を CPU 側で粗い格子として記録する。統計用。
// GPU 上の芝状態マップを読み戻さずに面積を求めるために持つ。

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

  /** 線分(刈刃の左右端)が通った格子を刈り済みにする */
  markSegment(ax: number, az: number, bx: number, bz: number): void {
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.ceil(len / (this.cellSize * 0.5)))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      this.markPoint(ax + (bx - ax) * t, az + (bz - az) * t)
    }
  }

  markPoint(x: number, z: number): void {
    const col = Math.floor((x - this.originX) / this.cellSize)
    const row = Math.floor((z - this.originZ) / this.cellSize)
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return
    const i = row * this.cols + col
    if (this.cells[i] === 0) {
      this.cells[i] = 1
      this.covered++
    }
  }

  isCovered(x: number, z: number): boolean {
    const col = Math.floor((x - this.originX) / this.cellSize)
    const row = Math.floor((z - this.originZ) / this.cellSize)
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false
    return this.cells[row * this.cols + col] === 1
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
