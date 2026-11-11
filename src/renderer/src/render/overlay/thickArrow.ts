// 太さのある矢印の形。weather-globe の thick-arrow.ts の考え方を、平面(m)の座標に移したもの。
// 帯は一定の太さで、先端に帯より幅の広い矢じりを付ける。渡された点を直線で結び、角だけを丸めてから帯にする
// (角で帯が折れ重なるのを防ぐ)。描画から切り離して検証できるよう、Three.js に依存しない。

const HEAD_WIDTH_RATIO = 1.9 // 矢じりの幅(帯の太さに対する割合)
const HEAD_LENGTH_RATIO = 1.3 // 矢じりの長さ(矢じりの幅に対する割合)
const HEAD_MAX_SHARE = 0.4 // 短い矢印でも、矢じりは全体の長さのこの割合まで
const CORNER_RADIUS_RATIO = 2 // 角を丸める大きさ(帯の太さに対する割合)

/** 頂点。progress は根元からの進み具合(0〜1)、side は帯の左右(-1〜1。矢じりの先端は 0) */
export interface ArrowVertex {
  x: number
  z: number
  progress: number
  side: number
  /** 矢じりの頂点は 1、帯は 0 */
  head: number
}

export interface ThickArrow {
  triangles: [ArrowVertex, ArrowVertex, ArrowVertex][]
  /** 根元から先端までの左右の縁(どちらも先端で終わる) */
  outline: { left: ArrowVertex[]; right: ArrowVertex[] }
  /** 長さ(m) */
  length: number
}

type Vec = [number, number]

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]]
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k]
const length = (a: Vec): number => Math.hypot(a[0], a[1])
const normalize = (a: Vec): Vec => {
  const l = length(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]
}

/**
 * 点を直線で結び、角だけを丸めた道筋を、step ごとに区切った点の並びにする。
 * 角は、角から radius ほど手前と先の点を、角を制御点にした 2 次ベジェ曲線でつなぐ。
 * 前後の線分が短いときは、その半分までに縮める(隣の角の丸めと重ならないように)
 */
function roundedPath(points: Vec[], step: number, radius: number): Vec[] {
  const out: Vec[] = [points[0]]
  const pushLine = (from: Vec, to: Vec): void => {
    const count = Math.max(1, Math.ceil(length(sub(to, from)) / step))
    for (let k = 1; k <= count; k++) out.push(add(from, scale(sub(to, from), k / count)))
  }
  let cursor = points[0]
  for (let i = 1; i + 1 < points.length; i++) {
    const corner = points[i]
    const before = length(sub(corner, points[i - 1]))
    const after = length(sub(points[i + 1], corner))
    const cut = Math.min(radius, before / 2, after / 2)
    const start = add(corner, scale(normalize(sub(points[i - 1], corner)), cut))
    const end = add(corner, scale(normalize(sub(points[i + 1], corner)), cut))
    pushLine(cursor, start)
    const count = Math.max(2, Math.ceil((cut * 2) / step))
    for (let k = 1; k <= count; k++) {
      const t = k / count
      const u = 1 - t
      out.push(add(add(scale(start, u * u), scale(corner, 2 * u * t)), scale(end, t * t)))
    }
    cursor = end
  }
  pushLine(cursor, points[points.length - 1])
  return out
}

/**
 * points は x と z を交互に並べた点の並び、width は帯の太さ(m)、step は道筋を区切る間隔(m)。
 * 作れないとき(点が足りない、長さが 0)は null
 */
