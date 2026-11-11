// 芝状態マップ。地面を真上から見た 2D テクスチャで、芝の状態を持つ。
//   R, G: 芝が倒れている向き(X, Z)。0.5 が 0 に対応する
//   B   : 鮮度(刈った直後が 1)。再生長で使う予定
//   A   : 芝丈(0〜1 が 0〜maxHeight m に対応する)
// 更新は GPU 上で行う。刈刃が通った帯を四角形として描き込む。
// 芝丈は「今より低いときだけ下げる」(MIN 合成)、向きと鮮度は上書きする。

import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  CustomBlending,
  AddEquation,
  DoubleSide,
  LinearFilter,
  Mesh,
  MinEquation,
  NoBlending,
  OneFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  WebGLRenderTarget,
  WebGLRenderer,
  ZeroFactor
} from 'three'

export interface MowMapOptions {
  /** マップが覆う範囲の一辺(m) */
  size: number
  /** 一辺のテクセル数 */
  resolution: number
  /** 範囲の最小側の角(ワールド座標) */
  originX: number
  originZ: number
  /** A チャンネルの 1.0 に対応する芝丈(m) */
  maxHeight: number
}

const MAX_QUADS = 2048
const VERTS_PER_QUAD = 6

const VERTEX_SHADER = /* glsl */ `
attribute vec3 stamp;
attribute vec2 feather;
varying vec3 vStamp;
varying vec2 vFeather;
void main() {
  vStamp = stamp;
  vFeather = feather;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform float uFreshness;
varying vec3 vStamp;
varying vec2 vFeather;
void main() {
  // 帯の両脇では、刈高から「刈っていない高さ」へなだらかに上げる。
  // 芝丈は低い方だけが残る(MIN 合成)ので、縁が階段状にならず、なめらかにつながる
  float t = smoothstep(vFeather.y, 1.0, abs(vFeather.x));
  gl_FragColor = vec4(vStamp.xy * 0.5 + 0.5, uFreshness, mix(vStamp.z, 0.6, t));
}
`

export class MowMap {
  readonly options: MowMapOptions
  private readonly target: WebGLRenderTarget
  private readonly scene = new Scene()
  private readonly camera = new Camera()
  private readonly positions: Float32Array
  private readonly stamps: Float32Array
  private readonly feathers: Float32Array
  private readonly geometry: BufferGeometry
  private readonly stampMaterial: ShaderMaterial
  private readonly fillMaterial: ShaderMaterial
  private readonly mesh: Mesh
  private quadCount = 0

  constructor(
    private readonly renderer: WebGLRenderer,
    options: MowMapOptions
  ) {
    this.options = options
    this.target = new WebGLRenderTarget(options.resolution, options.resolution, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    })

    this.positions = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * 3)
    this.stamps = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * 3)
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3))
    this.feathers = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * 2)
    this.geometry.setAttribute('stamp', new BufferAttribute(this.stamps, 3))
    this.geometry.setAttribute('feather', new BufferAttribute(this.feathers, 2))

    this.stampMaterial = new ShaderMaterial({
      uniforms: { uFreshness: { value: 1 } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: ZeroFactor,
      blendEquationAlpha: MinEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor
    })
    this.fillMaterial = new ShaderMaterial({
      uniforms: { uFreshness: { value: 0 } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending
    })

    this.mesh = new Mesh(this.geometry, this.stampMaterial)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  get texture(): Texture {
    return this.target.texture
  }

  /** 全面を未刈りの状態に戻す */
  reset(uncutHeight: number): void {
    this.quadCount = 0
    const h = uncutHeight / this.options.maxHeight
    this.writeQuad(-1, -1, 1, -1, 1, 1, -1, 1, 0, 0, h, 1)
    this.draw(this.fillMaterial)
  }

  /**
   * 刈刃が通った四角形を追加する。頂点はワールド座標(X, Z)で、
   * 前の左端、前の右端、今の右端、今の左端の順に渡す。
   * dirX, dirZ は芝を倒す向きと強さ(長さ 1 で完全に寝る)。
   * cutHeight は刈高。maxHeight を渡すと芝丈は変えず、倒すだけになる(車輪の跡)。
   */
  addQuad(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
    dx: number,
    dz: number,
    dirX: number,
    dirZ: number,
    cutHeight: number,
    featherTexels = 1.5
  ): void {
    if (this.quadCount >= MAX_QUADS) this.flush()
    const o = this.options
    const sx = 2 / o.size
    // 両脇を featherTexels テクセルぶん外へ広げ、そこを縁のぼかしに使う
    const margin = (o.size / o.resolution) * featherTexels
    const prevWidth = Math.hypot(ax - bx, az - bz) || 1
    const curWidth = Math.hypot(dx - cx, dz - cz) || 1
    const pux = ((ax - bx) / prevWidth) * margin
    const puz = ((az - bz) / prevWidth) * margin
    const cux = ((dx - cx) / curWidth) * margin
    const cuz = ((dz - cz) / curWidth) * margin
    this.writeQuad(
      (ax + pux - o.originX) * sx - 1,
      (az + puz - o.originZ) * sx - 1,
      (bx - pux - o.originX) * sx - 1,
      (bz - puz - o.originZ) * sx - 1,
      (cx - cux - o.originX) * sx - 1,
      (cz - cuz - o.originZ) * sx - 1,
      (dx + cux - o.originX) * sx - 1,
      (dz + cuz - o.originZ) * sx - 1,
      dirX,
      dirZ,
      cutHeight / o.maxHeight,
      prevWidth / (prevWidth + margin * 2)
    )
  }

  /** たまった四角形をまとめて描き込む */
  flush(): void {
    if (this.quadCount === 0) return
    this.draw(this.stampMaterial)
  }

  dispose(): void {
    this.target.dispose()
    this.geometry.dispose()
    this.stampMaterial.dispose()
    this.fillMaterial.dispose()
  }

  private writeQuad(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    s0: number,
    s1: number,
    s2: number,
    core: number
  ): void {
    const xs = [ax, bx, cx, ax, cx, dx]
    const ys = [ay, by, cy, ay, cy, dy]
    // 幅方向の位置(左端 -1、右端 +1)。core は、ぼかさない中央部分の割合
    const edges = [-1, 1, 1, -1, 1, -1]
    let j = this.quadCount * VERTS_PER_QUAD * 2
    let i = this.quadCount * VERTS_PER_QUAD * 3
    for (let v = 0; v < VERTS_PER_QUAD; v++) {
      this.positions[i] = xs[v]
      this.positions[i + 1] = ys[v]
      this.positions[i + 2] = 0
      this.stamps[i] = s0
      this.stamps[i + 1] = s1
      this.stamps[i + 2] = s2
      this.feathers[j] = edges[v]
      this.feathers[j + 1] = core
      i += 3
      j += 2
    }
    this.quadCount++
  }

  private draw(material: ShaderMaterial): void {
    const position = this.geometry.getAttribute('position') as BufferAttribute
    const stamp = this.geometry.getAttribute('stamp') as BufferAttribute
    position.needsUpdate = true
    stamp.needsUpdate = true
    ;(this.geometry.getAttribute('feather') as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, this.quadCount * VERTS_PER_QUAD)
    this.mesh.material = material

    const renderer = this.renderer
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = prevAutoClear
    this.quadCount = 0
  }
}
