// 遠くの木のインポスター(絵を貼った板)。
// 起動時に、細かいモデルを周り 8 方向 × 見下ろす角度 3 段から撮って、色と法線の絵を 1 枚の図集にまとめる。
// 遠くの木は、カメラの方を向く板にして、見る向きと角度に近い絵を貼る。法線も絵から取るので、
// 太陽の向きによる陰影がつく。影を描くときは、板が光の方を向くので、太陽から見た木の形の影が落ちる。

import {
  Color,
  DoubleSide,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBADepthPacking,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type BufferGeometry,
  type Texture,
  type WebGLRenderer
} from 'three'

/** 周りから撮る方向の数 */
const VIEWS = 8
/** 見下ろす角度の段の数。0°、35°、70° から撮る */
const ELEVATIONS = 3
const ELEVATION_STEP = 35
/** 1 枚の絵の一辺(画素) */
const CELL = 192
/** 板の絵の、透明な所を切り抜く境目 */
const IMPOSTOR_ALPHA_TEST = 0.5

/** 絵を撮るモデル */
export interface ImpostorSource {
  bark: BufferGeometry
  leaves: BufferGeometry
  leafTexture: Texture
  /** 葉の板の、透明な所を切り抜く境目(細かいモデルと同じ値) */
  leafAlphaTest: number
}

/** 図集の中の 1 つのモデルの絵 */
interface ImpostorFrame {
  /** 板の半分の幅と高さ(モデルの大きさで、m)。どの向きから見ても収まるよう、木を包む球の半径にする */
  half: number
  /** 木の中心の高さ(モデルの根元から、m)。板はここを中心に置く */
  centerY: number
}

export interface ImpostorAtlas {
  /** 色(葉の絵の色。幹の所も葉の色のまま。幹かどうかは法線の絵の透明度で分ける) */
  albedo: Texture
  /** 法線(撮ったカメラから見た向き)と、葉なら 1、幹なら 0 */
  normal: Texture
  /** 図集の行の数(モデルの数 × 角度の段の数) */
  rows: number
  frames: ImpostorFrame[]
}

