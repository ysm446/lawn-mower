// 太陽、空、雲、霧。明るさは現実に近い単位(照度 lx、輝度 cd/m²)で持ち、
// 描画の前にカメラの露出を掛ける。こうすると描画バッファの値が扱いやすい範囲に収まる。

import {
  BackSide,
  Color,
  FogExp2,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three'
import { CSM } from 'three/addons/csm/CSM.js'

/** 影を描く距離の上限(m)。これより遠くには影が落ちない */
const SHADOW_DISTANCE = 220
/** 影の段数。近くほど細かい影の地図を使う(カスケードシャドウマップ) */
const SHADOW_CASCADES = 3
const SUN_COLOR = new Color(1.0, 0.94, 0.84)
/** 低い太陽の色。高度が下がるほど、この色に寄る */
const LOW_SUN_COLOR = new Color(1.0, 0.6, 0.3)
/** この高度(度)より低いと、太陽の光が赤みを帯びて弱くなる */
const WARM_BELOW_DEG = 22
/** 雲の高さ(m)と、雲のかたまりの大きさの目安(m)、風の強さ 1 での流れる速さ(m/s) */
const CLOUD_HEIGHT = 1200
const CLOUD_SIZE = 520
const CLOUD_SPEED = 9
/** 雲の流れる向き(水平面の単位ベクトル) */
const CLOUD_HEADING = new Vector2(0.82, 0.57)

export interface LightingSettings {
  /** 太陽の高度(度) */
  sunElevation: number
  /** 太陽の方位(度)。+Z から +X 方向へ測る */
  sunAzimuth: number
  /** 太陽光の照度(lx)。光に垂直な面での値 */
  sunIlluminance: number
  /** 空からの照度(lx) */
  skyIlluminance: number
  /** 雲の量(0 で快晴、1 でほぼ曇り) */
  cloudCover: number
}

export const DEFAULT_LIGHTING: LightingSettings = {
  sunElevation: 28,
  sunAzimuth: 125,
  sunIlluminance: 90000,
  skyIlluminance: 18000,
  cloudCover: 0.35
}

// 空の輝度(cd/m²)
const ZENITH_LUMINANCE = new Color(900, 2100, 5200)
const HORIZON_LUMINANCE = new Color(6200, 7400, 8600)
// 太陽が低いときの地平線の輝度
const LOW_HORIZON_LUMINANCE = new Color(7600, 5600, 3600)

// 雲の濃さ。空に見える雲と、地面に落ちる雲の影で同じものを使うので、雲と影の位置が合う
const CLOUD_GLSL = /* glsl */ `
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform vec2 uCloudSun;
float cloudHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cloudNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), f.x),
    mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
// 雲の高さの水平面での位置 (m) から、雲の濃さ (0〜1) を求める
float cloudDensity(vec2 p) {
  if (uCloudCover <= 0.001) return 0.0;
  vec2 q = (p + uCloudOffset) / ${CLOUD_SIZE.toFixed(1)};
  float n = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    n += a * cloudNoise(q);
    q = mat2(1.6, 1.2, -1.2, 1.6) * q + 17.0;
    a *= 0.5;
  }
  n /= 0.9375;
  float t = mix(0.74, 0.3, uCloudCover);
  return smoothstep(t, t + 0.16, n);
}
// 地上の点に届く太陽の光の割合。太陽の方向へたどった先の雲の濃さで決まる
float cloudShadow(vec3 world) {
  vec2 p = world.xz + uCloudSun * (${CLOUD_HEIGHT.toFixed(1)} - world.y);
  return 1.0 - 0.7 * cloudDensity(p);
}
`

const CLOUD_VERTEX = /* glsl */ `
{
  vec4 cloudWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  cloudWorld = instanceMatrix * cloudWorld;
  #endif
  vCloudWorld = (modelMatrix * cloudWorld).xyz;
}
`

// 雲の影は太陽の光だけを弱める(空からの光はそのまま)
const CLOUD_FRAGMENT = /* glsl */ `
{
  float cloudLight = cloudShadow(vCloudWorld);
  reflectedLight.directDiffuse *= cloudLight;
  reflectedLight.directSpecular *= cloudLight;
}
`

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform float uExposure;
varying vec3 vDir;
${CLOUD_GLSL}
void main() {
  vec3 dir = normalize(vDir);
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.45);
  vec3 sky = mix(uHorizon, uZenith, t);
  float sunAmount = max(dot(dir, uSunDir), 0.0);
  sky += uHorizon * 1.5 * pow(sunAmount, 24.0);
  // 雲。視線が雲の高さの面に当たる所の濃さを見る。地平線の近くは霞に溶かす
  float cloud = 0.0;
  if (dir.y > 0.0) {
    vec2 hit = cameraPosition.xz + dir.xz / max(dir.y, 0.02) * (${CLOUD_HEIGHT.toFixed(1)} - cameraPosition.y);
    cloud = cloudDensity(hit) * smoothstep(0.03, 0.18, dir.y);
    vec3 cloudColor = uCloudLit * mix(1.0, 0.55, cloud);
    cloudColor += uCloudLit * 0.8 * pow(sunAmount, 8.0);
    sky = mix(sky, cloudColor, cloud * 0.94);
  }
  sky += vec3(1.0, 0.95, 0.85) * 400000.0 * smoothstep(0.9995, 0.9999, sunAmount) * (1.0 - cloud);
  gl_FragColor = vec4(sky * uExposure, 1.0);
}
`

export class Lighting {
  /** 太陽の光と影。カメラからの距離で 3 段に分け、段ごとに光源と影の地図を持つ */
  private readonly csm: CSM
  private readonly prepared = new WeakSet<Material>()
  readonly hemisphere = new HemisphereLight(new Color(0.62, 0.78, 1.0), new Color(0.2, 0.26, 0.12), 1)
  readonly sunDirection = new Vector3()
  private readonly fog = new FogExp2(0xffffff, 0.0009)
  private readonly sunColor = new Color()
  private readonly zenith = new Color()
  private readonly horizon = new Color()
  private readonly cloudLit = new Color()
  // 雲の位置。風で流れた分だけずらす。空と、影を受ける材質とで共有する
  private readonly cloudUniforms = {
    uCloudOffset: { value: new Vector2() },
    uCloudCover: { value: 0 },
    uCloudSun: { value: new Vector2() }
  }
  private readonly skyMaterial: ShaderMaterial
  private readonly sky: Mesh

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    readonly settings: LightingSettings = { ...DEFAULT_LIGHTING }
  ) {
    this.skyMaterial = new ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: this.zenith },
        uHorizon: { value: this.horizon },
        uSunDir: { value: this.sunDirection },
        uCloudLit: { value: this.cloudLit },
        uExposure: { value: 1 },
        ...this.cloudUniforms
      }
    })
    this.sky = new Mesh(new SphereGeometry(2500, 32, 16), this.skyMaterial)
    this.sky.frustumCulled = false
    this.sky.renderOrder = -1

    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: SHADOW_CASCADES,
      maxFar: SHADOW_DISTANCE,
      mode: 'practical',
      shadowMapSize: 2048,
      lightIntensity: 1,
      lightNear: 1,
      lightFar: 900,
      // 視野の外にある高い木も影を落とせるよう、影の地図を視野より広く取る
      lightMargin: 60,
      shadowBias: -0.0002
    })
    for (const light of this.csm.lights) {
      light.color.copy(SUN_COLOR)
      light.shadow.normalBias = 0.04
    }

    scene.add(this.hemisphere, this.sky)
    scene.fog = this.fog
  }

  /**
   * 毎フレーム呼ぶ。露出を光源に掛け、影と空をカメラに追従させる。
   */
  update(exposure: number, cameraPosition: Vector3): void {
    const s = this.settings
    const el = (s.sunElevation * Math.PI) / 180
    const az = (s.sunAzimuth * Math.PI) / 180
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))

    // 太陽が低いと、光は赤みを帯びて弱くなり、空も暗く、地平線は暖かい色になる
    const warm = Math.min(Math.max((WARM_BELOW_DEG - s.sunElevation) / (WARM_BELOW_DEG - 3), 0), 1)
    this.sunColor.copy(SUN_COLOR).lerp(LOW_SUN_COLOR, Math.pow(warm, 1.3))
    const sunFactor = 1 - 0.6 * warm * warm
    const skyFactor = 1 - 0.45 * warm
    this.zenith.copy(ZENITH_LUMINANCE).multiplyScalar(1 - 0.4 * warm)
    this.horizon.copy(HORIZON_LUMINANCE).lerp(LOW_HORIZON_LUMINANCE, 0.6 * warm).multiplyScalar(1 - 0.25 * warm)
    this.cloudLit.copy(this.sunColor).multiplyScalar(10500 * sunFactor).addScalar(1500 * skyFactor)

    for (const light of this.csm.lights) {
      light.color.copy(this.sunColor)
      light.intensity = s.sunIlluminance * sunFactor * exposure
    }
    this.hemisphere.intensity = s.skyIlluminance * skyFactor * exposure
    this.cloudUniforms.uCloudCover.value = s.cloudCover
    this.cloudUniforms.uCloudSun.value
      .set(this.sunDirection.x, this.sunDirection.z)
      .divideScalar(Math.max(this.sunDirection.y, 0.05))
    // 視野の形(焦点距離など)が変わっても合うように、毎フレーム段の区切りを作り直す
    this.csm.lightDirection.copy(this.sunDirection).negate()
    this.csm.updateFrustums()
    this.csm.update()

    this.skyMaterial.uniforms.uExposure.value = exposure
    this.sky.position.copy(cameraPosition)
    this.fog.color.copy(this.horizon).multiplyScalar(exposure)
  }

  /** 雲を流す。seconds はシミュレーションの時間(秒)。wind は風の強さ(1 が標準) */
  advanceClouds(seconds: number, wind: number): void {
    // 雲の模様は、位置をずらした分だけ逆向きに動く
    this.cloudUniforms.uCloudOffset.value.addScaledVector(CLOUD_HEADING, -CLOUD_SPEED * wind * seconds)
  }

  /** 影を描く距離(m)を変える */
  setShadowDistance(distance: number): void {
    this.csm.maxFar = distance
  }

  /** 影の地図の一辺(画素)を変える。段ごとの地図を作り直す */
  setShadowMapSize(size: number): void {
    for (const light of this.csm.lights) {
      if (light.shadow.mapSize.x === size) continue
      light.shadow.mapSize.set(size, size)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
  }

  /**
   * シーンの中の材質を、段に分けた影に対応させる。対応させていない材質は、段ごとの光源すべてに
   * 照らされて明るくなりすぎるので、後から読み込んだモデルにも効くよう、ときどき呼ぶ。
   */
  prepareMaterials(root: Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial) || this.prepared.has(material)) continue
        this.prepared.add(material)
        // 影の仕組みは onBeforeCompile を置き換えるので、もともとの差し込みを後ろにつなぐ
        const own = material.onBeforeCompile
        this.csm.setupMaterial(material)
        const cascade = material.onBeforeCompile
        material.onBeforeCompile = (shader, renderer) => {
          cascade.call(material, shader, renderer)
          own.call(material, shader, renderer)
          // 雲の影
          Object.assign(shader.uniforms, this.cloudUniforms)
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
            .replace('#include <project_vertex>', '#include <project_vertex>\n' + CLOUD_VERTEX)
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;\n' + CLOUD_GLSL)
            .replace('#include <aomap_fragment>', CLOUD_FRAGMENT + '\n#include <aomap_fragment>')
        }
        // シェーダーの使い回しは onBeforeCompile の文面で決まる。つないだ関数はどれも同じ文面に
        // なるので、もともとの差し込みの文面を鍵にして、別のシェーダーとして扱わせる
        const key = own.toString()
        material.customProgramCacheKey = () => key
        material.needsUpdate = true
      }
    })
  }
}
