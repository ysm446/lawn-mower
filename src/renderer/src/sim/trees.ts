// 樹木の配置。描画に依存しない。配置はシード値で決まり、同じ値なら同じになる。
// 林の置き方は 2 通り:
//   clearing  林に囲まれた草地(林の中の空き地)。原点のまわりを空き地にし、その外を林にする。
//             空き地の縁は方角によって出入りさせる
//   groves    丘のあちこちに林が点在する。林の場所はノイズで決め、出発点のまわりは空けておく
// どちらも、林の縁に低木を茂らせ、林の外にも数本だけ木を立てる。林の中は芝刈り機が入れない。

import { gradientNoise } from './terrain'

/** 林に囲まれた草地 */
export interface ClearingSpec {
  layout: 'clearing'
  /** 空き地の半径の基準(m) */
  clearingRadius: number
  /** 空き地の縁の出入りの大きさ(m) */
  variation: number
  /** 林の木の間隔(m) */
  spacing: number
  /** 林の外側の端(m)。ここまで木を置く */
  outerRadius: number
  /** 空き地の中に立てる木の本数 */
  lone: number
}

/** 林が点在する丘陵 */
export interface GroveSpec {
  layout: 'groves'
  /** 林のまとまりの大きさの目安(m)。ノイズの波長 */
  scale: number
  /** 林の広さの割合の目安(0〜1) */
  cover: number
  /** 林の木の間隔(m) */
  spacing: number
  /** ここまで林を置く(原点からの距離、m) */
  outerRadius: number
  /** 林の外に 1 本で立てる木の本数 */
  lone: number
  /** 1 本立ちの木を置く範囲(原点からの距離、m)。刈る範囲に収める */
  loneRadius: number
  /** 林を置かない所(出発点のまわりなど)。中心と半径(m) */
  openings: { x: number; z: number; radius: number }[]
}

export type TreeSpec = ClearingSpec | GroveSpec

export type TreeKind = 'broadleaf' | 'conifer' | 'shrub'

export interface Tree {
  /** 樹種。広葉樹、針葉樹、低木 */
  kind: TreeKind
  x: number
  z: number
  /** 樹高(m) */
  height: number
  /** 枝葉の広がりの半径(m) */
  spread: number
  /** 見た目のばらつきに使う値(0〜1) */
  tone: number
  /** 空き地の中に 1 本で立っている木か */
  lone: boolean
}

/** 木の幹のまわりで、芝刈り機が入れない半径(m) */
const TRUNK_CLEARANCE = 2.5
/** 林の縁から、芝刈り機が入れない所までの余裕(m)。張り出した枝の下までは刈る */
const FOREST_MARGIN = 1.5

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

/** (x, z) の方角での、空き地の半径(m) */
export function clearingRadiusAt(spec: ClearingSpec, seed: number, x: number, z: number): number {
  const r = Math.hypot(x, z) || 1
  // 方角だけで決まるように、単位円の上の点でノイズを読む(大きな出入りと小さな出入りを重ねる)
  const ux = x / r
  const uz = z / r
  const wide = gradientNoise(ux * 1.4 + 11, uz * 1.4 + 5, seed + 401)
  const fine = gradientNoise(ux * 4.5 + 3, uz * 4.5 + 17, seed + 409)
  return spec.clearingRadius + (wide * 1.6 + fine * 0.6) * spec.variation
}

/** 点在する林のノイズ(大きなまとまりに、小さな出入りを重ねる) */
function groveNoise(spec: GroveSpec, seed: number, x: number, z: number): number {
  const s = spec.scale
  const fine = s * 0.37
  return gradientNoise(x / s + 7, z / s + 3, seed + 601) + 0.45 * gradientNoise(x / fine + 1, z / fine + 13, seed + 607)
}

/** 林の広さの割合が cover になる、ノイズの閾値。刈る範囲(loneRadius の中)で標本を取って決める */
const groveThresholds = new WeakMap<GroveSpec, Map<number, number>>()
function groveThreshold(spec: GroveSpec, seed: number): number {
  let bySeed = groveThresholds.get(spec)
  if (!bySeed) {
    bySeed = new Map()
    groveThresholds.set(spec, bySeed)
  }
  const cached = bySeed.get(seed)
  if (cached !== undefined) return cached
  const values: number[] = []
  const step = spec.loneRadius / 40
  for (let z = -spec.loneRadius; z <= spec.loneRadius; z += step) {
    for (let x = -spec.loneRadius; x <= spec.loneRadius; x += step) {
      if (Math.hypot(x, z) <= spec.loneRadius) values.push(groveNoise(spec, seed, x, z))
    }
  }
  values.sort((a, b) => a - b)
  const cover = Math.min(Math.max(spec.cover, 0), 1)
  const threshold = values[Math.min(values.length - 1, Math.floor(values.length * (1 - cover)))]
  bySeed.set(seed, threshold)
  return threshold
}

/**
 * 林の縁からの深さ(m)。林の中は正、外は負。
 * 点在する林では、ノイズの値の差を、まとまりの大きさに合わせておおよその距離に直す
 */
export function forestDepth(spec: TreeSpec, seed: number, x: number, z: number): number {
  if (spec.layout === 'clearing') return Math.hypot(x, z) - clearingRadiusAt(spec, seed, x, z)
  let depth = (groveNoise(spec, seed, x, z) - groveThreshold(spec, seed)) * spec.scale * 0.8
  for (const o of spec.openings) depth = Math.min(depth, Math.hypot(x - o.x, z - o.z) - o.radius)
  return depth
}