const ATLAS_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vViewNormal;
void main() {
  vUv = uv;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const ATLAS_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uUseMap;
uniform float uLeaf;
uniform float uMode;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vViewNormal;
void main() {
  vec4 texel = uUseMap > 0.5 ? texture2D(uMap, vUv) : vec4(1.0);
  if (texel.a < uAlphaTest) discard;
  if (uMode < 0.5) {
    gl_FragColor = vec4(texel.rgb, 1.0);
  } else {
    // 葉は裏から見ても法線を反転させない(細かいモデルの葉と同じ扱い)
    gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, uLeaf);
  }
}
`

/** 木の中心の高さと、そこから木を包む球の半径 */
function measure(geometries: BufferGeometry[]): ImpostorFrame {
  let low = Infinity
  let high = -Infinity
  for (const geometry of geometries) {
    const p = geometry.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      low = Math.min(low, p.getY(i))
      high = Math.max(high, p.getY(i))
    }
  }
  const centerY = (low + high) / 2
  let radius = 0
  for (const geometry of geometries) {
    const p = geometry.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      radius = Math.max(radius, Math.hypot(p.getX(i), p.getY(i) - centerY, p.getZ(i)))
    }
  }
  // 縁が切れないよう、少し余白を取る
  return { half: radius * 1.02, centerY }
}

/** モデルを周りから撮って、図集を作る。行はモデルごとに角度の段の数だけ、列は方向 */
export function buildImpostorAtlas(renderer: WebGLRenderer, sources: ImpostorSource[]): ImpostorAtlas {
  const rows = sources.length * ELEVATIONS
  const width = CELL * VIEWS
  const height = CELL * rows
  const makeTarget = (): WebGLRenderTarget =>
    new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true
    })
  const albedoTarget = makeTarget()
  const normalTarget = makeTarget()

  const leafMaterial = new ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uUseMap: { value: 1 },
      uLeaf: { value: 1 },
      uMode: { value: 0 },
      uAlphaTest: { value: 0.4 }
    },
    vertexShader: ATLAS_VERTEX,
    fragmentShader: ATLAS_FRAGMENT,
    side: DoubleSide
  })
  const barkMaterial = leafMaterial.clone()
  barkMaterial.side = FrontSide
  barkMaterial.uniforms.uUseMap.value = 0
  barkMaterial.uniforms.uLeaf.value = 0
  barkMaterial.uniforms.uAlphaTest.value = 0
  const barkMesh = new Mesh(sources[0].bark, barkMaterial)
  const leafMesh = new Mesh(sources[0].leaves, leafMaterial)
  const scene = new Scene()
  scene.add(barkMesh, leafMesh)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100)

  const frames = sources.map((source) => measure([source.bark, source.leaves]))

  // 描く前の状態を覚えておき、撮り終えたら戻す
  const previousTarget = renderer.getRenderTarget()
  const previousClear = renderer.getClearColor(new Color())
  const previousAlpha = renderer.getClearAlpha()
  const previousAutoClear = renderer.autoClear
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)

  for (const [mode, target] of [albedoTarget, normalTarget].entries()) {
    leafMaterial.uniforms.uMode.value = mode
    barkMaterial.uniforms.uMode.value = mode
    target.scissorTest = false
    target.viewport.set(0, 0, width, height)
    renderer.setRenderTarget(target)
    renderer.clear()
    target.scissorTest = true
    sources.forEach((source, index) => {
      const frame = frames[index]
      barkMesh.geometry = source.bark
      leafMesh.geometry = source.leaves
      leafMaterial.uniforms.uMap.value = source.leafTexture
      leafMaterial.uniforms.uAlphaTest.value = source.leafAlphaTest
      camera.left = -frame.half
      camera.right = frame.half
      camera.top = frame.half
      camera.bottom = -frame.half
      camera.near = frame.half
      camera.far = frame.half * 5
      camera.updateProjectionMatrix()
      for (let level = 0; level < ELEVATIONS; level++) {
        const e = (level * ELEVATION_STEP * Math.PI) / 180
        const row = index * ELEVATIONS + level
        for (let view = 0; view < VIEWS; view++) {
          // 方向 view のカメラは、木の中心から見て (sin a, cos a) の向き、角度 e だけ上にいる(板の側の選び方と揃える)
          const a = (view / VIEWS) * Math.PI * 2
          const distance = frame.half * 3
          camera.position.set(
            Math.sin(a) * Math.cos(e) * distance,
            frame.centerY + Math.sin(e) * distance,
            Math.cos(a) * Math.cos(e) * distance
          )
          camera.up.set(0, 1, 0)
          camera.lookAt(0, frame.centerY, 0)
          target.viewport.set(view * CELL, row * CELL, CELL, CELL)
          target.scissor.set(view * CELL, row * CELL, CELL, CELL)
          renderer.setRenderTarget(target)
          renderer.render(scene, camera)
        }
      }
    })
    target.scissorTest = false
    target.viewport.set(0, 0, width, height)
  }

  renderer.setRenderTarget(previousTarget)
  renderer.setClearColor(previousClear, previousAlpha)
  renderer.autoClear = previousAutoClear
  leafMaterial.dispose()
  barkMaterial.dispose()

  return { albedo: albedoTarget.texture, normal: normalTarget.texture, rows, frames }
}

// 板をカメラ(影を描くときは光)の方へ向ける。インスタンスの行列はそのまま使い、
// 板の頂点を、インスタンスの向きと大きさを打ち消した向きで置く。こうしておくと、
// 行列を掛けるほかの差し込み(影、雲の影、霞)がそのまま使える
const BILLBOARD_HEADER = /* glsl */ `
uniform float uImpostorRow;
uniform float uImpostorRows;
uniform float uImpostorCenter;
attribute vec3 aTint;
varying vec3 vTint;
varying vec3 vImpostorRight;
varying vec3 vImpostorUp;
varying vec3 vImpostorForward;
// 板の横、縦、前の向き(インスタンスの中の向き)と、使う絵の列と行
void impostorBasis(out vec3 right, out vec3 up, out vec3 forward, out vec2 cell) {
  mat3 rotation = mat3(instanceMatrix);
  float size = length(rotation[1]);
  rotation /= size;
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#ifdef IMPOSTOR_SHADOW
  // 影を描くとき: 光(正射影のカメラ)の方を向く。カメラの位置の方を向くと、影の地図のカメラは段の範囲の中央にあるので、
  // 板が光に対して横を向き、影がほとんど落ちない。カメラの z 軸(ワールドの向き)が、光の来る向き
  vec3 toLight = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 toCamera = transpose(rotation) * toLight;
#else
  vec3 toCamera = transpose(rotation) * (cameraPosition - root) / size - vec3(0.0, uImpostorCenter, 0.0);
#endif
  forward = dot(toCamera, toCamera) > 1e-8 ? normalize(toCamera) : vec3(0.0, 0.0, 1.0);
  float horizontal = length(forward.xz);
  right = horizontal > 1e-3 ? vec3(forward.z, 0.0, -forward.x) / horizontal : vec3(1.0, 0.0, 0.0);
  up = cross(forward, right);
  float viewStep = 6.28318530718 / ${VIEWS.toFixed(1)};
  float view = horizontal > 1e-3 ? mod(floor(atan(forward.x, forward.z) / viewStep + 0.5), ${VIEWS.toFixed(1)}) : 0.0;
  float elevation = degrees(asin(clamp(forward.y, 0.0, 1.0)));
  float level = clamp(floor(elevation / ${ELEVATION_STEP.toFixed(1)} + 0.5), 0.0, ${(ELEVATIONS - 1).toFixed(1)});
  cell = vec2(view, level);
}
`

const BILLBOARD_UV = /* glsl */ `
#include <uv_vertex>
{
  vec3 impostorRight;
  vec3 impostorUp;
  vec3 impostorForward;
  vec2 impostorCell;
  impostorBasis(impostorRight, impostorUp, impostorForward, impostorCell);
  vMapUv = vec2(
    (impostorCell.x + uv.x) / ${VIEWS.toFixed(1)},
    (uImpostorRow + impostorCell.y + uv.y) / uImpostorRows
  );
}
`

const BILLBOARD_POSITION = /* glsl */ `
#include <begin_vertex>
{
  vec3 impostorRight;
  vec3 impostorUp;
  vec3 impostorForward;
  vec2 impostorCell;
  impostorBasis(impostorRight, impostorUp, impostorForward, impostorCell);
  transformed = vec3(0.0, uImpostorCenter, 0.0) + impostorRight * position.x + impostorUp * position.y;
  // 法線の絵を見る側の向きに直すための、画面の座標での板の向き
  mat3 toView = mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix);
  vImpostorRight = normalize(toView * impostorRight);
  vImpostorUp = normalize(toView * impostorUp);
  vImpostorForward = normalize(toView * impostorForward);
  vTint = aTint;
}
`

const BILLBOARD_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
{
  vec3 impostorRight;
  vec3 impostorUp;
  vec3 impostorForward;
  vec2 impostorCell;
  impostorBasis(impostorRight, impostorUp, impostorForward, impostorCell);
  objectNormal = impostorForward;
}
`

