// 近景の芝の葉。カメラが見ている地面のまわりだけ、葉を 1 枚ずつインスタンシングで描く。
// 葉の位置は世界に固定した細かいマス目から決めるので、描く範囲が動いても葉は動かない。
// 葉の高さと倒れる向きは芝状態マップから、根元の高さは地形の高さのテクスチャから取る。
// 色は地面と同じ式(GRASS_GLSL)を使い、葉の無い遠くの地面と色がつながるようにする。

import {
  BufferAttribute,
  DataTexture,
  DoubleSide,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  Vector2,
  Vector3,
  type PerspectiveCamera
} from 'three'
import type { Terrain } from '../sim/terrain'
import { LENGTH_FACTOR_MAX, LENGTH_FACTOR_MIN } from '../sim/grassField'
import { GRASS_GLSL, type GroundUniforms } from './ground'

export interface GrassBladeOptions {
  /** 葉を描く範囲の半径(m) */
  radius: number
  /** 葉を置くマス目の間隔(m) */
  spacing: number
  /** 葉の根元の幅(m)。実物より太くして、少し模型らしく見せる */
  bladeWidth: number
}

export const DEFAULT_GRASS_BLADES: GrassBladeOptions = {
  radius: 14,
  spacing: 0.04,
  bladeWidth: 0.018
}

/** この半径(m)までは、マス目に 1 枚ずつ葉を置く。その外はまばらにする */
const FULL_RADIUS = 12
/** 葉を描く範囲を動かす刻み(マス)。まばらにする間隔の最大(4 マス)に合わせる */
const PATCH_SNAP = 4
/** 見ている地面までの距離(35 mm のレンズに直した値、m)がこれを超えるたびに、葉の間隔と太さを 2 倍にする */
const LEVEL_DISTANCE = 26
/** 段の上限(4 なら 16 倍まで) */
const MAX_LEVEL = 4

const VERTEX_HEADER = /* glsl */ `
attribute vec2 aCell;
uniform sampler2D uHeightMap;
uniform float uHeightOrigin;
uniform float uHeightCell;
uniform vec2 uPatchCell;
uniform float uSpacing;
uniform float uBladeScale; // 離れて見るときの、葉の間隔と太さの倍率(1、2、4、…)
uniform float uBladeWidth;
uniform sampler2D uLengthMap;
uniform float uLengthOrigin;
uniform float uLengthSize;
uniform sampler2D uMowMap;
uniform vec2 uMowOrigin;
uniform float uMowSize;
uniform float uMaxHeight;
uniform float uUncutNorm;
uniform vec2 uBladeCenter;
uniform float uBladeRadius;
uniform float uBladeAmount;
uniform float uRough;
varying vec3 vBladeRoot;
varying float vBladeT;

float bladeHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// なめらかなノイズ(地面のシェーダーの mowNoise と同じ式。葉と地面でむらの位置を揃える)
float bladeNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = bladeHash(i);
  float b = bladeHash(i + vec2(1.0, 0.0));
  float c = bladeHash(i + vec2(0.0, 1.0));
  float d = bladeHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 地形の高さ。格子の 4 点から補間する(Terrain.heightAt と同じ計算)
float terrainHeight(vec2 xz) {
  vec2 g = (xz - uHeightOrigin) / uHeightCell;
  ivec2 size = textureSize(uHeightMap, 0);
  vec2 limit = vec2(size) - 1.001;
  g = clamp(g, vec2(0.0), limit);
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  float a = texelFetch(uHeightMap, i, 0).r;
  float b = texelFetch(uHeightMap, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeightMap, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeightMap, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`

