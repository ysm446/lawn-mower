// 大気散乱。空の色を、太陽の光が大気で散らばる様子から計算する。
// モデルは terrain-graph(shaders/AtmosphereScattering.hlsli、AtmosphereMultiScatter.hlsl)と同じ。
//   単散乱: 視線に沿って、太陽の光が 1 回だけ散らばって目に届く分を積分する(Nishita)
//   多重散乱: 2 回以上散らばる分を、高さと太陽の高度ごとの表にしておく(Hillaire 2020)
// 毎画素で積分すると重いので、結果を小さな表(テクスチャ)に焼いて使う。
//   多重散乱の表: 霞の濃さが変わったときだけ作り直す
//   空の表: 全方位の空の色。太陽が動いたときだけ作り直す。空の描画と、霞の色が、これを引く
//   空の照度: 空の表を上半球で積分した値。空からの環境光に使う(CPU へ読み戻す)
// 値はどれも「大気の外での太陽の照度 1 lx あたり」で持ち、使う側で照度を掛ける。

import {
  ClampToEdgeWrapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer
} from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import {
  ATMOSPHERE_RADIUS,
  EARTH_RADIUS,
  MIE_BETA,
  MIE_EXTINCTION,
  MIE_HEIGHT,
  RAYLEIGH_BETA,
  RAYLEIGH_HEIGHT
} from '../sim/atmosphere'

/** 空を見上げる地点の高さ(m)。カメラの高さによる違いは小さいので、固定する */
const OBSERVER_HEIGHT = 60
/** ミー散乱の偏り(0 で全方向に均等、1 に近いほど前方に集まる)。太陽のまわりの明るいにじみの広さを決める */
const MIE_G = 0.8
/** 地面の反射率。多重散乱で、地面から照り返す分に使う */
const GROUND_ALBEDO = 0.15
const SKY_WIDTH = 256
const SKY_HEIGHT = 128
const MULTI_SIZE = 32
/** 太陽の向きがこれ以上変わったら、空の表を作り直す(向きの内積の差。約 0.05°) */
const SUN_EPSILON = 4e-7

const f = (value: number): string => value.toExponential(6)

/** 大気の定数と、光路の積分。表を作るシェーダーで共有する */
const ATMOSPHERE_GLSL = /* glsl */ `
const float EARTH_RADIUS = ${f(EARTH_RADIUS)};
const float ATMOSPHERE_RADIUS = ${f(ATMOSPHERE_RADIUS)};
const float RAYLEIGH_HEIGHT = ${f(RAYLEIGH_HEIGHT)};
const float MIE_HEIGHT = ${f(MIE_HEIGHT)};
const vec3 RAYLEIGH_BETA = vec3(${RAYLEIGH_BETA.map(f).join(', ')});
const float MIE_BETA = ${f(MIE_BETA)};
const float MIE_EXTINCTION = ${f(MIE_EXTINCTION)};
const float PI = 3.141592653589793;
uniform float uHaze; // 霞の濃さ(ミー散乱の倍率)

// 原点(地球の中心)を中心とする球と、視線の交点までの距離(手前、奥)。当たらなければ -1
vec2 raySphere(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float height = length(origin);
  float d = b * b - (height - radius) * (height + radius);
  if (d < 0.0) return vec2(-1.0);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}
// (1 - exp(-tau)) / tau。区間の中での減衰を、式で積分した重み
vec3 segmentWeight(vec3 tau) {
  return mix((1.0 - exp(-tau)) / max(tau, vec3(1e-6)), 1.0 - tau * 0.5, step(tau, vec3(0.001)));
}
// その地点に届く太陽の光の割合。地球に隠れるときは 0
vec3 sunTransmittanceAt(vec3 origin, vec3 sunDir) {
  vec2 hit = raySphere(origin, sunDir, ATMOSPHERE_RADIUS);
  if (hit.y <= 0.0 || raySphere(origin, sunDir, EARTH_RADIUS).x > 0.0) return vec3(0.0);
  float opticalR = 0.0;
  float opticalM = 0.0;
  for (int i = 0; i < SUN_STEPS; i++) {
    // 空気の濃い地表の近くに点を集める
    float u0 = float(i) / float(SUN_STEPS);
    float u1 = float(i + 1) / float(SUN_STEPS);
    float start = hit.y * u0 * u0;
    float end = hit.y * u1 * u1;
    float h = length(origin + sunDir * (0.5 * (start + end))) - EARTH_RADIUS;
    if (h < 0.0) return vec3(0.0);
    opticalR += exp(-h / RAYLEIGH_HEIGHT) * (end - start);
    opticalM += exp(-h / MIE_HEIGHT) * (end - start);
  }
  return exp(-RAYLEIGH_BETA * opticalR - MIE_BETA * uHaze * MIE_EXTINCTION * opticalM);
}
// 視線に沿った区間の端。地面に向かう視線では、地面の側に点を集める
float rayFraction(float u, bool hitGround) {
  return hitGround ? 1.0 - (1.0 - u) * (1.0 - u) : u * u;
}
`

