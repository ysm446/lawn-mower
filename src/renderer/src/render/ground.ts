// 地面。地形の高さから面を作り、標準の物理ベースマテリアルに、
// 芝状態マップによる色と縞の計算を差し込む。状態マップは真上から地形に投影する。
// 縞は現実と同じ理屈で出す。芝が見る人から遠ざかる向きに倒れていると明るく、
// 手前に倒れていると暗く見える。

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  Mesh,
  RedFormat,
  UnsignedByteType,
  Color,
  MeshPhysicalMaterial,
  Vector2,
  Vector3
} from 'three'
import type { GrassField } from '../sim/grassField'
import type { Terrain } from '../sim/terrain'
import type { MowMap } from './mowMap'

export interface GroundUniforms {
  uStripe: { value: number }
  uTilt: { value: number }
  /** 近景の芝の葉を描く範囲の中心(x, z) */
  uBladeCenter: { value: Vector2 }
  /** その半径(m) */
  uBladeRadius: { value: number }
  /** 葉の濃さ(0 で葉なし) */
  uBladeAmount: { value: number }
  /** 荒れ具合(0〜1) */
  uRough: { value: number }
  /** 太陽の向き(地面から太陽へ向かう単位ベクトル) */
  uSunDir: { value: Vector3 }
  [name: string]: { value: unknown }
}

export interface Ground {
  mesh: Mesh
  uniforms: GroundUniforms
}

/**
 * 芝の色を求める GLSL。地面と、近景の芝の葉(grassBlades.ts)の両方で使う。
 * 同じ式を使うことで、葉のある範囲と無い範囲の色がつながる。
 */
