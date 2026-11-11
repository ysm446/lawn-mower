// 地面。地形の高さから面を作り、標準の物理ベースマテリアルに、
// 芝状態マップによる色と縞の計算を差し込む。状態マップは真上から地形に投影する。
// 縞は現実と同じ理屈で出す。芝が見る人から遠ざかる向きに倒れていると明るく、
// 手前に倒れていると暗く見える。

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector2,
  type Texture
} from 'three'
import type { Terrain } from '../sim/terrain'
import type { MowMap } from './mowMap'

export interface GroundUniforms {
  uStripe: { value: number }
  uTilt: { value: number }
  /** 区分けの色を重ねる強さ(0 で表示しない) */
  uZoneOverlay: { value: number }
}

export interface Ground {
  mesh: Mesh
  uniforms: GroundUniforms
}

const FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D uMowMap;
uniform vec2 uMowOrigin;
uniform float uMowSize;
uniform float uMaxHeight;
uniform float uUncutNorm;
uniform float uStripe;
uniform float uTilt;
uniform sampler2D uZoneMap;
uniform float uZoneOrigin;
uniform float uZoneSize;
uniform float uZoneOverlay;
varying vec3 vMowWorld;

float mowHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float mowNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mowHash(i);
  float b = mowHash(i + vec2(1.0, 0.0));
  float c = mowHash(i + vec2(0.0, 1.0));
  float d = mowHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`

const FRAGMENT_COLOR = /* glsl */ `
vec2 mowUv = (vMowWorld.xz - uMowOrigin) / uMowSize;
vec4 mowState = vec4(0.5, 0.5, 0.0, uUncutNorm);
if (mowUv.x > 0.0 && mowUv.x < 1.0 && mowUv.y > 0.0 && mowUv.y < 1.0) {
  mowState = texture2D(uMowMap, mowUv);
}
vec2 mowLean = mowState.rg * 2.0 - 1.0;
float mowHeight = mowState.a * uMaxHeight;

float mowDist = length(vMowWorld - cameraPosition);
float nLarge = mowNoise(vMowWorld.xz * 0.07);
float nMid = mowNoise(vMowWorld.xz * 1.3);
float nFine = mowNoise(vMowWorld.xz * 31.0);
float fineFade = 1.0 - smoothstep(15.0, 70.0, mowDist);

// 伸びた芝は暗く黄みがかってむらがあり、刈った芝は明るく均一
vec3 longColor = mix(vec3(0.060, 0.115, 0.022), vec3(0.135, 0.185, 0.040), nLarge * 0.6 + nMid * 0.4);
vec3 cutColor = mix(vec3(0.074, 0.185, 0.028), vec3(0.092, 0.212, 0.035), nLarge);
float tall = smoothstep(0.02, 0.06, mowHeight);
vec3 grassColor = mix(cutColor, longColor, tall);
grassColor *= 1.0 + (nFine - 0.5) * mix(0.25, 0.6, tall) * fineFade;

// 縞: 倒れた向きと視線の向きの関係で明暗をつける
vec3 mowToFrag = normalize(vMowWorld - cameraPosition);
float stripe = dot(mowLean, mowToFrag.xz);
grassColor *= 1.0 + uStripe * stripe;

// 区分けの色を重ねる
vec2 zoneUv = (vMowWorld.xz - uZoneOrigin) / uZoneSize;
if (uZoneOverlay > 0.0 && zoneUv.x > 0.0 && zoneUv.x < 1.0 && zoneUv.y > 0.0 && zoneUv.y < 1.0) {
  vec4 zoneColor = texture2D(uZoneMap, zoneUv);
  grassColor = mix(grassColor, zoneColor.rgb * 0.6, zoneColor.a * uZoneOverlay);
}

diffuseColor.rgb = grassColor;
`

const FRAGMENT_NORMAL = /* glsl */ `
// 倒れた芝の上面は、倒れた向きと逆側に傾く。太陽の向きによる明暗の差になる
vec3 mowTilt = vec3(-mowLean.x, 0.0, -mowLean.y) * uTilt;
normal = normalize(normal + (viewMatrix * vec4(mowTilt, 0.0)).xyz);
`

/**
 * 格子の座標の並びを作る。地形の格子の範囲は格子と同じ間隔で刻み、
 * その外側は遠くなるほど粗くする(遠景は細かさが要らないため)。
 */
function gridCoordinates(terrain: Terrain, extent: number): Float32Array {
  const { size, cell } = terrain.options
  const half = size / 2
  const outer: number[] = []
  let step = cell
  let at = half
  while (at < extent / 2) {
    step *= 1.1
    at += step
    outer.push(at)
  }
  const inner = terrain.samples
  const coords = new Float32Array(inner + outer.length * 2)
  for (let i = 0; i < outer.length; i++) {
    coords[outer.length - 1 - i] = -outer[i]
    coords[outer.length + inner + i] = outer[i]
  }
  for (let i = 0; i < inner; i++) coords[outer.length + i] = -half + i * cell
  return coords
}

function createTerrainGeometry(terrain: Terrain, extent: number): BufferGeometry {
  const coords = gridCoordinates(terrain, extent)
  const n = coords.length
  const positions = new Float32Array(n * n * 3)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = (iz * n + ix) * 3
      positions[i] = coords[ix]
      positions[i + 1] = terrain.heightAt(coords[ix], coords[iz])
      positions[i + 2] = coords[iz]
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6)
  let k = 0
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices[k++] = a
      indices[k++] = c
      indices[k++] = b
      indices[k++] = b
      indices[k++] = c
      indices[k++] = d
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  return geometry
}

export function createGround(
  mowMap: MowMap,
  terrain: Terrain,
  zoneMap: Texture,
  extent: number,
  uncutHeight: number
): Ground {
  const o = mowMap.options
  const uniforms = {
    uMowMap: { value: mowMap.texture },
    uMowOrigin: { value: new Vector2(o.originX, o.originZ) },
    uMowSize: { value: o.size },
    uMaxHeight: { value: o.maxHeight },
    uUncutNorm: { value: uncutHeight / o.maxHeight },
    uStripe: { value: 0.24 },
    uTilt: { value: 0.2 },
    uZoneMap: { value: zoneMap },
    // テクセルの中心が格子点に重なるように、半マス分だけ広く取る
    uZoneOrigin: { value: terrain.origin - terrain.options.cell / 2 },
    uZoneSize: { value: terrain.options.size + terrain.options.cell },
    uZoneOverlay: { value: 0 }
  }

  const material = new MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMowWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_COLOR)
      .replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n' + FRAGMENT_NORMAL
      )
  }

  const mesh = new Mesh(createTerrainGeometry(terrain, extent), material)
  mesh.receiveShadow = true
  return { mesh, uniforms }
}
