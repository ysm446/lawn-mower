// 太陽、空、霧。明るさは現実に近い単位(照度 lx、輝度 cd/m²)で持ち、
// 描画の前にカメラの露出を掛ける。こうすると描画バッファの値が扱いやすい範囲に収まる。

import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from 'three'

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
  readonly sun = new DirectionalLight(new Color(1.0, 0.94, 0.84), 1)
  readonly hemisphere = new HemisphereLight(new Color(0.62, 0.78, 1.0), new Color(0.2, 0.26, 0.12), 1)
  readonly sunDirection = new Vector3()
  private readonly fog = new FogExp2(0xffffff, 0.0009)
  private readonly skyMaterial: ShaderMaterial
  private readonly sky: Mesh

  constructor(
    scene: Scene,
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

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const cam = this.sun.shadow.camera
    cam.left = -18
    cam.right = 18
    cam.top = 18
    cam.bottom = -18
    cam.near = 1
    cam.far = 250
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.02

    scene.add(this.sun, this.sun.target, this.hemisphere, this.sky)
    scene.fog = this.fog
  }

  /**
   * 毎フレーム呼ぶ。露出を光源に掛け、影と空を注視点とカメラに追従させる。
   */
  update(exposure: number, focus: Vector3, cameraPosition: Vector3): void {
    const s = this.settings
    const el = (s.sunElevation * Math.PI) / 180
    const az = (s.sunAzimuth * Math.PI) / 180
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))

    this.sun.intensity = s.sunIlluminance * exposure
    this.hemisphere.intensity = s.skyIlluminance * exposure
    this.sun.target.position.copy(focus)
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 120)

    this.skyMaterial.uniforms.uExposure.value = exposure
    this.sky.position.copy(cameraPosition)
    this.fog.color.copy(HORIZON_LUMINANCE).multiplyScalar(exposure)
  }
}
