// 樹木の配置。林に囲まれた草地(林の中の空き地)を作る。描画に依存しない。
// 原点のまわりを空き地にし、その外を林にする。空き地の縁は方角によって出入りさせ、
// 空き地の中にも数本だけ木を立てる。配置はシード値で決まり、同じ値なら同じになる。

import { gradientNoise } from './terrain'

export interface TreeSpec {
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
export function clearingRadiusAt(spec: TreeSpec, seed: number, x: number, z: number): number {
  const r = Math.hypot(x, z) || 1
  // 方角だけで決まるように、単位円の上の点でノイズを読む(大きな出入りと小さな出入りを重ねる)
  const ux = x / r
  const uz = z / r
  const wide = gradientNoise(ux * 1.4 + 11, uz * 1.4 + 5, seed + 401)
  const fine = gradientNoise(ux * 4.5 + 3, uz * 4.5 + 17, seed + 409)
  return spec.clearingRadius + (wide * 1.6 + fine * 0.6) * spec.variation
}

/** (x, z) が林の中か */
export function inForest(spec: TreeSpec, seed: number, x: number, z: number): boolean {
  return Math.hypot(x, z) > clearingRadiusAt(spec, seed, x, z)
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

  // 林: マス目に 1 本ずつ、位置をずらして置く。遠くはまばらにして本数を抑える
  const reach = Math.ceil(spec.outerRadius / spec.spacing)
  for (let iz = -reach; iz <= reach; iz++) {
    for (let ix = -reach; ix <= reach; ix++) {
      const x = (ix + (next() - 0.5) * 0.8) * spec.spacing
      const z = (iz + (next() - 0.5) * 0.8) * spec.spacing
      const keep = next()
      const r = Math.hypot(x, z)
      if (r > spec.outerRadius) continue
      const edge = clearingRadiusAt(spec, seed, x, z)
      if (r < edge + 1) continue
      // 縁から 60 m より奥は半分に間引く(外からは見えにくい)
      if (r > edge + 60 && keep < 0.5) continue
      grow(x, z, false)
    }
  }

  // 低木: 林の縁に茂り、林の中にもまばらに生える
  const shrubSpacing = 3.2
  const shrubReach = Math.ceil((spec.clearingRadius + spec.variation * 2 + 50) / shrubSpacing)
  for (let iz = -shrubReach; iz <= shrubReach; iz++) {
    for (let ix = -shrubReach; ix <= shrubReach; ix++) {
      const x = (ix + (next() - 0.5) * 0.9) * shrubSpacing
      const z = (iz + (next() - 0.5) * 0.9) * shrubSpacing
      const keep = next()
      const size = next()
      const tone = next()
      const depth = Math.hypot(x, z) - clearingRadiusAt(spec, seed, x, z)
      if (depth < 0.8 || depth > 45) continue
      if (keep > (depth < 9 ? 0.5 : 0.07)) continue
      const height = 1.1 + size * 1.4
      trees.push({ kind: 'shrub', x, z, height, spread: height * 0.6, tone, lone: false })
    }
  }

  // 空き地の中の 1 本立ち。出発点と、ほかの 1 本立ちから離す
  let tries = 0
  let placed = 0
  while (placed < spec.lone && tries++ < 200) {
    const angle = next() * Math.PI * 2
    const share = 0.25 + next() * 0.45
    const x = Math.cos(angle) * spec.clearingRadius * share
    const z = Math.sin(angle) * spec.clearingRadius * share
    if (Math.hypot(x, z) > clearingRadiusAt(spec, seed, x, z) - 12) continue
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
      if (Math.hypot(x, z) > clearingRadiusAt(spec, seed, x, z) - FOREST_MARGIN) {
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
