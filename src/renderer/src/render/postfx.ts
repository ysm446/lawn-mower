// 描いた後の画像に掛ける処理。測光(自動露出のための明るさの計測)と被写界深度。
// どちらもトーンマッピングの前、HDR の画像に対して行う。

import {
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer
} from 'three'
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js'

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// ------------------------------------------------ 測光

const METER_WIDTH = 64
const METER_HEIGHT = 36
/** 明るさの対数(log2)を 0〜1 に収めるときの範囲 */
const METER_LOG_MIN = -20
const METER_LOG_RANGE = 40

const METER_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  float luminance = dot(texture2D(tDiffuse, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  float v = clamp((log2(max(luminance, 1e-6)) - (${METER_LOG_MIN}.0)) / ${METER_LOG_RANGE}.0, 0.0, 1.0);
  // 8 bit では粗いので、2 つのチャンネルに分けて持つ
  float scaled = v * 255.0;
  gl_FragColor = vec4(floor(scaled) / 255.0, fract(scaled), 0.0, 1.0);
}
`

/**
 * 画面の明るさを測る。画像を小さく縮めて読み戻し、中央に重みを置いた
 * 「明るさの対数の平均」を求める(対数で平均すると、空などの明るい所に引きずられにくい)。
 */
export class MeterPass extends Pass {
  /** 測った値(描画バッファの値の log2)。まだ測っていなければ null */
  log2Average: number | null = null
  /** 何フレームおきに測るか */
  interval = 3
  private readonly target = new WebGLRenderTarget(METER_WIDTH, METER_HEIGHT, {
    type: UnsignedByteType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false
  })
  private readonly material = new ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: METER_FRAGMENT,
    uniforms: { tDiffuse: { value: null } },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false
  })
  private readonly quad = new FullScreenQuad(this.material)
  private readonly pixels = new Uint8Array(METER_WIDTH * METER_HEIGHT * 4)
  private readonly weights = new Float32Array(METER_WIDTH * METER_HEIGHT)
  private weightSum = 0
  private frame = 0

  constructor() {
    super()
    this.needsSwap = false
    for (let y = 0; y < METER_HEIGHT; y++) {
      for (let x = 0; x < METER_WIDTH; x++) {
        const dx = (x + 0.5) / METER_WIDTH - 0.5
        const dy = (y + 0.5) / METER_HEIGHT - 0.5
        const w = Math.exp(-(dx * dx + dy * dy) * 6)
        this.weights[y * METER_WIDTH + x] = w
        this.weightSum += w
      }
    }
  }

  render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget
  ): void {
    if (this.frame++ % this.interval !== 0) return
    this.material.uniforms.tDiffuse.value = readBuffer.texture
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
    renderer.readRenderTargetPixels(this.target, 0, 0, METER_WIDTH, METER_HEIGHT, this.pixels)
    let sum = 0
    for (let i = 0; i < this.weights.length; i++) {
      const v = (this.pixels[i * 4] + this.pixels[i * 4 + 1] / 255) / 255
      sum += v * this.weights[i]
    }
    this.log2Average = (sum / this.weightSum) * METER_LOG_RANGE + METER_LOG_MIN
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
    this.quad.dispose()
  }
}

// ------------------------------------------------ 被写界深度

const DOF_SAMPLES = 80

const DOF_FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uFocalLength;   // m
uniform float uFNumber;
uniform float uSensorWidth;   // m
uniform float uFocusDistance; // m。画面中央の視線に沿った距離
uniform float uScale;         // ミニチュア倍率
uniform float uTanTilt;
uniform float uTanHalfFovY;
uniform float uMaxRadius;     // ピクセル
varying vec2 vUv;

float viewDistance(vec2 uv) {
  float depth = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(depth, uNear, uFar);
}

// ぼけの半径(ピクセル)。薄いレンズの式による。
// ミニチュア倍率は「被写体が 1 / 倍率 の大きさの模型で、その分だけ近くにある」とみなす
float blurRadius(float dist, vec2 uv) {
  // ティルト: ピントの合う面を傾けると、画面の上下でピントの距離が変わる
  float rayY = (uv.y * 2.0 - 1.0) * uTanHalfFovY;
  float focus = uFocusDistance / max(1.0 + rayY * uTanTilt, 0.05);
  float s = max(focus / uScale, uFocalLength * 1.5);
  float d = max(dist / uScale, 1e-4);
  float coc = uFocalLength * uFocalLength * abs(d - s) / (uFNumber * d * (s - uFocalLength));
  return min(0.5 * coc / uSensorWidth * uResolution.x, uMaxRadius);
}

void main() {
  float centerDist = viewDistance(vUv);
  float centerSize = blurRadius(centerDist, vUv);
  vec3 color = texture2D(tDiffuse, vUv).rgb;
  float total = 1.0;
  // 黄金角のらせんで、円盤の中をまんべんなく拾う
  const float GOLDEN_ANGLE = 2.39996323;
  // 拾う位置を画素ごとに回す。全画素で同じ並びだと、拾い残しが規則的な粒になって見える
  float spin = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  for (int i = 1; i < ${DOF_SAMPLES}; i++) {
    float t = float(i) / float(${DOF_SAMPLES});
    float radius = sqrt(t) * uMaxRadius;
    float angle = float(i) * GOLDEN_ANGLE + spin;
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * radius / uResolution;
    vec3 sampleColor = texture2D(tDiffuse, uv).rgb;
    float sampleDist = viewDistance(uv);
    float sampleSize = blurRadius(sampleDist, uv);
    // 奥にあるものは、手前のくっきりしたものの上にはにじませない
    if (sampleDist > centerDist) sampleSize = min(sampleSize, centerSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
    color += mix(color / total, sampleColor, m);
    total += 1.0;
  }
  // ぼけの大きさを次の段(仕上げのぼかし)に渡す
  gl_FragColor = vec4(color / total, centerSize / uMaxRadius);
}
`

// 仕上げ: 拾った点と点のすき間を、ぼけの大きさに応じた小さなぼかしで埋める
const DOF_FILL_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uMaxRadius;
varying vec2 vUv;
void main() {
  vec4 center = texture2D(tDiffuse, vUv);
  float reach = center.a * uMaxRadius * 0.22;
  vec3 color = center.rgb * 4.0;
  float total = 4.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec4 s = texture2D(tDiffuse, vUv + vec2(float(x), float(y)) * reach / uResolution);
      // くっきりした所(ぼけの小さい所)の色は、ぼけた所へ混ぜない
      float w = (x == 0 || y == 0 ? 2.0 : 1.0) * smoothstep(0.0, 0.5, s.a / max(center.a, 1e-3));
      color += s.rgb * w;
      total += w;
    }
  }
  gl_FragColor = vec4(color / total, 1.0);
}
`

export interface DofSettings {
  /** 焦点距離(mm) */
  focalLength: number
  fNumber: number
  /** センサーの幅(mm) */
  sensorWidth: number
  /** ピントを合わせる距離(m) */
  focusDistance: number
  /** ミニチュア倍率 */
  scale: number
  /** ティルト(度) */
  tiltDeg: number
  /** 縦の画角(度) */
  fovY: number
  near: number
  far: number
}

/** 被写界深度。深度から画素ごとのぼけの大きさを求め、その範囲の色を集めてぼかす */
export class DofPass extends Pass {
  private readonly material = new ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: DOF_FRAGMENT,
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uResolution: { value: new Vector2(1, 1) },
      uNear: { value: 0.3 },
      uFar: { value: 6000 },
      uFocalLength: { value: 0.05 },
      uFNumber: { value: 5.6 },
      uSensorWidth: { value: 0.036 },
      uFocusDistance: { value: 10 },
      uScale: { value: 1 },
      uTanTilt: { value: 0 },
      uTanHalfFovY: { value: 0.4 },
      uMaxRadius: { value: 16 }
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false
  })
  private readonly quad = new FullScreenQuad(this.material)
  private readonly fillMaterial = new ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: DOF_FILL_FRAGMENT,
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: new Vector2(1, 1) },
      uMaxRadius: { value: 16 }
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false
  })
  private readonly fillQuad = new FullScreenQuad(this.fillMaterial)
  private readonly intermediate = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false
  })

  setSize(width: number, height: number): void {
    this.intermediate.setSize(width, height)
    this.fillMaterial.uniforms.uResolution.value.set(width, height)
    this.fillMaterial.uniforms.uMaxRadius.value = Math.max(4, height * 0.016)
    this.material.uniforms.uResolution.value.set(width, height)
    // ぼけの上限は画面の高さに比例させる
    this.material.uniforms.uMaxRadius.value = Math.max(4, height * 0.016)
  }

  update(s: DofSettings): void {
    const u = this.material.uniforms
    u.uFocalLength.value = s.focalLength / 1000
    u.uFNumber.value = s.fNumber
    u.uSensorWidth.value = s.sensorWidth / 1000
    u.uFocusDistance.value = s.focusDistance
    u.uScale.value = s.scale
    u.uTanTilt.value = Math.tan((s.tiltDeg * Math.PI) / 180)
    u.uTanHalfFovY.value = Math.tan((s.fovY * Math.PI) / 360)
    u.uNear.value = s.near
    u.uFar.value = s.far
  }

  render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture
    this.material.uniforms.tDepth.value = readBuffer.depthTexture
    renderer.setRenderTarget(this.intermediate)
    this.quad.render(renderer)
    this.fillMaterial.uniforms.tDiffuse.value = this.intermediate.texture
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.fillQuad.render(renderer)
  }

  dispose(): void {
    this.material.dispose()
    this.quad.dispose()
    this.fillMaterial.dispose()
    this.fillQuad.dispose()
    this.intermediate.dispose()
  }
}