export const GRASS_GLSL = /* glsl */ `
// 車輪の跡の強さ(0 で刈っただけの所と同じ、1 で最も強い)。地面と芝の葉で同じ値を使う
#define TRACK_STRENGTH 0.5
uniform sampler2D uMowMap;
uniform vec2 uMowOrigin;
uniform float uMowSize;
uniform float uMowTexel;
uniform sampler2D uLengthMap;
uniform float uLengthOrigin;
uniform float uLengthSize;
uniform float uMaxHeight;
uniform float uUncutNorm;
uniform float uStripe;
uniform float uTilt;
uniform vec2 uBladeCenter;
uniform float uBladeRadius;
uniform float uBladeAmount;
uniform float uRough; // 荒れ具合(0 は手入れされた芝、1 は荒れ草地)
uniform vec3 uSunDir; // 太陽の向き

float mowHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float mowNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mowHash(i);
  float b = mowHash(i + vec2(1.0, 0.0));
  float c = mowHash(i + vec2(0.0, 1.0));
  float d = mowHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 芝状態マップを 1 か所読む。範囲の外は刈っていない芝として扱う
vec4 mowTap(vec2 xz) {
  vec2 uv = (xz - uMowOrigin) / uMowSize;
  vec4 state = vec4(0.5, 0.5, 0.0, uUncutNorm);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
    // 半テクセルずらした 4 点の平均を取り、斜めの縁の階段状のがたつきをならす
    vec2 o = vec2(uMowTexel * 0.5);
    state = 0.25 * (
      texture2D(uMowMap, uv + vec2(o.x, o.y)) + texture2D(uMowMap, uv + vec2(-o.x, o.y)) +
      texture2D(uMowMap, uv + vec2(o.x, -o.y)) + texture2D(uMowMap, uv + vec2(-o.x, -o.y)));
  }
  return state;
}

// 芝の状態。読む位置を細かく揺らして、刈り跡の縁が定規で引いたような直線にならないようにする。
// 揺らすのは芝丈(刈った範囲の縁)が主で、葉の向き(縞の境目や車輪の跡)は控えめにする。
// 車輪の跡は細いので、同じだけ揺らすと形が崩れて見える
vec4 mowSample(vec2 xz) {
  vec2 wobble = (vec2(mowNoise(xz * 3.3), mowNoise(xz * 3.3 + 19.7)) - 0.5) * 0.2
      + (vec2(mowNoise(xz * 12.0 + 3.0), mowNoise(xz * 12.0 + 40.0)) - 0.5) * 0.07;
  vec4 edge = mowTap(xz + wobble);
  vec4 lean = mowTap(xz + wobble * 0.25);
  return vec4(lean.rg, edge.b, edge.a);
}

// 芝のつや(シーン)の強さ。刈り込んだ芝は葉が細かく揃って寝ているので、ビロードのように、
// かすめる角度や逆光でふわっと明るく光る。伸びた芝は葉がばらばらで、つやは弱い
float grassSheen(vec4 state) {
  // 荒れ草地の草は、刈っても手入れされた芝ほど細かく揃わないので、つやは弱い
  return mix(0.3, mix(1.0, 0.5, uRough), 1.0 - smoothstep(0.02, 0.06, state.a * uMaxHeight));
}

// 近景の芝の葉を描く範囲の濃さ(中心で 1、縁で 0)
float bladeCoverage(vec2 xz) {
  return uBladeAmount * (1.0 - smoothstep(uBladeRadius * 0.6, uBladeRadius, length(xz - uBladeCenter)));
}

vec3 mowGrassColor(vec3 world, vec4 state, vec3 eye) {
  vec2 lean = state.rg * 2.0 - 1.0;
  float height = state.a * uMaxHeight;

  float dist = length(world - eye);
  float nLarge = mowNoise(world.xz * 0.07);
  float nMid = mowNoise(world.xz * 1.3);
  float nFine = mowNoise(world.xz * 31.0);
  float fineFade = 1.0 - smoothstep(15.0, 70.0, dist);

  // 刈っても同じ芝なので、色みは変えない。伸びた芝は葉どうしの陰で少し暗く、むらがある
  vec3 baseColor = mix(vec3(0.088, 0.205, 0.028), vec3(0.118, 0.240, 0.036), nLarge);
  vec3 longShade = mix(vec3(0.58, 0.56, 0.60), vec3(0.88, 0.82, 0.84), nLarge * 0.4 + nMid * 0.6);
  float tall = smoothstep(0.02, 0.06, height);
  // 伸びた芝でも、踏まれて寝た所は葉の面が上を向き、陰が減って明るく見える
  tall *= 1.0 - 0.35 * min(length(lean), 1.0);
  // 伸びた芝は、場所によって長さが違う(芝の葉と同じ位置に出る)。長い所ほど陰が増えて暗い
  float lengthPatch = texture2D(uLengthMap, (world.xz - uLengthOrigin) / uLengthSize).r;
  longShade *= mix(1.14, 0.84, lengthPatch);
  // 荒れ草地は、手入れされた芝ほど鮮やかな緑ではない。刈った所も刈っていない所も、同じくすんだ緑を土台にする
  baseColor = mix(baseColor, vec3(0.105, 0.165, 0.045) * (0.9 + 0.25 * nLarge), uRough * 0.75);
  vec3 color = baseColor * mix(vec3(1.0), longShade, tall);
  // 荒れ草地: 伸びた草に、枯れ色の混じった所がまだらにできる
  float dry = uRough * tall * (0.08 + 0.38 * smoothstep(0.42, 0.75, mowNoise(world.xz * 0.16 + 31.0) * 0.6 + nMid * 0.4));
  color = mix(color, vec3(0.205, 0.190, 0.070) * (0.75 + 0.5 * nMid), dry);
  // 刈った所には、刈り株の淡い色がまだらに出る(伸びた草の根元は、日が当たらず色が薄い)
  float stubble = uRough * (1.0 - tall) * (0.12 + 0.3 * smoothstep(0.4, 0.8, mowNoise(world.xz * 0.16 + 31.0) * 0.6 + nMid * 0.4));
  color = mix(color, vec3(0.200, 0.205, 0.085) * (0.8 + 0.4 * nMid), stubble);
  // 刈り込んだ芝は、きめが細かく揃って見える(ざらつきを抑える)
  color *= 1.0 + (nFine - 0.5) * mix(0.14, 0.6, tall) * fineFade;

  // 色相のむら。数 m ごとの株のかたまりと、数十 m の広がりで、黄みと青みの間を揺らす。
  // 近くでは葉の 1 枚ごとにも少し変える
  float hue = mowNoise(world.xz * 0.42 + 13.1) * 0.5 + mowNoise(world.xz * 0.06 + 71.9) * 0.5 - 0.5;
  hue += (mowNoise(world.xz * 23.0 + 5.7) - 0.5) * 0.7 * fineFade;
  vec3 warm = vec3(1.12, 1.025, 0.86);
  vec3 cool = vec3(0.90, 0.985, 1.10);
  color *= mix(cool, warm, clamp(0.5 + hue * 1.5, 0.0, 1.0));

  // 縞: 倒れた向きと視線の向きの関係で明暗をつける
  vec3 toFrag = normalize(world - eye);
  // 寝方のむら(芝の葉と同じ位置に出る)。縞が均一になりすぎないようにする
  float layPatch = mix(0.5, 1.0, mowNoise(world.xz * 0.8 + 3.1));
  // 車輪に踏まれた所は、むらなく強く寝ている
  float pressed = smoothstep(0.84, 0.97, length(lean));
  color *= 1.0 + uStripe * mix(layPatch, 1.0, pressed * TRACK_STRENGTH) * dot(lean, toFrag.xz);
  // 刈った所にも、刈り方のむらによる濃淡を少し残す
  color *= 1.0 + (nMid - 0.5) * 0.16 * (1.0 - tall);
  // 刈り込んだ芝のまだら。1〜3 m ほどの大きさで、少し黄みがかった所と濃い所が入り混じる
  // (芝の葉の寝方のむらと同じ位置に出す)
  float cutPatch = mowNoise(world.xz * 0.35 + 5.3) * 0.6 + mowNoise(world.xz * 0.9 + 17.1) * 0.4;
  color *= 1.0 + (cutPatch - 0.5) * 0.24 * (1.0 - tall);
  float cutTint = smoothstep(0.35, 0.75, mowNoise(world.xz * 0.5 + 41.3));
  color = mix(color, color * mix(vec3(0.92, 1.0, 1.06), vec3(1.1, 1.04, 0.84), cutTint), 0.6 * (1.0 - tall));
  // 刈った所には、日の当たらなかった根元の淡い黄緑が出る。刈る前に長かった所ほど淡い。
  // 荒れ草地では強く、手入れされた芝では弱い。10〜30 cm の株ごとにむらをつける(葉 1 枚ごとだとざらつく)
  float bleachClump = mowNoise(world.xz * 4.0 + 23.9);
  float bleach = (1.0 - tall) * mix(0.18, 0.75, uRough) * (0.3 + 0.7 * lengthPatch)
    * smoothstep(0.25, 0.85, bleachClump * 0.65 + cutPatch * 0.35);
  color = mix(color, color * vec3(1.3, 1.24, 0.78) + vec3(0.018, 0.016, 0.0), bleach);
  // 進行方向に沿った細い筋(リールやローラーの当たりむら)
  float leanLength = length(lean);
  if (leanLength > 0.05) {
    vec2 along = lean / leanLength;
    vec2 across = vec2(-along.y, along.x);
    float streak = mowNoise(vec2(dot(world.xz, across) * 6.5, dot(world.xz, along) * 0.3));
    color *= 1.0 + (streak - 0.5) * 0.14 * (1.0 - tall) * min(leanLength, 1.0);
  }

  // 逆光: 葉は光を少し通すので、太陽に向かって見ると、黄みがかって明るく見える
  float backlit = pow(max(dot(toFrag, uSunDir), 0.0), 3.0);
  color *= mix(vec3(1.0), vec3(1.5, 1.42, 0.95), backlit * 0.6);
  // 刈りカス: 刈った所に、切れた葉が点々と残る。近くでだけ見える
  float litter = (1.0 - tall) * state.b * fineFade;
  float fleck = step(0.9, mowHash(floor(world.xz * 42.0) + 3.7));
  color = mix(color, color * vec3(1.5, 1.32, 1.0) + vec3(0.012, 0.014, 0.0), fleck * litter * 0.7);

  return color;
}
`

