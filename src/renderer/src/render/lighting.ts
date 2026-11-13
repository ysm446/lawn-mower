// 太陽、空、雲、霞。明るさは現実に近い単位(照度 lx、輝度 cd/m²)で持ち、
// 描画の前にカメラの露出を掛ける。こうすると描画バッファの値が扱いやすい範囲に収まる。
// 空の色、太陽の色と明るさ、空からの環境光、霞の色は、どれも大気散乱の計算(atmosphere.ts)から決まる。

import {
  BackSide,
  Color,
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
  Vector3,
  type WebGLRenderer
} from 'three'
import { CSM } from 'three/addons/csm/CSM.js'
import { MIE_BETA, MIE_EXTINCTION, RAYLEIGH_BETA, SOLAR_ILLUMINANCE, sunTransmittance } from '../sim/atmosphere'
import { Atmosphere, SKY_LOOKUP_GLSL } from './atmosphere'

/** 影を描く距離の上限(m)。これより遠くには影が落ちない */
const SHADOW_DISTANCE = 220
/** 影の段数の初期値。近くほど細かい影の地図を使う(カスケードシャドウマップ)。設定で変えられる */
const SHADOW_CASCADES = 3
/** 光から見た奥行きの範囲(m)の最小値。影を描く距離を伸ばすと、それに合わせて広げる */
const SHADOW_LIGHT_FAR = 900
/** 影の面の向きへのずらし(影のちらつきを抑える) */
const SHADOW_NORMAL_BIAS = 0.04
/**
 * 影の地図にだけ描く物を置くレイヤー。影の地図のカメラはこのレイヤーとふだんのレイヤー(0)を描き、
 * 場面のカメラは 0 だけを描く(three.js は、影のカメラに 0 以外のレイヤーがあれば、場面のカメラの代わりにそれを使う)。
 * 樹木は、画面に描く分と影を落とす分を別々に視錐台で選ぶので、影を落とす分をここに置く(trees.ts)
 */
export const SHADOW_ONLY_LAYER = 1
/**
 * 霞を、実際の大気より何倍濃く掛けるか。実際の大気では数 km 先でもほとんど霞まないが、
 * この場面は数百 m から数 km の広さなので、遠近感が出るように濃くする
 */
const AERIAL_BOOST = 5
/** 空の表を作り直す間隔の下限(ミリ秒)。太陽が動き続けるときも、これより細かくは作り直さない */
const SKY_UPDATE_INTERVAL = 50
/** 芝地のおおよその反射率。地面からの照り返しの色に使う */
const GROUND_ALBEDO = new Color(0.1, 0.2, 0.04)
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
  /** 大気の外での太陽の照度(lx)。地表での照度と色は、大気を抜ける間の減り方から決まる */
  sunIlluminance: number
  /** 霞の濃さ(ミー散乱の倍率)。大きいほど空が白っぽく、遠くが霞み、低い太陽が弱く赤くなる */
  haze: number
  /** 雲の量(0 で快晴、1 でほぼ曇り) */
  cloudCover: number
  /**
   * スカイライト強度。空からの光(地面や機体が受ける環境光と、雲が受ける空の光)に掛ける倍率。
   * 1 は大気の計算どおりで、それ以外は照明のバランスの補正。terrain-graph の skylightIntensity に合わせる(0〜8)
   */
  skylightIntensity: number
}

export const DEFAULT_LIGHTING: LightingSettings = {
  sunElevation: 28,
  sunAzimuth: 125,
  sunIlluminance: SOLAR_ILLUMINANCE,
  haze: 1,
  cloudCover: 0.35,
  skylightIntensity: 1
}

