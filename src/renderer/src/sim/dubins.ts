// 旋回の曲線(デュビンス曲線)。最小旋回半径を守って、ある位置と向きから別の位置と向きへ
// 前進だけで移る最短の道筋。円弧、直線、円弧(または円弧 3 つ)の組み合わせになる。
// 向きの決まりは vehicle.ts と同じ(heading = 0 で +Z、正の回転で +X 側へ曲がる)。

const TWO_PI = Math.PI * 2

function mod(a: number): number {
  const r = a % TWO_PI
  return r < 0 ? r + TWO_PI : r
}

type SegmentKind = 'L' | 'S' | 'R'

interface Candidate {
  kinds: [SegmentKind, SegmentKind, SegmentKind]
  /** 各区間の長さ(半径で割った値。円弧では回る角度になる) */
  lengths: [number, number, number]
}

function candidates(alpha: number, beta: number, d: number): Candidate[] {
  const sa = Math.sin(alpha)
  const sb = Math.sin(beta)
  const ca = Math.cos(alpha)
  const cb = Math.cos(beta)
  const cab = Math.cos(alpha - beta)
  const out: Candidate[] = []

  // 左、直進、左
  let p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb)
  if (p2 >= 0) {
    const tmp = Math.atan2(cb - ca, d + sa - sb)
    out.push({ kinds: ['L', 'S', 'L'], lengths: [mod(-alpha + tmp), Math.sqrt(p2), mod(beta - tmp)] })
  }
  // 右、直進、右
  p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa)
  if (p2 >= 0) {
    const tmp = Math.atan2(ca - cb, d - sa + sb)
    out.push({ kinds: ['R', 'S', 'R'], lengths: [mod(alpha - tmp), Math.sqrt(p2), mod(-beta + tmp)] })
  }
  // 左、直進、右
  p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb)
  if (p2 >= 0) {
    const p = Math.sqrt(p2)
    const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p)
    out.push({ kinds: ['L', 'S', 'R'], lengths: [mod(-alpha + tmp), p, mod(-mod(beta) + tmp)] })
  }
  // 右、直進、左
  p2 = d * d - 2 + 2 * cab - 2 * d * (sa + sb)
  if (p2 >= 0) {
    const p = Math.sqrt(p2)
    const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p)
    out.push({ kinds: ['R', 'S', 'L'], lengths: [mod(alpha - tmp), p, mod(beta - tmp)] })
  }
  // 右、左、右
  let tmp = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8
  if (Math.abs(tmp) <= 1) {
    const p = mod(TWO_PI - Math.acos(tmp))
    const t = mod(alpha - Math.atan2(ca - cb, d - sa + sb) + p / 2)
    out.push({ kinds: ['R', 'L', 'R'], lengths: [t, p, mod(alpha - beta - t + p)] })
  }
  // 左、右、左
  tmp = (6 - d * d + 2 * cab + 2 * d * (-sa + sb)) / 8
  if (Math.abs(tmp) <= 1) {
    const p = mod(TWO_PI - Math.acos(tmp))
    const t = mod(-alpha - Math.atan2(ca - cb, d + sa - sb) + p / 2)
    out.push({ kinds: ['L', 'R', 'L'], lengths: [t, p, mod(mod(beta) - alpha - t + p)] })
  }
  return out
}

export interface DubinsPath {
  /** 道筋の点。x と z を交互に並べる。始点と終点を含む */
  points: number[]
  /** 長さ(m) */
  length: number
}

/**
 * (x0, z0, heading0) から (x1, z1, heading1) への道筋を求める。
 * radius は旋回半径、step は点を置く間隔(m)。
 */
export function dubinsPath(
  x0: number,
  z0: number,
  heading0: number,
  x1: number,
  z1: number,
  heading1: number,
  radius: number,
  step = 0.25
): DubinsPath {
  // 一般的な式の座標(u が前、v が左、角度は反時計回り)に、u = z、v = x として当てはめる
  const du = z1 - z0
  const dv = x1 - x0
  const d = Math.hypot(du, dv) / radius
  const theta = Math.atan2(dv, du)
  const alpha = mod(heading0 - theta)
  const beta = mod(heading1 - theta)

  let best: Candidate | null = null
  let bestLength = Infinity
  for (const c of candidates(alpha, beta, d)) {
    const length = c.lengths[0] + c.lengths[1] + c.lengths[2]
    if (length < bestLength) {
      best = c
      bestLength = length
    }
  }
  // 左直左と右直右は必ず求まるので、ここで null にはならない
  const chosen = best as Candidate

  const points: number[] = [x0, z0]
  let u = z0
  let v = x0
  let heading = heading0
  for (let i = 0; i < 3; i++) {
    const kind = chosen.kinds[i]
    const length = chosen.lengths[i] * radius
    if (length < 1e-9) continue
    const count = Math.max(1, Math.ceil(length / step))
    const startU = u
    const startV = v
    const startHeading = heading
    for (let k = 1; k <= count; k++) {
      const s = (length * k) / count
      if (kind === 'S') {
        u = startU + Math.cos(startHeading) * s
        v = startV + Math.sin(startHeading) * s
      } else {
        const sign = kind === 'L' ? 1 : -1
        heading = startHeading + (sign * s) / radius
        u = startU + sign * radius * (Math.sin(heading) - Math.sin(startHeading))
        v = startV - sign * radius * (Math.cos(heading) - Math.cos(startHeading))
      }
      points.push(v, u)
    }
  }
  return { points, length: bestLength * radius }
}