export function buildThickArrow(points: number[], width: number, step: number): ThickArrow | null {
  if (points.length < 4 || !(width > 0)) return null
  // 同じ所に重なった点は除く(曲線の計算が乱れる)
  const plane: Vec[] = []
  for (let i = 0; i < points.length; i += 2) {
    const point: Vec = [points[i], points[i + 1]]
    if (plane.length === 0 || length(sub(point, plane[plane.length - 1])) > 1e-6) plane.push(point)
  }
  if (plane.length < 2) return null
  const path = roundedPath(plane, step, width * CORNER_RADIUS_RATIO)
  const along = [0]
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + length(sub(path[i], path[i - 1])))
  const total = along[along.length - 1]
  if (total <= 0) return null

  const headHalf = (width * HEAD_WIDTH_RATIO) / 2
  const headLength = Math.min(headHalf * 2 * HEAD_LENGTH_RATIO, total * HEAD_MAX_SHARE)
  const tip = path[path.length - 1]
  // 矢じりの根元は、先端からまっすぐ測って headLength だけ離れた道筋の上の点にする。
  // 矢じりの軸は根元から先端への向きにする(道筋が曲がっていても、矢じりが片側へ偏らない)
  let shaftEnd = 0
  {
    let i = path.length - 1
    while (i > 0 && length(sub(path[i - 1], tip)) < headLength) i--
    if (i > 0) {
      let lo = along[i - 1]
      let hi = along[i]
      for (let n = 0; n < 30; n++) {
        const middle = (lo + hi) / 2
        const t = (middle - along[i - 1]) / Math.max(along[i] - along[i - 1], 1e-9)
        const p = add(path[i - 1], scale(sub(path[i], path[i - 1]), t))
        if (length(sub(p, tip)) > headLength) lo = middle
        else hi = middle
      }
      shaftEnd = (lo + hi) / 2
    }
  }
  const tangentAt = (i: number): Vec =>
    normalize(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]))
  const pointAt = (d: number): Vec => {
    let i = 1
    while (i < along.length - 1 && along[i] < d) i++
    const t = (d - along[i - 1]) / Math.max(along[i] - along[i - 1], 1e-9)
    return add(path[i - 1], scale(sub(path[i], path[i - 1]), t))
  }
  const vertex = (point: Vec, distance: number, side: number, head = 0): ArrowVertex => ({
    x: point[0],
    z: point[1],
    progress: distance / total,
    side,
    head
  })

  // 帯の左右の縁。根元から矢じりの根元まで同じ太さ
  const left: ArrowVertex[] = []
  const right: ArrowVertex[] = []
  const shaft: { point: Vec; normal: Vec; distance: number }[] = []
  for (let i = 0; i < path.length && along[i] < shaftEnd; i++) {
    const tangent = tangentAt(i)
    shaft.push({ point: path[i], normal: [-tangent[1], tangent[0]], distance: along[i] })
  }
  const base = pointAt(shaftEnd)
  const axis = normalize(sub(tip, base))
  const baseNormal: Vec = [-axis[1], axis[0]]
  shaft.push({ point: base, normal: baseNormal, distance: shaftEnd })
  for (const s of shaft) {
    left.push(vertex(add(s.point, scale(s.normal, width / 2)), s.distance, 1))
    right.push(vertex(add(s.point, scale(s.normal, -width / 2)), s.distance, -1))
  }
  const triangles: ThickArrow['triangles'] = []
  for (let i = 0; i + 1 < shaft.length; i++) {
    triangles.push([left[i], right[i], right[i + 1]], [left[i], right[i + 1], left[i + 1]])
  }

  // 矢じり。根元の左右の角と先端。中心の点も置き、帯の中央と同じように左右の値が 0 になるようにする
  const headLeft = vertex(add(base, scale(baseNormal, headHalf)), shaftEnd, 1, 1)
  const headRight = vertex(add(base, scale(baseNormal, -headHalf)), shaftEnd, -1, 1)
  const headCenter = vertex(base, shaftEnd, 0, 1)
  const tipVertex = vertex(tip, total, 0, 1)
  triangles.push([headLeft, headCenter, tipVertex], [headCenter, headRight, tipVertex])
  return {
    triangles,
    // 縁取りは、帯の縁から矢じりの角へ張り出し、先端まで
    outline: { left: [...left, headLeft, tipVertex], right: [...right, headRight, tipVertex] },
    length: total
  }
}