// 法線を決める所で、葉 1 枚ぶんの位置をまとめて計算しておく
const VERTEX_NORMAL = /* glsl */ `
vec2 bladeCell = aCell + uPatchCell;
float rndA = bladeHash(bladeCell);
float rndB = bladeHash(bladeCell + 17.3);
float rndC = bladeHash(bladeCell + 41.7);
vec2 bladeRoot = (bladeCell + vec2(rndA, rndB)) * uSpacing * uBladeScale;
float groundY = terrainHeight(bladeRoot);

// 読む位置を葉ごとに少しずらす。刈り跡の縁で、刈られた葉と残った葉が入り混じる
vec2 mowWobble = (vec2(bladeNoise(bladeRoot * 3.3), bladeNoise(bladeRoot * 3.3 + 19.7)) - 0.5) * 0.2
  + (vec2(rndA, rndC) - 0.5) * 0.1;
vec2 mowUv = (bladeRoot + mowWobble - uMowOrigin) / uMowSize;
// 葉の向き(縞の境目や車輪の跡)は、位置をあまり揺らさずに読む
vec2 leanUv = (bladeRoot + mowWobble * 0.25 - uMowOrigin) / uMowSize;
vec4 bladeState = vec4(0.5, 0.5, 0.0, uUncutNorm);
if (mowUv.x > 0.0 && mowUv.x < 1.0 && mowUv.y > 0.0 && mowUv.y < 1.0) {
  bladeState = texture2D(uMowMap, mowUv);
  bladeState.rg = texture2D(uMowMap, clamp(leanUv, 0.0, 1.0)).rg;
}
vec2 bladeLean = bladeState.rg * 2.0 - 1.0;
float bladeHeight = bladeState.a * uMaxHeight;
float bladeCut = 1.0 - smoothstep(0.02, 0.06, bladeHeight);

// 範囲の縁に向かって葉を低くし、境目を目立たなくする
float bladeFade = uBladeAmount * (1.0 - smoothstep(uBladeRadius * 0.6, uBladeRadius, length(bladeRoot - uBladeCenter)));
// 遠くは葉をまばらにする。ある距離で一斉に間引くと境目が線になって見えるので、
// 間引かれる葉を距離に応じて少しずつ低くして消し、残る葉を少しずつ太くする。
// 葉の組は、世界に固定したマス目の番号で決める: 4 マスおきの葉は最後まで残り、2 マスおきの葉は
// 密な範囲の 2 倍まで、それ以外は密な範囲まで
float lodDistance = length(bladeRoot - uBladeCenter);
float lodFull = FULL_RADIUS * uBladeScale;
vec2 lodIn4 = mod(bladeCell, 4.0);
vec2 lodIn2 = mod(bladeCell, 2.0);
bool lodKeep4 = lodIn4.x < 0.5 && lodIn4.y < 0.5;
bool lodKeep2 = lodIn2.x < 0.5 && lodIn2.y < 0.5;
if (!lodKeep4) {
  float lodEnd = lodKeep2 ? lodFull * 2.0 : lodFull;
  bladeFade *= 1.0 - smoothstep(lodEnd * 0.55, lodEnd, lodDistance);
}
float bladeWide = 1.0
  + 0.8 * smoothstep(lodFull * 0.55, lodFull, lodDistance)
  + 1.2 * smoothstep(lodFull * 1.1, lodFull * 2.0, lodDistance);
// 伸びた芝は高さも向きもばらつく。刈った芝は揃っている
// 刈った芝も、刈高ぴったりには揃わない。刃を逃れて少し長く残る葉もまばらにある
float rndD = bladeHash(bladeCell + 73.9);
float cutVary = 0.7 + 0.6 * rndC + step(0.965, rndD) * (0.8 + 1.2 * rndA);
// 伸びた芝は、場所によって長さが違う。数 m ごとの株のかたまりと、もっと大きな広がりで変える
float lengthPatch = texture2D(uLengthMap, (bladeRoot - uLengthOrigin) / uLengthSize).r;
float longVary = (0.55 + 0.9 * rndC) * mix(LENGTH_MIN, LENGTH_MAX, lengthPatch);
bladeHeight *= mix(longVary, cutVary, bladeCut) * bladeFade;
// 荒れ草地の草は、向きがより乱れ、倒れかかったものも混じる
float wild = (1.0 - bladeCut) * (0.55 + 0.5 * uRough) + 0.08;
float wildAngle = rndB * 6.2832;
vec2 bladeBend = vec2(cos(wildAngle), sin(wildAngle)) * wild;

// 刈った芝は、刈刃とローラーに押されて進行方向へ寝る。寝る角度(鉛直からの角度)を決める
float leanAmount = length(bladeLean);
vec2 leanDir = leanAmount > 0.01 ? bladeLean / leanAmount : vec2(0.0);
// 伸びた芝も、車輪に踏まれた所(向きが書き込まれた所)は寝る
float laid = min(leanAmount, 1.0);
// 寝方にはむらがある。場所によって寝方が弱く、起き上がったままの葉も混じる
float layPatch = mix(0.5, 1.0, bladeNoise(bladeRoot * 0.8 + 3.1));
// 車輪に踏まれた所(刈っただけの所より向きが強く書き込まれている)は、むらなく強く寝る
float pressed = smoothstep(0.84, 0.97, leanAmount);
// 0.5 は車輪の跡の強さ(ground.ts の TRACK_STRENGTH と揃える)
pressed *= 0.5;
laid = mix(laid * layPatch * (rndD < 0.22 ? 0.25 : 1.0), 1.0, pressed);
float layAngle = laid * mix(1.1 + 0.5 * (rndB - 0.5), 1.38, pressed);
// 寝た葉は、刈高と同じ高さに収まる分だけ長く見える
// 伸びた芝は長さがそのままで、寝た分だけ低くなる
float bladeLength = mix(bladeHeight, bladeHeight / max(cos(layAngle), 0.4), bladeCut);

// 地形の傾きから法線を求める。地面と同じ明るさで照らすため
float slopeX = terrainHeight(bladeRoot + vec2(0.5, 0.0)) - terrainHeight(bladeRoot - vec2(0.5, 0.0));
float slopeZ = terrainHeight(bladeRoot + vec2(0.0, 0.5)) - terrainHeight(bladeRoot - vec2(0.0, 0.5));
vec3 terrainNormal = normalize(vec3(-slopeX, 1.0, -slopeZ));
// 葉の面の向きを 1 枚ごとに変える。向きの合った葉だけが太陽を反射して、きらめいて見える。
// 寝た葉は、面が倒れた向きの上側を向く(幅は倒れた向きと直交する)
float freeAngle = rndA * 6.2832;
float laidAngle = atan(leanDir.y, leanDir.x) + 1.5708 + (rndA - 0.5) * 0.9;
vec2 widthDir = normalize(mix(vec2(cos(freeAngle), sin(freeAngle)), vec2(cos(laidAngle), sin(laidAngle)), laid));
vec3 faceNormal = vec3(-widthDir.y, 0.0, widthDir.x) * (rndC > 0.5 ? 1.0 : -1.0);
vec3 bendTilt = vec3(bladeBend.x, 0.0, bladeBend.y) * position.y;
vec3 freeNormal = terrainNormal * (0.7 + 0.5 * position.y) + faceNormal * 0.55 / uBladeScale - bendTilt * 0.5;
// 寝た葉の表面は、倒れた向きと逆側へ傾いた上向きになる。縞の明暗はここから生まれる
vec3 laidNormal = terrainNormal * (0.25 + sin(layAngle)) - vec3(leanDir.x, 0.0, leanDir.y) * cos(layAngle) * 0.8
  + faceNormal * 0.2;
objectNormal = normalize(mix(freeNormal, laidNormal, laid));
`

