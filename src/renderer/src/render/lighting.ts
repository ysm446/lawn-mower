// 太陽、空、霧。明るさは現実に近い単位(照度 lx、輝度 cd/m²)で持ち、
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
  Vector3
} from 'three'
import { CSM } from 'three/addons/csm/CSM.js'

/** 影を描く距離の上限(m)。これより遠くには影が落ちない */
const SHADOW_DISTANCE = 220
/** 影の段数。近くほど細かい影の地図を使う(カスケードシャドウマップ) */
const SHADOW_CASCADES = 3
const SUN_COLOR = new Color(1.0, 0.94, 0.84)

export interface LightingSettings {
  /** 太陽の高度(度) */
  sunElevation: number
  /** 太陽の方位(度)。+Z から +X 方向へ測る */
  sunAzimuth: number
  /** 太陽光の照度(lx)。光に垂直な面での値 */
  sunIlluminance: number
  /** 空からの照度(lx) */
  skyIlluminance: number
}

export const DEFAULT_LIGHTING: LightingSettings = {
  sunElevation: 28,
  sunAzimuth: 125,
  sunIlluminance: 90000,
  skyIlluminance: 18000
}

// 空の輝度(cd/m²)
const ZENITH_LUMINANCE = new Color(900, 2100, 5200)
const HORIZON_LUMINANCE = new Color(6200, 7400, 8600)

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
uniform float uExposure;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.45);
  vec3 sky = mix(uHorizon, uZenith, t);
  float sunAmount = max(dot(dir, uSunDir), 0.0);
  sky += uHorizon * 1.5 * pow(sunAmount, 24.0);
  sky += vec3(1.0, 0.95, 0.85) * 400000.0 * smoothstep(0.9995, 0.9999, sunAmount);
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
        uZenith: { value: ZENITH_LUMINANCE },
        uHorizon: { value: HORIZON_LUMINANCE },
        uSunDir: { value: this.sunDirection },
        uExposure: { value: 1 }
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

    for (const light of this.csm.lights) light.intensity = s.sunIlluminance * exposure
    this.hemisphere.intensity = s.skyIlluminance * exposure
    // 視野の形(焦点距離など)が変わっても合うように、毎フレーム段の区切りを作り直す
    this.csm.lightDirection.copy(this.sunDirection).negate()
    this.csm.updateFrustums()
    this.csm.update()

    this.skyMaterial.uniforms.uExposure.value = exposure
    this.sky.position.copy(cameraPosition)
    this.fog.color.copy(HORIZON_LUMINANCE).multiplyScalar(exposure)
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
