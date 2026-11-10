// 地面。標準の物理ベースマテリアルに、芝状態マップによる色と縞の計算を差し込む。
// 縞は現実と同じ理屈で出す。芝が見る人から遠ざかる向きに倒れていると明るく、
// 手前に倒れていると暗く見える。

import { Mesh, MeshStandardMaterial, PlaneGeometry, Vector2 } from 'three'
import type { MowMap } from './mowMap'

export interface GroundUniforms {
  uStripe: { value: number }
  uTilt: { value: number }
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

diffuseColor.rgb = grassColor;
`

const FRAGMENT_NORMAL = /* glsl */ `
// 倒れた芝の上面は、倒れた向きと逆側に傾く。太陽の向きによる明暗の差になる
vec3 mowTilt = vec3(-mowLean.x, 0.0, -mowLean.y) * uTilt;
normal = normalize(normal + (viewMatrix * vec4(mowTilt, 0.0)).xyz);
`

export function createGround(mowMap: MowMap, extent: number, uncutHeight: number): Ground {
  const o = mowMap.options
  const uniforms = {
    uMowMap: { value: mowMap.texture },
    uMowOrigin: { value: new Vector2(o.originX, o.originZ) },
    uMowSize: { value: o.size },
    uMaxHeight: { value: o.maxHeight },
    uUncutNorm: { value: uncutHeight / o.maxHeight },
    uStripe: { value: 0.24 },
    uTilt: { value: 0.2 }
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

  const geometry = new PlaneGeometry(extent, extent)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new Mesh(geometry, material)
  mesh.receiveShadow = true
  return { mesh, uniforms }
}