const FRAGMENT_HEADER = GRASS_GLSL + '\nvarying vec3 vMowWorld;\n'

const FRAGMENT_COLOR = /* glsl */ `
vec4 mowState = mowSample(vMowWorld.xz);
vec2 mowLean = mowState.rg * 2.0 - 1.0;
vec3 grassColor = mowGrassColor(vMowWorld, mowState, cameraPosition);
float grassSheenAmount = grassSheen(mowState);
// 芝の葉を描く範囲では、葉の根元の陰として地面を少し暗くする
grassColor *= 1.0 - 0.22 * bladeCoverage(vMowWorld.xz);
diffuseColor.rgb = grassColor;
`

/**
 * 芝の反射の抑え。地面と、近景の芝の葉(grassBlades.ts)の両方で使う。
 * 標準の材質はなめらかな面として反射を計算するので、浅い角度から太陽に向かって見ると、
 * 鏡のような反射(フレネル)で一面が白く光る。芝は細かな葉の集まりで、そうはならないので、
 * 浅い角度での反射の上限を下げる。正面に近い角度での反射(葉のきらめき)は変わらない。
 */
export const GRASS_SPECULAR = /* glsl */ `
material.specularF90 = 0.04;
#ifdef USE_SHEEN
material.sheenColor *= grassSheenAmount;
#endif
`

/**
 * 芝のつや(シーン)の材質の値。地面と、近景の芝の葉で同じ値を使う。
 * 場所ごとの強さは、シェーダーの grassSheen(刈った所ほど強い)で変える
 */
export const GRASS_SHEEN = {
  sheen: 1,
  sheenRoughness: 0.55,
  sheenColor: new Color(0.21, 0.28, 0.09)
}