const VERTEX_POSITION = /* glsl */ `
float bladeT = position.y;
vec2 bladeSide = widthDir * position.x * uBladeWidth * bladeWide * mix(1.0, uBladeScale, 0.8) * step(0.001, bladeHeight);
// 根元は立ち気味で、先へ行くほど寝る
float layHere = layAngle * (0.45 + 0.55 * bladeT);
vec2 bladeOffset = bladeSide
  + leanDir * bladeLength * sin(layHere) * bladeT
  + bladeBend * bladeHeight * bladeT * bladeT;
transformed = vec3(
  bladeRoot.x + bladeOffset.x,
  groundY + bladeLength * cos(layHere) * bladeT * (1.0 - 0.2 * dot(bladeBend, bladeBend) * bladeT),
  bladeRoot.y + bladeOffset.y
);
vBladeRoot = vec3(bladeRoot.x, groundY, bladeRoot.y);
vBladeT = bladeT;
`

const FRAGMENT_COLOR = /* glsl */ `
vec4 bladeState = mowSample(vBladeRoot.xz);
vec3 bladeColor = mowGrassColor(vBladeRoot, bladeState, cameraPosition);
// 根元は陰になって暗く、先は光が透けて明るい
bladeColor *= mix(0.62, 1.18, vBladeT);
// 荒れ草地: 伸びた草には、枯れ色の葉、穂、小さな花が混じる。刈ると無くなる
float bladeTall = smoothstep(0.03, 0.08, bladeState.a * uMaxHeight) * uRough;
float bladeKind = mowHash(floor(vBladeRoot.xz * 60.0) + 7.3);
// 枯れ色の葉(先へ行くほど枯れている)
bladeColor = mix(bladeColor, vec3(0.34, 0.30, 0.11), bladeTall * step(0.72, bladeKind) * (0.35 + 0.65 * vBladeT));
// 穂(先だけが淡い色)
bladeColor = mix(bladeColor, vec3(0.50, 0.45, 0.24), bladeTall * step(0.9, bladeKind) * smoothstep(0.7, 0.9, vBladeT));
// 小さな花(白と黄)。先だけに付く
float flower = bladeTall * step(0.982, bladeKind) * smoothstep(0.78, 0.92, vBladeT);
bladeColor = mix(bladeColor, bladeKind > 0.991 ? vec3(0.85, 0.62, 0.06) : vec3(0.82, 0.82, 0.76), flower);
diffuseColor.rgb = bladeColor;
`