/** (x, z) が林の中か */
export function inForest(spec: TreeSpec, seed: number, x: number, z: number): boolean {
  return forestDepth(spec, seed, x, z) > 0
}

/** 木を並べる。avoidX、avoidZ は芝刈り機の出発点で、その近くには 1 本立ちの木を置かない */
export function generateTrees(spec: TreeSpec, seed: number, avoidX: number, avoidZ: number): Tree[] {
  const next = random(seed * 7919 + 13)
  const trees: Tree[] = []
  const grow = (x: number, z: number, lone: boolean): void => {
    // 針葉樹は、林の中にかたまって生える(1 本立ちは広葉樹だけ)
    const conifer = !lone && gradientNoise(x / 55 + 3, z / 55 + 9, seed + 503) > 0.1
    const height = conifer ? 12 + next() * 9 : (lone ? 11 : 9) + next() * 8
    const spread = height * (conifer ? 0.16 + next() * 0.05 : 0.26 + next() * 0.1)
    trees.push({ kind: conifer ? 'conifer' : 'broadleaf', x, z, height, spread, tone: next(), lone })
  }

  // 林: マス目に 1 本ずつ、位置をずらして置く。奥や遠くはまばらにして本数を抑える
  const reach = Math.ceil(spec.outerRadius / spec.spacing)
  for (let iz = -reach; iz <= reach; iz++) {
    for (let ix = -reach; ix <= reach; ix++) {
      const x = (ix + (next() - 0.5) * 0.8) * spec.spacing
      const z = (iz + (next() - 0.5) * 0.8) * spec.spacing
      const keep = next()
      const r = Math.hypot(x, z)
      if (r > spec.outerRadius) continue
      const depth = forestDepth(spec, seed, x, z)
      if (depth < 1) continue
      // 縁から 60 m より奥は半分に間引く(外からは見えにくい)
      if (depth > 60 && keep < 0.5) continue
      // 点在する林では、刈る範囲より外の林も半分に間引く(遠景として見えればよい)
      if (spec.layout === 'groves' && r > spec.loneRadius + 60 && keep < 0.5) continue
      grow(x, z, false)
    }
  }

  // 低木: 林の縁に茂り、林の中にもまばらに生える
  const shrubSpacing = 3.2
  const shrubRange =
    spec.layout === 'clearing' ? spec.clearingRadius + spec.variation * 2 + 50 : spec.loneRadius + 60
  const shrubReach = Math.ceil(shrubRange / shrubSpacing)
  for (let iz = -shrubReach; iz <= shrubReach; iz++) {
    for (let ix = -shrubReach; ix <= shrubReach; ix++) {
      const x = (ix + (next() - 0.5) * 0.9) * shrubSpacing
      const z = (iz + (next() - 0.5) * 0.9) * shrubSpacing
      const keep = next()
      const size = next()
      const tone = next()
      const depth = forestDepth(spec, seed, x, z)
      if (depth < 0.8 || depth > 45) continue
      if (keep > (depth < 9 ? 0.5 : 0.07)) continue
      const height = 1.1 + size * 1.4
      trees.push({ kind: 'shrub', x, z, height, spread: height * 0.6, tone, lone: false })
    }
  }

  // 林の外の 1 本立ち。林の縁と出発点と、ほかの 1 本立ちから離す
  let tries = 0
  let placed = 0
  const maxTries = spec.layout === 'clearing' ? 200 : 600
  while (placed < spec.lone && tries++ < maxTries) {
    const angle = next() * Math.PI * 2
    let x: number
    let z: number
    if (spec.layout === 'clearing') {
      const share = 0.25 + next() * 0.45
      x = Math.cos(angle) * spec.clearingRadius * share
      z = Math.sin(angle) * spec.clearingRadius * share
    } else {
      // 円の中に均等に散らす
      const r = spec.loneRadius * Math.sqrt(next())
      x = Math.cos(angle) * r
      z = Math.sin(angle) * r
    }
    if (forestDepth(spec, seed, x, z) > -12) continue
    if (Math.hypot(x - avoidX, z - avoidZ) < 15) continue
    if (trees.some((t) => t.lone && Math.hypot(t.x - x, t.z - z) < 18)) continue
    grow(x, z, true)
    placed++
  }
  return trees
}

/**
 * 芝刈り機が入れない所を 1 にした格子を作る(林の中と、1 本立ちの木の幹のまわり)。
 * samples、cell、origin は地形の格子と同じ取り方
 */
export function blockedByTrees(
  trees: Tree[],
  spec: TreeSpec,
  seed: number,
  samples: number,
  cell: number,
  origin: number
): Uint8Array {
  const blocked = new Uint8Array(samples * samples)
  for (let iz = 0; iz < samples; iz++) {
    const z = origin + iz * cell
    for (let ix = 0; ix < samples; ix++) {
      const x = origin + ix * cell
      if (forestDepth(spec, seed, x, z) > -FOREST_MARGIN) {
        blocked[iz * samples + ix] = 1
      }
    }
  }
  const reach = Math.ceil(TRUNK_CLEARANCE / cell)
  for (const tree of trees) {
    if (!tree.lone) continue
    const cx = Math.round((tree.x - origin) / cell)
    const cz = Math.round((tree.z - origin) / cell)
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const ix = cx + dx
        const iz = cz + dz
        if (ix < 0 || iz < 0 || ix >= samples || iz >= samples) continue
        const x = origin + ix * cell
        const z = origin + iz * cell
        if (Math.hypot(x - tree.x, z - tree.z) <= TRUNK_CLEARANCE) blocked[iz * samples + ix] = 1
      }
    }
  }
  return blocked
}
