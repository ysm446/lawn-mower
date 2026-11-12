// マップの定義。地形の形、草の様子、樹木、出発点などを、マップごとにまとめる。描画に依存しない。

import type { TerrainShape } from './terrain'
import type { TreeSpec } from './trees'

export interface GrassSpec {
  /** 刈る前の草丈の基準(m)。場所ごとのむらは、これに倍率を掛ける */
  uncutHeight: number
  /** 荒れ具合(0〜1)。枯れ色の混じり、穂、小さな花、葉の乱れ方に効く。0 は手入れされた芝 */
  roughness: number
}

export interface MapSpec {
  id: string
  name: string
  /** 画面に出す短い説明 */
  description: string
  /** 地形と配置を決めるシード値 */
  seed: number
  shape: TerrainShape
  grass: GrassSpec
  /** 樹木。無いマップは null */
  trees: TreeSpec | null
  /** 芝刈り機の出発点 */
  startX: number
  startZ: number
  /** 区画 1 つの広さの目安の初期値(m²)。刈れる範囲をこの広さの区画に分け、自動運転は区画ごとに刈る */
  plotArea: number
}

export const MAPS: MapSpec[] = [
  {
    id: 'hills',
    name: '丘陵',
    description: 'なだらかな丘が続く芝地。勾配で刈る範囲が分かれる',
    seed: 7,
    shape: { hillScale: 1, mountainScale: 0, plain: true },
    grass: { uncutHeight: 0.1, roughness: 0 },
    trees: null,
    startX: -21,
    startZ: -55,
    plotArea: 12000
  },
  {
    id: 'meadow',
    name: '林の中の草地',
    description: '樹木に囲まれた荒れ草地。伸びた草の中に、木が数本立っている',
    seed: 21,
    shape: { hillScale: 0.28, mountainScale: 0.15 },
    grass: { uncutHeight: 0.15, roughness: 1 },
    trees: { clearingRadius: 62, variation: 14, spacing: 7.5, outerRadius: 300, lone: 5 },
    startX: 0,
    startZ: -18,
    plotArea: 50000
  }
]

export function findMap(id: string | null): MapSpec {
  return MAPS.find((map) => map.id === id) ?? MAPS[0]
}
