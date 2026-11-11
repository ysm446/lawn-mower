// 動作確認用: 刈った地面の法線マップを、2D の画像として UI に出す。
// 芝状態マップ(倒れた向きと強さ)から、地面のシェーダー(ground.ts の FRAGMENT_NORMAL)と同じ式で法線を求め、
// 機体のまわりを真上から見た小さな画像に描く。地形の傾きと、細かいきらめきのノイズは含めない
// (地面に対する傾きだけを見るため。きらめきは 1 画素より細かく、潰れてしまうため)。
// 画像の上がカメラの向きになるよう回す(画面と見比べやすくする)。
// 色はノーマルマップと同じ: 画像の右へ傾くと赤、上へ傾くと緑、地面に垂直な向きが青。平らな所は青紫になる。

import {
  Camera,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer
} from 'three'
import { GRASS_GLSL, type GroundUniforms } from './ground'

/** 画像の一辺(画素) */
const SIZE = 256

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAGMENT =
  GRASS_GLSL +
  /* glsl */ `
uniform vec2 uCenter;
uniform float uSpan;
uniform float uGain;
uniform vec2 uUp;    // 画像の上に当たる、地面の上の向き(カメラの向き)
uniform vec2 uRight; // 画像の右に当たる向き
varying vec2 vUv;
void main() {
  // 読み出した行をそのまま上から並べるので、vUv.y が 0 の行が画像の上になる
  vec2 xz = uCenter + (vUv.x - 0.5) * uSpan * uRight + (0.5 - vUv.y) * uSpan * uUp;
  vec2 lean = mowSample(xz).rg * 2.0 - 1.0;
  float pressed = smoothstep(0.84, 0.97, length(lean));
  vec3 tilt = vec3(-lean.x, 0.0, -lean.y) * uTilt
    * mix(mix(0.5, 1.0, mowNoise(xz * 0.8 + 3.1)), 1.7, pressed * TRACK_STRENGTH);
  vec3 n = normalize(vec3(0.0, 1.0, 0.0) + tilt * uGain);
  // 画像の右の向きを赤、上の向きを緑、地面に垂直な向きを青にする
  gl_FragColor = vec4(vec3(dot(n.xz, uRight), dot(n.xz, uUp), n.y) * 0.5 + 0.5, 1.0);
}
`

export class NormalPreview {
  /** 画像の一辺に写す範囲(m) */
  span = 40
  /** 傾きの強調の倍率。刈った芝の傾きは小さく、そのままでは淡い色になるため */
  gain = 4
  private readonly target = new WebGLRenderTarget(SIZE, SIZE)
  private readonly scene = new Scene()
  private readonly camera = new Camera()
  private readonly material: ShaderMaterial
  private readonly pixels = new Uint8Array(SIZE * SIZE * 4)
  private readonly image: ImageData
  private readonly context: CanvasRenderingContext2D

  constructor(
    ground: GroundUniforms,
    canvas: HTMLCanvasElement
  ) {
    canvas.width = SIZE
    canvas.height = SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('法線マップの canvas を使えません')
    this.context = context
    this.image = context.createImageData(SIZE, SIZE)
    this.material = new ShaderMaterial({
      uniforms: {
        ...ground,
        uCenter: { value: new Vector2() },
        uUp: { value: new Vector2(0, -1) },
        uRight: { value: new Vector2(1, 0) },
        uSpan: { value: this.span },
        uGain: { value: this.gain }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false
    })
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  /**
   * 機体の位置(x, z)を中心に描き直す。heading は機体の向き(+Z から +X へ回る角度)。
   * viewX, viewZ はカメラの向きの水平成分で、画像の上がこの向きになるよう回す(画面と見比べやすくする)
   */
  update(renderer: WebGLRenderer, x: number, z: number, heading: number, viewX: number, viewZ: number): void {
    const u = this.material.uniforms
    u.uCenter.value.set(x, z)
    const length = Math.hypot(viewX, viewZ)
    // 真下を見ているときは向きが決まらないので、前の向きのまま
    if (length > 1e-4) {
      const upX = viewX / length
      const upZ = viewZ / length
      u.uUp.value.set(upX, upZ)
      // 上から見て、上の向きを右へ 90° 回した向き
      u.uRight.value.set(-upZ, upX)
    }
    const up = u.uUp.value as Vector2
    const right = u.uRight.value as Vector2
    u.uSpan.value = this.span
    u.uGain.value = this.gain
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(previous)
    renderer.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.pixels)
    this.image.data.set(this.pixels)
    const c = this.context
    c.putImageData(this.image, 0, 0)

    // 機体の位置と向きの印。fx は画像の右向き、fz は画像の下向きの成分
    const dx = Math.sin(heading)
    const dz = Math.cos(heading)
    const fx = dx * right.x + dz * right.y
    const fz = -(dx * up.x + dz * up.y)
    // 矢じりの形(先、左後ろ、くぼみ、右後ろ)。(前, 横) の座標を画像の上に移す
    const at = (along: number, side: number): [number, number] => [
      SIZE / 2 + fx * along - fz * side,
      SIZE / 2 + fz * along + fx * side
    ]
    c.beginPath()
    c.moveTo(...at(13, 0))
    c.lineTo(...at(-8, 8))
    c.lineTo(...at(-3, 0))
    c.lineTo(...at(-8, -8))
    c.closePath()
    c.fillStyle = 'rgba(255, 255, 255, 0.9)'
    c.strokeStyle = 'rgba(0, 0, 0, 0.7)'
    c.lineWidth = 1.5
    c.fill()
    c.stroke()
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}
