// 近景の芝の葉。注視点のまわりだけ、葉を 1 枚ずつインスタンシングで描く。
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
  type Vector3
} from 'three'
import type { Terrain } from '../sim/terrain'
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

/** カメラがこれより離れたら葉を描かない(m)。1 画素より細くなって、ちらつくだけになるため */
const HIDE_DISTANCE = 70
/** この距離から、葉を少しずつ低くして消していく(m) */
const FADE_DISTANCE = 30

const VERTEX_HEADER = /* glsl */ `
attribute vec2 aCell;
uniform sampler2D uHeightMap;
uniform float uHeightOrigin;
uniform float uHeightCell;
uniform vec2 uPatchCell;
uniform float uSpacing;
uniform float uBladeWidth;
uniform sampler2D uMowMap;
uniform vec2 uMowOrigin;
uniform float uMowSize;
uniform float uMaxHeight;
uniform float uUncutNorm;
uniform vec2 uBladeCenter;
uniform float uBladeRadius;
uniform float uBladeAmount;
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
vec2 bladeRoot = (bladeCell + vec2(rndA, rndB)) * uSpacing;
float groundY = terrainHeight(bladeRoot);

vec2 mowUv = (bladeRoot - uMowOrigin) / uMowSize;
vec4 bladeState = vec4(0.5, 0.5, 0.0, uUncutNorm);
if (mowUv.x > 0.0 && mowUv.x < 1.0 && mowUv.y > 0.0 && mowUv.y < 1.0) {
  bladeState = texture2D(uMowMap, mowUv);
}
vec2 bladeLean = bladeState.rg * 2.0 - 1.0;
float bladeHeight = bladeState.a * uMaxHeight;
float bladeCut = 1.0 - smoothstep(0.02, 0.06, bladeHeight);

// 範囲の縁に向かって葉を低くし、境目を目立たなくする
float bladeFade = uBladeAmount * (1.0 - smoothstep(uBladeRadius * 0.6, uBladeRadius, length(bladeRoot - uBladeCenter)));
// 伸びた芝は高さも向きもばらつく。刈った芝は揃っている
// 刈った芝も、刈高ぴったりには揃わない。刃を逃れて少し長く残る葉もまばらにある
float rndD = bladeHash(bladeCell + 73.9);
float cutVary = 0.7 + 0.6 * rndC + step(0.965, rndD) * (0.8 + 1.2 * rndA);
// 伸びた芝は、場所によって長さが違う。数 m ごとの株のかたまりと、もっと大きな広がりで変える
float lengthPatch = bladeNoise(bladeRoot * 0.35 + 9.2) * 0.6 + bladeNoise(bladeRoot * 0.07 + 4.4) * 0.4;
float longVary = (0.55 + 0.9 * rndC) * mix(0.4, 1.75, lengthPatch);
bladeHeight *= mix(longVary, cutVary, bladeCut) * bladeFade;
float wild = (1.0 - bladeCut) * 0.55 + 0.08;
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
vec3 freeNormal = terrainNormal * (0.7 + 0.5 * position.y) + faceNormal * 0.55 - bendTilt * 0.5;
// 寝た葉の表面は、倒れた向きと逆側へ傾いた上向きになる。縞の明暗はここから生まれる
vec3 laidNormal = terrainNormal * (0.25 + sin(layAngle)) - vec3(leanDir.x, 0.0, leanDir.y) * cos(layAngle) * 0.8
  + faceNormal * 0.2;
objectNormal = normalize(mix(freeNormal, laidNormal, laid));
`

const VERTEX_POSITION = /* glsl */ `
float bladeT = position.y;
vec2 bladeSide = widthDir * position.x * uBladeWidth * step(0.001, bladeHeight);
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

  constructor(
    terrain: Terrain,
    private readonly ground: GroundUniforms,
    private readonly options: GrassBladeOptions = DEFAULT_GRASS_BLADES
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
    const reach = Math.ceil(radius / spacing)
    const cells: number[] = []
    for (let iz = -reach; iz <= reach; iz++) {
      for (let ix = -reach; ix <= reach; ix++) {
        if (ix * ix + iz * iz <= reach * reach) cells.push(ix, iz)
      }
    }
    geometry.setAttribute('aCell', new InstancedBufferAttribute(new Float32Array(cells), 2))
    geometry.instanceCount = cells.length / 2

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

    ground.uBladeRadius.value = radius
    const uniforms = {
      ...ground,
      uHeightMap: { value: heightMap },
      uHeightOrigin: { value: terrain.origin },
      uHeightCell: { value: terrain.options.cell },
      uPatchCell: { value: this.patchCell },
      uSpacing: { value: spacing },
      uBladeWidth: { value: options.bladeWidth }
    }

    const material = new MeshStandardMaterial({ roughness: 0.38, metalness: 0, side: DoubleSide })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERTEX_HEADER)
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

  /** 葉の枚数 */
  get count(): number {
    return (this.mesh.geometry as InstancedBufferGeometry).instanceCount
  }

  /** 毎フレーム呼ぶ。葉を描く範囲を注視点に合わせる */
  update(focus: Vector3, cameraPosition: Vector3, enabled: boolean): void {
    const distance = cameraPosition.distanceTo(focus)
    const visible = enabled && distance < HIDE_DISTANCE
    this.mesh.visible = visible
    const t = Math.min(Math.max((distance - FADE_DISTANCE) / (HIDE_DISTANCE - FADE_DISTANCE), 0), 1)
    this.ground.uBladeAmount.value = visible ? 1 - t * t * (3 - 2 * t) : 0
    this.ground.uBladeCenter.value.set(focus.x, focus.z)
    this.patchCell.set(
      Math.floor(focus.x / this.options.spacing),
      Math.floor(focus.z / this.options.spacing)
    )
  }
}
