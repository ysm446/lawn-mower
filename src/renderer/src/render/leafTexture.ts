// 葉の絵のテクスチャ。小枝 1 本ぶんの葉を、透明な地に描く。画像ファイルは使わず、起動時に描いて作る。
// 色は明るい灰緑で描いておき、木ごとの色を掛けて使う。
// あわせて、きらめき用の隠しテクスチャ(glint)に、同じ形の葉を同じ位置に描く。色の代わりに
// R、G に葉ごとの乱数、B に「葉がある」(1)を書く。縁では背景の黒と混ざって 3 つとも同じ割合で小さくなるので、
// シェーダーで R、G を B で割ると、縁でも葉の乱数が戻る。これで、照り返しが葉 1 枚の形のまま光る

import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace } from 'three'

/** 葉の絵と、きらめき用の隠しテクスチャ */
export interface LeafTextures {
  map: CanvasTexture
  glint: CanvasTexture
}

const SIZE = 256

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function finish(canvas: HTMLCanvasElement, color = true): CanvasTexture {
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = color ? SRGBColorSpace : NoColorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  return texture
}

/** 葉の絵と、きらめき用の隠しテクスチャのキャンバス(きらめき用は黒で塗っておく) */
function canvases(): { g: CanvasRenderingContext2D; glint: CanvasRenderingContext2D } {
  const make = (): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    return canvas.getContext('2d') as CanvasRenderingContext2D
  }
  const g = make()
  const glint = make()
  glint.fillStyle = 'rgb(0, 0, 0)'
  glint.fillRect(0, 0, SIZE, SIZE)
  return { g, glint }
}

/** きらめき用の隠しテクスチャに書く色(葉ごとの乱数 2 つと、「葉がある」の印) */
function glintStyle(next: () => number): string {
  return `rgb(${Math.round(next() * 255)}, ${Math.round(next() * 255)}, 255)`
}

/** 葉の形の道筋を作る。(0, 0) が付け根で、+x へ伸びる */
function leafOutline(g: CanvasRenderingContext2D, length: number): void {
  const width = length * 0.44
  g.beginPath()
  g.moveTo(0, 0)
  g.bezierCurveTo(length * 0.25, -width, length * 0.75, -width * 0.8, length, 0)
  g.bezierCurveTo(length * 0.75, width * 0.8, length * 0.25, width, 0, 0)
}

/** 葉を 1 枚描く。(x, y) が付け根、angle が伸びる向き。glintColor で、きらめき用にも同じ形を描く */
function drawLeaf(
  g: CanvasRenderingContext2D,
  glint: CanvasRenderingContext2D,
  glintColor: string,
  x: number,
  y: number,
  angle: number,
  length: number,
  shade: number
): void {
  glint.save()
  glint.translate(x, y)
  glint.rotate(angle)
  leafOutline(glint, length)
  glint.fillStyle = glintColor
  glint.fill()
  glint.restore()

  g.save()
  g.translate(x, y)
  g.rotate(angle)
  leafOutline(g, length)
  const v = Math.round(150 + 90 * shade)
  g.fillStyle = `rgb(${Math.round(v * 0.86)}, ${v}, ${Math.round(v * 0.62)})`
  g.fill()
  // 葉脈(中央の筋)
  g.strokeStyle = `rgba(255, 255, 220, 0.35)`
  g.lineWidth = 1.2
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(length * 0.92, 0)
  g.stroke()
  g.restore()
}

/** 広葉樹の小枝。枝の両側と先に、葉が互い違いに付く。枝の根元が下(v = 0)、先が上 */
export function broadleafTexture(): LeafTextures {
  const { g, glint } = canvases()
  const next = random(11)
  // きらめきの乱数は別の列にする(葉の絵が前と変わらないように)
  const nextGlint = random(97)
  const twigs: Array<[number, number, number]> = [
    [SIZE * 0.5, SIZE * 0.98, -Math.PI / 2],
    [SIZE * 0.5, SIZE * 0.7, -Math.PI / 2 - 0.75],
    [SIZE * 0.5, SIZE * 0.6, -Math.PI / 2 + 0.7]
  ]
  for (const [startX, startY, heading] of twigs) {
    const reach = (startY === SIZE * 0.98 ? 0.62 : 0.3) * SIZE
    g.strokeStyle = 'rgb(96, 84, 60)'
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(startX, startY)
    g.lineTo(startX + Math.cos(heading) * reach, startY + Math.sin(heading) * reach)
    g.stroke()
    const count = Math.round(reach / 17)
    for (let i = 0; i <= count; i++) {
      const t = (i + 0.4) / (count + 0.4)
      const x = startX + Math.cos(heading) * reach * t
      const y = startY + Math.sin(heading) * reach * t
      const side = i % 2 === 0 ? 1 : -1
      const tip = i === count
      const angle = heading + (tip ? (next() - 0.5) * 0.3 : side * (0.75 + next() * 0.5))
      drawLeaf(g, glint, glintStyle(nextGlint), x, y, angle, SIZE * (0.2 + next() * 0.1), next())
    }
  }
  return { map: finish(g.canvas), glint: finish(glint.canvas, false) }
}

/** 針葉樹の小枝。軸の両側に、細い葉がびっしり並ぶ。平たい扇のような形 */
export function needleTexture(): LeafTextures {
  const { g, glint } = canvases()
  const next = random(23)
  const nextGlint = random(131)
  glint.lineWidth = 2.2
  glint.lineCap = 'round'
  const spray = (x0: number, y0: number, heading: number, reach: number): void => {
    g.strokeStyle = 'rgb(88, 76, 54)'
    g.lineWidth = 2.5
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(x0 + Math.cos(heading) * reach, y0 + Math.sin(heading) * reach)
    g.stroke()
    g.lineWidth = 2.2
    g.lineCap = 'round'
    for (let d = 2; d < reach; d += 3.2) {
      const x = x0 + Math.cos(heading) * d
      const y = y0 + Math.sin(heading) * d
      // 先へ行くほど葉が短くなる
      const length = SIZE * 0.11 * (1 - 0.6 * (d / reach)) * (0.8 + next() * 0.4)
      for (const side of [-1, 1]) {
        const angle = heading + side * (0.95 + (next() - 0.5) * 0.3)
        const v = Math.round(150 + 90 * next())
        g.strokeStyle = `rgb(${Math.round(v * 0.74)}, ${v}, ${Math.round(v * 0.7)})`
        g.beginPath()
        g.moveTo(x, y)
        g.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
        g.stroke()
        glint.strokeStyle = glintStyle(nextGlint)
        glint.beginPath()
        glint.moveTo(x, y)
        glint.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
        glint.stroke()
      }
    }
  }
  spray(SIZE * 0.5, SIZE * 0.99, -Math.PI / 2, SIZE * 0.94)
  for (let i = 0; i < 6; i++) {
    const y = SIZE * (0.86 - i * 0.12)
    const side = i % 2 === 0 ? 1 : -1
    spray(SIZE * 0.5, y, -Math.PI / 2 + side * 0.85, SIZE * (0.4 - i * 0.035))
  }
  return { map: finish(g.canvas), glint: finish(glint.canvas, false) }
}
