// 画面の上で一定の太さを持つ線(帯)。範囲の縁取り、矢印の縁取り、移動の経路の破線に使う。
// weather-globe の highlights.ts と同じ描き方: 線分ごとに画面上で幅を持たせた帯にし、
// 中心を白に寄せ、縁を色のまま薄くして、光る管のような質感にする。
// WebGL の普通の線は 1 画素の太さにしかならないので、この形にしている。

import {
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2
} from 'three'

/** 重ねて描くものの色。彩度を少し落とし、明るさをそろえた色(weather-globe と同じ) */
export const OVERLAY_PALETTE = {
  sky: '#8ec5ff',
  teal: '#6fd3c4',
  gold: '#e6b862',
  coral: '#f0917e',
  violet: '#b7a5ff',
  leaf: '#a4d48c',
  snow: '#e9eef6'
} as const

/** 描画先の大きさ(画素)。帯の太さを画素で決めるために、すべての帯で共有する */
export const overlayResolution = new Vector2(1, 1)
/** 帯の太さに掛ける倍率(高精細の画面で細くなりすぎないように、画素の密度を入れる) */
export const overlayPixelRatio = { value: 1 }

const RIBBON_VS = /* glsl */ `
attribute vec2 corner; // x: 線分の始点 0 / 終点 1、y: 帯の左右 -1 / 1
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aProgress; // 線分の始点と終点の進み具合
attribute vec3 aColor;
uniform vec2 uResolution;
uniform float uWidth;
uniform float uPixelRatio;
varying float vProgress;
varying float vSide;
varying vec3 vColor;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(aStart, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);
  vec2 dir = (b.xy / b.w - a.xy / a.w) * uResolution;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 p = mix(a, b, corner.x);
  // 帯の幅と、つなぎ目が欠けないよう線分の両端を半分の幅だけ伸ばす分(画素から NDC へ)
  float width = uWidth * uPixelRatio;
  vec2 offset = normal * corner.y * width * 0.5 + dir * (corner.x * 2.0 - 1.0) * width * 0.5;
  p.xy += offset / uResolution * 2.0 * p.w;
  gl_Position = p;
  vProgress = mix(aProgress.x, aProgress.y, corner.x);
  vSide = corner.y;
  vColor = aColor;
}
`

const RIBBON_FS = /* glsl */ `
uniform float uOpacity;
uniform float uDashes; // 破線の切れ目の数(進み具合 0〜1 の間に並ぶ数)。0 で実線
uniform float uDone;   // この進み具合までは「済んだ所」として薄く描く
uniform float uFade;   // 全体の濃さ(0〜1)。現れるときと消えるときに変える
varying float vProgress;
varying float vSide;
varying vec3 vColor;
void main() {
  if (uDashes > 0.0 && fract(vProgress * uDashes) > 0.6) discard;
  float side = abs(vSide);
  float edge = 1.0 - smoothstep(0.15, 1.0, side);
  // 中心は白に寄せて明るさを保ち、縁は色のまま薄くする
  float peak = max(max(vColor.r, vColor.g), vColor.b);
  vec3 color = mix(vColor, vec3(peak), 0.25 * (1.0 - smoothstep(0.0, 0.55, side)));
  float done = vProgress < uDone ? 0.14 : 1.0;
  gl_FragColor = vec4(color, edge * uOpacity * done * uFade);
}
`

/** 線分 1 本。位置はワールド座標 */
export interface RibbonSegments {
  starts: number[]
  ends: number[]
  /** 線分ごとに、始点と終点の進み具合 */
  progress: number[]
  /** 線分ごとの色(r, g, b) */
  colors: number[]
}

export function emptySegments(): RibbonSegments {
  return { starts: [], ends: [], progress: [], colors: [] }
}

export interface RibbonOptions {
  /** 太さ(画素) */
  width: number
  opacity?: number
}

export class Ribbon {
  readonly mesh: Mesh
  private readonly material: ShaderMaterial

  constructor(options: RibbonOptions) {
    this.material = new ShaderMaterial({
      uniforms: {
        uResolution: { value: overlayResolution },
        uPixelRatio: overlayPixelRatio,
        uWidth: { value: options.width },
        uOpacity: { value: options.opacity ?? 1 },
        uDashes: { value: 0 },
        uDone: { value: 0 },
        uFade: { value: 1 }
      },
      vertexShader: RIBBON_VS,
      fragmentShader: RIBBON_FS,
      transparent: true,
      depthWrite: false
    })
    this.mesh = new Mesh(new InstancedBufferGeometry(), this.material)
    this.mesh.frustumCulled = false
  }

  set dashes(count: number) {
    this.material.uniforms.uDashes.value = count
  }

  /** 全体の濃さ(0〜1) */
  set fade(value: number) {
    this.material.uniforms.uFade.value = value
  }

  set done(progress: number) {
    this.material.uniforms.uDone.value = progress
  }

  setSegments(segments: RibbonSegments): void {
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('corner', new Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.setAttribute('aStart', new InstancedBufferAttribute(new Float32Array(segments.starts), 3))
    geometry.setAttribute('aEnd', new InstancedBufferAttribute(new Float32Array(segments.ends), 3))
    geometry.setAttribute(
      'aProgress',
      new InstancedBufferAttribute(new Float32Array(segments.progress), 2)
    )
    geometry.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(segments.colors), 3))
    geometry.instanceCount = segments.starts.length / 3
    this.mesh.geometry.dispose()
    this.mesh.geometry = geometry
  }
}

/** 色を、シェーダーに渡す値(光の強さに比例する値)にする */
export function overlayColor(css: string): Color {
  return new Color(css)
}