// 雲の濃さ。空に見える雲と、地面に落ちる雲の影で同じものを使うので、雲と影の位置が合う
const CLOUD_GLSL = /* glsl */ `
// 雲の縁の幅(ノイズの値の幅)。小さいほど、雲と雲の影の輪郭がはっきりする
#define CLOUD_EDGE 0.022
#define CLOUD_SHADOW_EDGE 0.07
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
// 雲の高さの水平面での位置 (m) から、雲の濃さ (0〜1) を求める。
// 大きな形は 4 段のノイズで決め、細かい段(detail)を足して輪郭に凹凸をつけ、縁を締める(edge が縁の幅)。
// 地面の影は、雲そのものの厚みのむらや散乱を見込んで、空の雲より縁を広くとる(CLOUD_SHADOW_EDGE)
float cloudDensityAt(vec2 p, float edge, float detail) {
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
  if (detail > 0.0) {
    // 縁のちぎれ(細かい凹凸)。振幅を少し大きめにして、輪郭に表情をつける
    float fine = 0.0;
    float b = 0.5;
    for (int i = 0; i < 3; i++) {
      fine += b * cloudNoise(q);
      q = mat2(1.6, 1.2, -1.2, 1.6) * q + 17.0;
      b *= 0.5;
    }
    n += (fine / 0.875 - 0.5) * 0.09 * detail;
  }
  // 縁の幅を変えても輪郭の位置が動かないよう、空の雲の縁の真ん中を中心にして幅を広げる
  float c = mix(0.74, 0.3, uCloudCover) + CLOUD_EDGE * 0.5;
  return smoothstep(c - edge * 0.5, c + edge * 0.5, n);
}
// 空の雲と地面の影で同じ式を使う(形と位置が揃う)
float cloudDensity(vec2 p) {
  return cloudDensityAt(p, CLOUD_EDGE, 1.0);
}
// 地面の影は縁を空の雲より広くとり、細かいちぎれも弱めて輪郭をぼかす
float cloudShadowDensity(vec2 p) {
  return cloudDensityAt(p, CLOUD_SHADOW_EDGE, 0.5);
}
// 地上の点に届く太陽の光の割合。太陽の方向へたどった先の雲の濃さで決まる
float cloudShadow(vec3 world) {
  vec2 p = world.xz + uCloudSun * (${CLOUD_HEIGHT.toFixed(1)} - world.y);
  // 厚い雲の下では、太陽の光はほとんど届かない(残るのは空からの光)
  return 1.0 - 0.92 * cloudShadowDensity(p);
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

// 霞(空気遠近法)。遠くの物ほど、その向きの地平線の空の色に溶ける。
// 一様な空気の中を水平に見通すと、途中で散らばって目に届く光は「その向きの地平線の空の輝度 × (1 - 透過率)」
// になるので、霞の色には空の表の地平線の値を使う。青ほど強く散るので、遠くは青みがかり、太陽の側は明るい
const AERIAL_HEADER = /* glsl */ `
uniform vec3 uAerialExtinction;
uniform float uSkyScale;
`
const AERIAL_FRAGMENT = /* glsl */ `
{
  vec3 aerialRay = vCloudWorld - cameraPosition;
  float aerialDistance = length(aerialRay);
  vec3 aerialDir = aerialRay / max(aerialDistance, 1e-3);
  vec3 aerialSky = atmosphereSky(normalize(vec3(aerialDir.x, max(aerialDir.y, 0.015), aerialDir.z))) * uSkyScale;
  vec3 aerialTransmittance = exp(-uAerialExtinction * aerialDistance);
  gl_FragColor.rgb = gl_FragColor.rgb * aerialTransmittance + aerialSky * (1.0 - aerialTransmittance);
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
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform vec3 uCloudLit;
uniform float uSkyScale;
uniform float uExposure;
varying vec3 vDir;
${CLOUD_GLSL}
${SKY_LOOKUP_GLSL}
void main() {
  vec3 dir = normalize(vDir);
  // 空の輝度は、大気散乱の表から引く(地平線より下は、地平線の色で埋める)
  vec3 sky = atmosphereSky(vec3(dir.x, max(dir.y, 0.0), dir.z)) * uSkyScale;
  float sunAmount = max(dot(dir, uSunDir), 0.0);
  // 雲。視線が雲の高さの面に当たる所の濃さを見る。地平線の近くは霞に溶かす
  float cloud = 0.0;
  if (dir.y > 0.0) {
    vec2 hit = cameraPosition.xz + dir.xz / max(dir.y, 0.02) * (${CLOUD_HEIGHT.toFixed(1)} - cameraPosition.y);
    cloud = cloudDensity(hit) * smoothstep(0.03, 0.18, dir.y);
    // 空の輝度(uSkyScale を掛けた値)は露出を掛け終えているので、雲の輝度にもここで露出を掛ける
    vec3 cloudColor = uCloudLit * uExposure * mix(1.0, 0.55, cloud);
    cloudColor += uCloudLit * uExposure * 0.8 * pow(sunAmount, 8.0);
    sky = mix(sky, cloudColor, cloud * 0.94);
  }
  sky += uSunDisc * uExposure * smoothstep(0.9995, 0.9999, sunAmount) * (1.0 - cloud);
  gl_FragColor = vec4(sky, 1.0);
}
`

const _color = new Color()

export class Lighting {
  /** 太陽の光と影。カメラからの距離で 3 段に分け、段ごとに光源と影の地図を持つ */
  private readonly csm: CSM
  private readonly prepared = new WeakSet<Material>()
  readonly hemisphere = new HemisphereLight(new Color(0.62, 0.78, 1.0), new Color(0.2, 0.26, 0.12), 1)
  readonly sunDirection = new Vector3()
  private readonly atmosphere = new Atmosphere()
  private lastSkyUpdate = -Infinity
  private readonly sunColor = new Color()
  /** 太陽の光の色と強さ(露出を掛けたもの)。影の計算に入れない光を、材質の側で足すときに使う(葉の透けなど) */
  readonly sunLight = new Color()
  private readonly sunDisc = new Color()
  private readonly cloudLit = new Color()
  // 霞と空で共有する値。空の表、霞の濃さ(色ごとの消散係数)、空の輝度に掛ける倍率(照度 × 露出)
  private readonly aerialUniforms = {
    uSkyView: { value: this.atmosphere.skyView },
    uAerialExtinction: { value: new Vector3() },
    uSkyScale: { value: 1 }
  }
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
        uSunDir: { value: this.sunDirection },
        uSunDisc: { value: this.sunDisc },
        uCloudLit: { value: this.cloudLit },
        uExposure: { value: 1 },
        ...this.cloudUniforms,
        ...this.aerialUniforms
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
      lightFar: SHADOW_LIGHT_FAR,
      // 視野の外にある高い木も影を落とせるよう、影の地図を視野より広く取る
      lightMargin: 60,
      shadowBias: -0.0002
    })
    this.setupShadowLights()

    // 霞は材質に差し込んだ計算で掛けるので、three.js の霧は使わない
    scene.add(this.hemisphere, this.sky)
  }

  /**
   * 毎フレーム呼ぶ。大気の計算から光源と空を決め、露出を掛け、影と空をカメラに追従させる。
   */
  update(renderer: WebGLRenderer, exposure: number, cameraPosition: Vector3): void {
    const s = this.settings
    const el = (s.sunElevation * Math.PI) / 180
    const az = (s.sunAzimuth * Math.PI) / 180
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))

    // 空の表。太陽が動いたか、霞の濃さが変わったときに作り直す
    const now = performance.now()
    if (now - this.lastSkyUpdate >= SKY_UPDATE_INTERVAL) {
      if (this.atmosphere.update(renderer, this.sunDirection, s.haze)) this.lastSkyUpdate = now
    }

    // 太陽の光。大気を抜ける間に、青い光ほど散らばって減る。太陽が低いほど空気の中を長く通るので、弱く赤くなる
    const [tr, tg, tb] = sunTransmittance(s.sunElevation, s.haze)
    const strongest = Math.max(tr, tg, tb, 1e-4)
    this.sunColor.setRGB(tr / strongest, tg / strongest, tb / strongest)
    const sunIlluminance = s.sunIlluminance * strongest
    for (const light of this.csm.lights) {
      light.color.copy(this.sunColor)
      light.intensity = sunIlluminance * exposure
    }
    this.sunLight.copy(this.sunColor).multiplyScalar(sunIlluminance * exposure)
    // 太陽の円盤。実際の輝度は桁違いに高く、描画バッファに収まらないので、控えめな値にする
    this.sunDisc.copy(this.sunColor).multiplyScalar(400000 * strongest)

    // 空からの光。上を向いた面には空の全体から、下を向いた面には地面の照り返しが届く
    const sky = this.atmosphere.skyIrradiance
    const skyStrongest = Math.max(sky.x, sky.y, sky.z, 1e-6)
    this.hemisphere.color.setRGB(sky.x / skyStrongest, sky.y / skyStrongest, sky.z / skyStrongest)
    const direct = Math.sin(el) * strongest
    this.hemisphere.groundColor
      .setRGB(
        sky.x + this.sunColor.r * direct,
        sky.y + this.sunColor.g * direct,
        sky.z + this.sunColor.b * direct
      )
      .multiply(GROUND_ALBEDO)
      .multiplyScalar(1 / skyStrongest)
    this.hemisphere.intensity = s.sunIlluminance * skyStrongest * exposure * s.skylightIntensity

    // 雲の明るい側の輝度。太陽の光と、空からの光を受けて白く光る
    this.cloudLit
      .copy(this.sunColor)
      .multiplyScalar(sunIlluminance * 0.117)
      .add(_color.setRGB(sky.x, sky.y, sky.z).multiplyScalar(s.sunIlluminance * 0.1 * s.skylightIntensity))

    // 霞の濃さ。地表での散乱の係数に、遠近感を出すための倍率を掛ける
    const mie = MIE_BETA * s.haze * MIE_EXTINCTION
    this.aerialUniforms.uAerialExtinction.value
      .set(RAYLEIGH_BETA[0] + mie, RAYLEIGH_BETA[1] + mie, RAYLEIGH_BETA[2] + mie)
      .multiplyScalar(AERIAL_BOOST)
    this.aerialUniforms.uSkyScale.value = s.sunIlluminance * exposure
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
  }

  /** 雲を流す。seconds はシミュレーションの時間(秒)。wind は風の強さ(1 が標準) */
  advanceClouds(seconds: number, wind: number): void {
    // 雲の模様は、位置をずらした分だけ逆向きに動く
    this.cloudUniforms.uCloudOffset.value.addScaledVector(CLOUD_HEADING, -CLOUD_SPEED * wind * seconds)
  }

  /**
   * 影を描く距離(m)を変える。光から見た奥行きの範囲も広げる(段の影の地図は、遠い段ほど広い範囲を
   * 受け持ち、奥行きも深くなる。範囲が足りないと、遠くの段で影が欠ける)
   */
  setShadowDistance(distance: number): void {
    this.csm.maxFar = distance
    this.csm.lightFar = Math.max(SHADOW_LIGHT_FAR, distance * 2 + 200)
    for (const light of this.csm.lights) light.shadow.camera.far = this.csm.lightFar
  }

  /** 影の地図の一辺(画素)を変える。段ごとの地図を作り直す */
  setShadowMapSize(size: number): void {
    // 段の数を変えて光源を作り直すときも、この大きさで作る
    this.csm.shadowMapSize = size
    for (const light of this.csm.lights) {
      if (light.shadow.mapSize.x === size) continue
      light.shadow.mapSize.set(size, size)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
  }

  /** 段ごとの光源の影の設定。光源を作ったときに呼ぶ */
  private setupShadowLights(): void {
    for (const light of this.csm.lights) {
      light.shadow.normalBias = SHADOW_NORMAL_BIAS
      light.shadow.camera.layers.enable(SHADOW_ONLY_LAYER)
    }
  }

  /**
   * 影の段数(カスケードの数)を変える。段ごとの光源を作り直し、影に対応させた材質の段数の定義を書き換える
   * (材質のシェーダーは作り直される)。CSM そのものは作り直さない。材質に差し込んだ処理が、この CSM を参照しているため
   */
  setShadowCascades(count: number): void {
    // three.js の CSM には段数を変える仕組みが無いので、中の光源の作り方(_createLights)を呼ぶ
    const csm = this.csm as CSM & { _createLights(): void }
    if (csm.cascades === count) return
    csm.remove()
    for (const light of csm.lights) {
      light.shadow.map?.dispose()
      light.dispose()
    }
    csm.lights.length = 0
    csm.cascades = count
    csm._createLights()
    this.setupShadowLights()
    for (const material of csm.shaders.keys() as IterableIterator<Material>) {
      material.defines = { ...material.defines, CSM_CASCADES: count }
      material.needsUpdate = true
    }
    csm.updateFrustums()
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
          // 雲の影と、霞
          Object.assign(shader.uniforms, this.cloudUniforms, this.aerialUniforms)
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
            .replace('#include <project_vertex>', '#include <project_vertex>\n' + CLOUD_VERTEX)
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nvarying vec3 vCloudWorld;\n' + CLOUD_GLSL + SKY_LOOKUP_GLSL + AERIAL_HEADER
            )
            .replace('#include <aomap_fragment>', CLOUD_FRAGMENT + '\n#include <aomap_fragment>')
            .replace('#include <fog_fragment>', AERIAL_FRAGMENT)
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