const FRAGMENT_NORMAL = /* glsl */ `
// 両面を描く材質では裏面の法線が反転され、裏から見た葉が真っ黒になる。葉は薄く光を通すので、元に戻す
#ifdef DOUBLE_SIDED
normal *= faceDirection;
#endif
vec2 bladeLean = mowSample(vBladeRoot.xz).rg * 2.0 - 1.0;
vec3 bladeTilt = vec3(-bladeLean.x, 0.0, -bladeLean.y) * uTilt;
normal = normalize(normal + (viewMatrix * vec4(bladeTilt, 0.0)).xyz);
`

export class GrassBlades {
  readonly mesh: Mesh
  private readonly patchCell = new Vector2()
  private readonly geometry: InstancedBufferGeometry
  private readonly scale = { value: 1 }
  private level = 0
  private readonly forward = new Vector3()

  constructor(
    private readonly terrain: Terrain,
    private readonly ground: GroundUniforms,
    private readonly options: GrassBladeOptions = { ...DEFAULT_GRASS_BLADES }
  ) {
    const { radius, spacing } = options

    // 葉 1 枚: 根元から先へ細くなる、2 段の板
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.32, 0.5, 0, 0.32, 0.5, 0, 0, 1, 0]),
        3
      )
    )
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3)
    )
    geometry.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4])

    // 円の中のマス目に 1 枚ずつ置く
    this.geometry = geometry
    this.setRadius(radius)

    const heightMap = new DataTexture(
      terrain.heights,
      terrain.samples,
      terrain.samples,
      RedFormat,
      FloatType
    )
    heightMap.minFilter = NearestFilter
    heightMap.magFilter = NearestFilter
    heightMap.needsUpdate = true

    const uniforms = {
      ...ground,
      uHeightMap: { value: heightMap },
      uHeightOrigin: { value: terrain.origin },
      uHeightCell: { value: terrain.options.cell },
      uPatchCell: { value: this.patchCell },
      uSpacing: { value: spacing },
      uBladeScale: this.scale,
      uBladeWidth: { value: options.bladeWidth }
    }

    const material = new MeshStandardMaterial({ roughness: 0.38, metalness: 0, side: DoubleSide })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\n#define LENGTH_MIN ${LENGTH_FACTOR_MIN.toFixed(3)}\n#define LENGTH_MAX ${LENGTH_FACTOR_MAX.toFixed(3)}\n#define FULL_RADIUS ${FULL_RADIUS.toFixed(1)}\n` +
            VERTEX_HEADER
        )
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + VERTEX_NORMAL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTEX_POSITION)
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n' + GRASS_GLSL + '\nvarying vec3 vBladeRoot;\nvarying float vBladeT;\n'
        )
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_COLOR)
        .replace(
          '#include <normal_fragment_begin>',
          '#include <normal_fragment_begin>\n' + FRAGMENT_NORMAL
        )
    }

    this.mesh = new Mesh(geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
  }

  /**
   * 葉を描く範囲の半径(m)を変える。葉の並びを作り直す。
   * 近く(FULL_RADIUS まで)はマス目に 1 枚ずつ。その外は 2 マスおき、さらに外は 4 マスおきにして、
   * 枚数が増えすぎないようにする。まばらにした分は、葉を太くして埋める
   */
  setRadius(radius: number): void {
    const spacing = this.options.spacing
    this.options.radius = radius
    const reach = Math.ceil(radius / spacing)
    const full = FULL_RADIUS / spacing
    const cells: number[] = []
    for (let iz = -reach; iz <= reach; iz++) {
      for (let ix = -reach; ix <= reach; ix++) {
        const d2 = ix * ix + iz * iz
        if (d2 > reach * reach) continue
        // 境目は、範囲を動かす刻みの分だけ余裕を持たせる(消え方はシェーダーが距離で決める)
        const d = Math.sqrt(d2) - PATCH_SNAP
        const step = d <= full ? 1 : d <= full * 2 ? 2 : 4
        // 範囲は PATCH_SNAP マスずつ動かすので、相対の番号で間引いても、同じ場所の葉が残る
        if ((ix & (step - 1)) !== 0 || (iz & (step - 1)) !== 0) continue
        cells.push(ix, iz)
      }
    }
    this.geometry.setAttribute('aCell', new InstancedBufferAttribute(new Float32Array(cells), 2))
    this.geometry.instanceCount = cells.length / 2
  }

  /** 葉の枚数 */
  get count(): number {
    return (this.mesh.geometry as InstancedBufferGeometry).instanceCount
  }

  /**
   * 毎フレーム呼ぶ。葉を描く範囲を、カメラが見ている地面に合わせる。
   * 離れて見るほど、葉の間隔と太さと範囲をまとめて大きくする(2 倍、4 倍、…)。
   * 葉の枚数はほぼ変わらないので、俯瞰のように遠くから広く見るときも、同じ重さで芝の質感が出る
   */
  update(camera: PerspectiveCamera, enabled: boolean): void {
    const position = camera.position
    camera.getWorldDirection(this.forward)
    const flat = Math.hypot(this.forward.x, this.forward.z)
    const height = Math.max(position.y - this.terrain.heightAt(position.x, position.z), 0.1)
    // 視線が地面(カメラの真下と同じ高さの水平面とみなす)に当たるまでの、水平の距離
    const reach = this.forward.y < -1e-3 ? (height * flat) / -this.forward.y : Infinity

    // 見ている地面までの距離を、35 mm のレンズで見たときの距離に直す(望遠ほど大きく写るので、近いのと同じ)
    const sight = Math.hypot(Math.min(reach, 4000), height) * (35 / camera.getFocalLength())
    // 段を決める。境目で行き来してちらつかないよう、今の段から動くには 15% の余裕を越える必要がある
    let level = this.level
    while (level < MAX_LEVEL && sight > LEVEL_DISTANCE * 2 ** level * 1.15) level++
    while (level > 0 && sight < LEVEL_DISTANCE * 2 ** (level - 1) * 0.85) level--
    this.level = level
    const scale = 2 ** level
    const spacing = this.options.spacing * scale
    const radius = this.options.radius * scale
    this.scale.value = scale
    this.ground.uBladeRadius.value = radius

    // 範囲の中心は、視線が地面に当たる所。遠くを見ているときは、カメラの少し前に置く。
    // 葉が密なのは中心のまわり(FULL_RADIUS まで)なので、中心をカメラから離しすぎると、手前の葉がまばらになる。
    // 描く距離(radius)を伸ばしても中心は動かさず、外側へ広がるだけにする
    const ahead = Math.min(reach, FULL_RADIUS * scale * 0.75, radius * 0.75)
    const cx = position.x + (flat > 1e-4 ? (this.forward.x / flat) * ahead : 0)
    const cz = position.z + (flat > 1e-4 ? (this.forward.z / flat) * ahead : 0)
    this.mesh.visible = enabled
    this.ground.uBladeAmount.value = enabled ? 1 : 0
    this.ground.uBladeCenter.value.set(cx, cz)
    this.patchCell.set(
      Math.floor(cx / spacing / PATCH_SNAP) * PATCH_SNAP,
      Math.floor(cz / spacing / PATCH_SNAP) * PATCH_SNAP
    )
  }
}