const FRAGMENT_NORMAL = /* glsl */ `
// 倒れた芝の上面は、倒れた向きと逆側に傾く。太陽の向きによる明暗の差になる
// 車輪に踏まれた所は葉が強く寝るので、法線も大きく傾く
float mowPressed = smoothstep(0.84, 0.97, length(mowLean));
vec3 mowTilt = vec3(-mowLean.x, 0.0, -mowLean.y) * uTilt
  * mix(mix(0.5, 1.0, mowNoise(vMowWorld.xz * 0.8 + 3.1)), 1.7, mowPressed * TRACK_STRENGTH);
// 葉の 1 枚 1 枚の向きのばらつきを、細かいノイズで法線に与える。太陽の反射がちらちらと散る
float glintFade = 1.0 - smoothstep(6.0, 32.0, length(vMowWorld - cameraPosition));
vec2 glintCell = vMowWorld.xz * 55.0;
vec3 glint = vec3(mowNoise(glintCell) - 0.5, 0.0, mowNoise(glintCell + 31.7) - 0.5) * 0.9 * glintFade
  * mix(1.0, 0.35, 1.0 - smoothstep(0.02, 0.06, mowState.a * uMaxHeight)); // 刈り込んだ芝は、きらめきのざらつきを抑える
normal = normalize(normal + (viewMatrix * vec4(mowTilt + glint, 0.0)).xyz);
`

/**
 * 格子の座標の並びを作る。地形の格子の範囲は格子と同じ間隔で刻み、
 * その外側は遠くなるほど粗くする(遠景は細かさが要らないため)。
 */
function gridCoordinates(terrain: Terrain, extent: number): Float32Array {
  const { size, cell } = terrain.options
  const half = size / 2
  const outer: number[] = []
  let step = cell
  let at = half
  while (at < extent / 2) {
    step *= 1.1
    at += step
    outer.push(at)
  }
  const inner = terrain.samples
  const coords = new Float32Array(inner + outer.length * 2)
  for (let i = 0; i < outer.length; i++) {
    coords[outer.length - 1 - i] = -outer[i]
    coords[outer.length + inner + i] = outer[i]
  }
  for (let i = 0; i < inner; i++) coords[outer.length + i] = -half + i * cell
  return coords
}

function createTerrainGeometry(terrain: Terrain, extent: number): BufferGeometry {
  const coords = gridCoordinates(terrain, extent)
  const n = coords.length
  const positions = new Float32Array(n * n * 3)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = (iz * n + ix) * 3
      positions[i] = coords[ix]
      positions[i + 1] = terrain.heightAt(coords[ix], coords[iz])
      positions[i + 2] = coords[iz]
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6)
  let k = 0
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices[k++] = a
      indices[k++] = c
      indices[k++] = b
      indices[k++] = b
      indices[k++] = c
      indices[k++] = d
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  return geometry
}

export function createGround(
  mowMap: MowMap,
  terrain: Terrain,
  grassField: GrassField,
  extent: number,
  uncutHeight: number
): Ground {
  const o = mowMap.options
  const field = grassField.options
  const lengthMap = new DataTexture(
    grassField.data,
    field.resolution,
    field.resolution,
    RedFormat,
    UnsignedByteType
  )
  lengthMap.minFilter = LinearFilter
  lengthMap.magFilter = LinearFilter
  lengthMap.wrapS = ClampToEdgeWrapping
  lengthMap.wrapT = ClampToEdgeWrapping
  lengthMap.needsUpdate = true

  const uniforms: GroundUniforms = {
    uMowMap: { value: mowMap.texture },
    uMowOrigin: { value: new Vector2(o.originX, o.originZ) },
    uMowSize: { value: o.size },
    uMowTexel: { value: 1 / o.resolution },
    uLengthMap: { value: lengthMap },
    uLengthOrigin: { value: -field.size / 2 },
    uLengthSize: { value: field.size },
    uMaxHeight: { value: o.maxHeight },
    uUncutNorm: { value: uncutHeight / o.maxHeight },
    uStripe: { value: 0.18 },
    uTilt: { value: 0.2 },
    uBladeCenter: { value: new Vector2() },
    uBladeRadius: { value: 1 },
    uBladeAmount: { value: 0 },
    uRough: { value: 0 },
    uSunDir: { value: new Vector3(0, 1, 0) }
  }

  const material = new MeshPhysicalMaterial({ roughness: 0.6, metalness: 0, ...GRASS_SHEEN })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMowWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_COLOR)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + GRASS_SPECULAR)
      .replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n' + FRAGMENT_NORMAL
      )
  }

  const mesh = new Mesh(createTerrainGeometry(terrain, extent), material)
  mesh.receiveShadow = true
  return { mesh, uniforms }
}