const IMPOSTOR_FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D uImpostorNormal;
uniform vec3 uBarkColor;
varying vec3 vTint;
varying vec3 vImpostorRight;
varying vec3 vImpostorUp;
varying vec3 vImpostorForward;
`

// 葉は、葉の絵の色に木ごとの色を掛ける。幹は幹の色
const IMPOSTOR_COLOR = /* glsl */ `
#include <map_fragment>
vec4 impostorNormalTexel = texture2D(uImpostorNormal, vMapUv);
diffuseColor.rgb = mix(uBarkColor, diffuseColor.rgb * vTint, impostorNormalTexel.a);
`

const IMPOSTOR_NORMAL = /* glsl */ `
#include <normal_fragment_begin>
{
  vec3 n = texture2D(uImpostorNormal, vMapUv).xyz * 2.0 - 1.0;
  normal = normalize(vImpostorRight * n.x + vImpostorUp * n.y + vImpostorForward * n.z);
  nonPerturbedNormal = normal;
}
`

/** 1 つのモデルのインポスターを並べるメッシュ。index は図集を作ったときのモデルの順番。木ごとの葉の色は aTint に入れる */
export function createImpostorMesh(
  atlas: ImpostorAtlas,
  index: number,
  barkColor: Color,
  capacity: number
): InstancedMesh {
  const frame = atlas.frames[index]
  const geometry = new PlaneGeometry(frame.half * 2, frame.half * 2)
  geometry.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3))

  const uniforms = {
    uImpostorRow: { value: index * ELEVATIONS },
    uImpostorRows: { value: atlas.rows },
    uImpostorCenter: { value: frame.centerY },
    uImpostorNormal: { value: atlas.normal },
    uBarkColor: { value: barkColor }
  }
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    map: atlas.albedo,
    alphaTest: IMPOSTOR_ALPHA_TEST,
    roughness: 0.85
  })
  // 影の地図には、既定では裏面だけを描く(材質が表面のとき)。板は光の方へ表を向けるので、両面を描かないと影が落ちない
  material.shadowSide = DoubleSide
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + BILLBOARD_HEADER)
      .replace('#include <uv_vertex>', BILLBOARD_UV)
      .replace('#include <beginnormal_vertex>', BILLBOARD_NORMAL)
      .replace('#include <begin_vertex>', BILLBOARD_POSITION)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + IMPOSTOR_FRAGMENT_HEADER)
      .replace('#include <map_fragment>', IMPOSTOR_COLOR)
      .replace('#include <normal_fragment_begin>', IMPOSTOR_NORMAL)
  }
  material.customProgramCacheKey = () => 'tree-impostor'

  // 影: 板は光の方を向き、絵の透明な所は影を落とさない
  const depth = new MeshDepthMaterial({
    depthPacking: RGBADepthPacking,
    map: atlas.albedo,
    alphaTest: IMPOSTOR_ALPHA_TEST
  })
  depth.defines = { IMPOSTOR_SHADOW: '' }
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + BILLBOARD_HEADER)
      .replace('#include <uv_vertex>', BILLBOARD_UV)
      .replace('#include <begin_vertex>', BILLBOARD_POSITION)
  }
  depth.customProgramCacheKey = () => 'tree-impostor-depth'

  const mesh = new InstancedMesh(geometry, material, capacity)
  mesh.customDepthMaterial = depth
  mesh.count = 0
  return mesh
}