/** 空の表を引く GLSL。方位は横、高度は縦で、地平線の近くを細かく持つ */
export const SKY_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uSkyView;
// dir は視線の向き(ワールド座標の単位ベクトル)。大気の外での照度 1 lx あたりの輝度を返す
vec3 atmosphereSky(vec3 dir) {
  float azimuth = atan(dir.z, dir.x);
  float elevation = asin(clamp(dir.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(elevation) * sqrt(abs(elevation) / 1.5707963);
  return texture2D(uSkyView, vec2(azimuth / 6.2831853 + 0.5, v)).rgb;
}
`

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// 多重散乱の表。横は太陽の天頂角の余弦、縦は高さ(平方根で、地表の近くを細かく)
const MULTI_FS = /* glsl */ `
#define SUN_STEPS 12
#define RAY_STEPS 16
#define SPHERE_SAMPLES 32
${ATMOSPHERE_GLSL}
varying vec2 vUv;
// 球面にほぼ均等に散らした向き
vec3 sphereSample(int i) {
  float a = float(i) + 0.5;
  float cosTheta = 1.0 - 2.0 * a / float(SPHERE_SAMPLES);
  float sinTheta = sqrt(clamp(1.0 - cosTheta * cosTheta, 0.0, 1.0));
  float phi = a * 2.39996322972865332;
  return vec3(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));
}
void main() {
  float cosSunZenith = vUv.x * 2.0 - 1.0;
  float altitude = vUv.y * vUv.y * (ATMOSPHERE_RADIUS - EARTH_RADIUS);
  vec3 origin = vec3(0.0, EARTH_RADIUS + altitude, 0.0);
  vec3 sunDir = vec3(sqrt(clamp(1.0 - cosSunZenith * cosSunZenith, 0.0, 1.0)), cosSunZenith, 0.0);
  vec3 sumL = vec3(0.0);
  vec3 sumF = vec3(0.0);
  for (int s = 0; s < SPHERE_SAMPLES; s++) {
    vec3 viewDir = sphereSample(s);
    vec2 hit = raySphere(origin, viewDir, ATMOSPHERE_RADIUS);
    if (hit.y <= 0.0) continue;
    vec2 earth = raySphere(origin, viewDir, EARTH_RADIUS);
    bool hitGround = earth.x > 0.0;
    float reach = hitGround ? min(hit.y, earth.x) : hit.y;
    vec3 transmission = vec3(1.0);
    for (int i = 0; i < RAY_STEPS; i++) {
      float start = reach * rayFraction(float(i) / float(RAY_STEPS), hitGround);
      float end = reach * rayFraction(float(i + 1) / float(RAY_STEPS), hitGround);
      vec3 position = origin + viewDir * (0.5 * (start + end));
      float height = max(length(position) - EARTH_RADIUS, 0.0);
      vec3 rayleigh = RAYLEIGH_BETA * exp(-height / RAYLEIGH_HEIGHT);
      float mie = MIE_BETA * uHaze * exp(-height / MIE_HEIGHT);
      vec3 tau = (rayleigh + MIE_EXTINCTION * mie) * (end - start);
      vec3 scattered = transmission * (rayleigh + mie) * (end - start) * segmentWeight(tau);
      sumF += scattered;
      sumL += scattered * sunTransmittanceAt(position, sunDir) / (4.0 * PI);
      transmission *= exp(-tau);
    }
    if (hitGround) {
      vec3 normal = normalize(origin + viewDir * reach);
      sumL += transmission * ${f(GROUND_ALBEDO)} / PI * clamp(dot(normal, sunDir), 0.0, 1.0)
        * sunTransmittanceAt(normal * (EARTH_RADIUS + 1.0), sunDir);
    }
  }
  // 何度も散らばる分は、同じ割合で減っていく等比級数として足し合わせる
  vec3 average = sumL / float(SPHERE_SAMPLES);
  vec3 feedback = sumF / float(SPHERE_SAMPLES);
  gl_FragColor = vec4(average / max(1.0 - feedback, vec3(1e-3)), 1.0);
}
`

// 空の表。全方位の空の輝度(照度 1 lx あたり)
const SKY_FS = /* glsl */ `
#define SUN_STEPS 16
#define VIEW_STEPS 32
${ATMOSPHERE_GLSL}
uniform sampler2D uMultiScatter;
uniform vec3 uSunDir;
varying vec2 vUv;
void main() {
  // 表の縦横から、視線の向きを求める(SKY_LOOKUP_GLSL の逆)
  float azimuth = (vUv.x - 0.5) * 2.0 * PI;
  float c = vUv.y * 2.0 - 1.0;
  float elevation = sign(c) * c * c * (PI * 0.5);
  vec3 viewDir = vec3(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));

  vec3 origin = vec3(0.0, EARTH_RADIUS + ${f(OBSERVER_HEIGHT)}, 0.0);
  vec2 hit = raySphere(origin, viewDir, ATMOSPHERE_RADIUS);
  vec2 earth = raySphere(origin, viewDir, EARTH_RADIUS);
  bool hitGround = earth.x > 0.0;
  float reach = hitGround ? min(hit.y, earth.x) : hit.y;
  float mu = dot(viewDir, uSunDir);
  float phaseR = 0.0596831037 * (1.0 + mu * mu);
  float g = ${f(MIE_G)};
  float phaseM = 0.0795774715 * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-6), 1.5);
  vec3 transmission = vec3(1.0);
  vec3 radiance = vec3(0.0);
  for (int i = 0; i < VIEW_STEPS; i++) {
    float start = reach * rayFraction(float(i) / float(VIEW_STEPS), hitGround);
    float end = reach * rayFraction(float(i + 1) / float(VIEW_STEPS), hitGround);
    vec3 position = origin + viewDir * (0.5 * (start + end));
    float height = max(length(position) - EARTH_RADIUS, 0.0);
    vec3 rayleigh = RAYLEIGH_BETA * exp(-height / RAYLEIGH_HEIGHT);
    float mie = MIE_BETA * uHaze * exp(-height / MIE_HEIGHT);
    vec3 tau = (rayleigh + MIE_EXTINCTION * mie) * (end - start);
    vec3 source = sunTransmittanceAt(position, uSunDir) * (rayleigh * phaseR + mie * phaseM);
    // 多重散乱の表(横は太陽の天頂角の余弦、縦は高さの平方根)
    vec2 multiUv = vec2(
      clamp(dot(normalize(position), uSunDir) * 0.5 + 0.5, 0.0, 1.0),
      sqrt(clamp(height / (ATMOSPHERE_RADIUS - EARTH_RADIUS), 0.0, 1.0)));
    source += texture2D(uMultiScatter, multiUv).rgb * (rayleigh + mie);
    radiance += transmission * source * (end - start) * segmentWeight(tau);
    transmission *= exp(-tau);
  }
  gl_FragColor = vec4(radiance, 1.0);
}
`

// 空の照度。空の表を、上半球について、面の傾きの分(余弦)を掛けて積分する
const IRRADIANCE_FS = /* glsl */ `
#define SAMPLES 96
${SKY_LOOKUP_GLSL}
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    // 上半球に、立体角が均等になるように散らした向き
    float a = float(i) + 0.5;
    float cosTheta = a / float(SAMPLES);
    float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    float phi = a * 2.39996322972865332;
    sum += atmosphereSky(vec3(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi))) * cosTheta;
  }
  gl_FragColor = vec4(sum * 6.2831853 / float(SAMPLES), 1.0);
}
`

export class Atmosphere {
  /** 空の表(全方位の空の輝度。照度 1 lx あたり)。空の描画と霞の色が引く */
  readonly skyView: Texture
  /** 空の照度(上を向いた面が、空の全体から受ける照度。照度 1 lx あたり)。赤、緑、青 */
  readonly skyIrradiance = new Vector3(0.05, 0.07, 0.1)
  private readonly multiTarget: WebGLRenderTarget
  private readonly skyTarget: WebGLRenderTarget
  private readonly irradianceTarget: WebGLRenderTarget
  private readonly multiQuad: FullScreenQuad
  private readonly skyQuad: FullScreenQuad
  private readonly irradianceQuad: FullScreenQuad
  private readonly hazeUniform = { value: 1 }
  private readonly sunUniform = { value: new Vector3(0, 1, 0) }
  private readonly lastSun = new Vector3()
  private lastHaze = -1
  private readonly pixel = new Float32Array(4)

  constructor() {
    const target = (width: number, height: number, type: typeof FloatType | typeof HalfFloatType): WebGLRenderTarget =>
      new WebGLRenderTarget(width, height, {
        type,
        format: RGBAFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: ClampToEdgeWrapping,
        wrapT: ClampToEdgeWrapping,
        depthBuffer: false,
        generateMipmaps: false
      })
    this.multiTarget = target(MULTI_SIZE, MULTI_SIZE, HalfFloatType)
    this.skyTarget = target(SKY_WIDTH, SKY_HEIGHT, HalfFloatType)
    // 方位は一周してつながる
    this.skyTarget.texture.wrapS = RepeatWrapping
    this.irradianceTarget = target(1, 1, FloatType)
    this.irradianceTarget.texture.minFilter = NearestFilter
    this.irradianceTarget.texture.magFilter = NearestFilter
    this.skyView = this.skyTarget.texture

    const material = (fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial =>
      new ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false })
    this.multiQuad = new FullScreenQuad(material(MULTI_FS, { uHaze: this.hazeUniform }))
    this.skyQuad = new FullScreenQuad(
      material(SKY_FS, {
        uHaze: this.hazeUniform,
        uSunDir: this.sunUniform,
        uMultiScatter: { value: this.multiTarget.texture }
      })
    )
    this.irradianceQuad = new FullScreenQuad(material(IRRADIANCE_FS, { uSkyView: { value: this.skyView } }))
  }

  /**
   * 太陽の向きか霞の濃さが変わっていたら、表を作り直す。毎フレーム呼ぶ。
   * sunDir は地面から太陽へ向かう単位ベクトル。作り直したら true を返す。
   */
  update(renderer: WebGLRenderer, sunDir: Vector3, haze: number): boolean {
    const hazeChanged = haze !== this.lastHaze
    if (!hazeChanged && this.lastSun.distanceToSquared(sunDir) < SUN_EPSILON) return false
    this.lastSun.copy(sunDir)
    this.lastHaze = haze
    this.hazeUniform.value = haze
    this.sunUniform.value.copy(sunDir)

    const previous = renderer.getRenderTarget()
    if (hazeChanged) {
      renderer.setRenderTarget(this.multiTarget)
      this.multiQuad.render(renderer)
    }
    renderer.setRenderTarget(this.skyTarget)
    this.skyQuad.render(renderer)
    renderer.setRenderTarget(this.irradianceTarget)
    this.irradianceQuad.render(renderer)
    renderer.readRenderTargetPixels(this.irradianceTarget, 0, 0, 1, 1, this.pixel)
    this.skyIrradiance.set(this.pixel[0], this.pixel[1], this.pixel[2])
    renderer.setRenderTarget(previous)
    return true
  }
}
