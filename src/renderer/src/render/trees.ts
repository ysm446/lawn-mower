// 樹木の描画。インスタンシングで並べる。
// 空き地に近い木は、Blender で作ったモデル(tools/blender/build_trees.py が書き出す trees.glb)で描く。
// 幹から枝が分かれ、枝のまわりに「小枝 1 本ぶんの葉をまとめた板」が付いている。板には葉の絵を貼る。
// 葉と枝は風で揺れる。カメラから遠い木は、モデルを周りから撮った絵を板に貼って描く(インポスター、treeImpostor.ts)。
// どちらで描くかは、カメラが動くたびに木ごとに決め直す。

import {
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Quaternion,
  RGBADepthPacking,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
  type WebGLRenderer
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import treesUrl from '../assets/models/trees.glb?url'
import { gradientNoise, type Terrain } from '../sim/terrain'
import type { Tree, TreeKind } from '../sim/trees'
import { broadleafTexture, needleTexture, type LeafTextures } from './leafTexture'
import { buildImpostorAtlas, createImpostorMesh } from './treeImpostor'

/** カメラからこの距離(水平、m)より近い木は、細かいモデル(LOD0)で描く(初期値。設定で変える) */
const DETAIL_DISTANCE = 60
/** この距離より遠い木はインポスター。その手前は簡略モデル(LOD1)(初期値。設定で変える) */
const IMPOSTOR_DISTANCE = 400
/** trees.glb に簡略モデルが無いときの、細かいモデルとインポスターの境目 */
const FALLBACK_DISTANCE = 80
/** カメラがこの距離(m)動くたびに、描き方を分け直す */
const LOD_REFRESH_DISTANCE = 4

/** 樹種ごとのモデル。高さと数は tools/blender/build_trees.py の HEIGHTS、VARIANTS と揃える */
const MODELS: Record<TreeKind, { height: number; variants: number }> = {
  broadleaf: { height: 12, variants: 3 },
  conifer: { height: 14, variants: 2 },
  shrub: { height: 1.8, variants: 2 }
}

/** 葉の板の、透明な所を切り抜く境目 */
const LEAF_ALPHA_TEST = 0.4

// 葉のきらめき(表現としての照り返し)。明るさや陰影は丸めた法線で決めたまま、太陽の照り返しだけを
// 葉の板の向き(aLeafNormal)で足す。向きは板ごとにずれた周期で揺らすので、照り返す葉が次々に入れ替わって瞬く。
// 板に描いた葉 1 枚ずつで照り返す向きをずらす(葉ごとの乱数は、きらめき用の隠しテクスチャ。leafTexture.ts)ので、
// 光るときは葉 1 枚の形のまま光る
/** 照り返しの強さ */
const LEAF_GLINT_STRENGTH = 2
/** 照り返しの鋭さ(大きいほど、光る葉が少なく、光り方が鋭くなる) */
const LEAF_GLINT_SHARPNESS = 10
/** 葉ごとに照り返す向きをずらす大きさ */
const LEAF_GLINT_SCATTER = 1.2
/** 光の色に葉の色を混ぜる割合(0 で白、1 で葉の色をいちばん明るくした色)。葉のつやは表面の照り返しなので白に近い */
const LEAF_GLINT_TINT = 0.45
/** 針葉樹のきらめきの強さ(広葉樹に対する割合)。針葉は細く、光ると筋のちらつきになりやすい */
const NEEDLE_GLINT_SCALE = 0.4
/** 葉の向きを揺らす大きさ(法線に足すベクトルの長さ) */
const LEAF_GLINT_WOBBLE = 0.45
/** 照り返しを消していく距離(m)。遠くでは光る葉が画素より小さくなり、ちらつきになるため。
 * 葉 1 枚の形で光るので、150 m 先でも葉が数画素に写り、簡略モデル(LOD1)の木まで届く */
const LEAF_GLINT_FADE_START = 100
const LEAF_GLINT_FADE_END = 300

// 葉の透け(表現)。逆光で木を見たとき、日が葉を透けて黄緑に明るく見えるようにする。
// 逆光で見える葉の多くは、手前の葉の影に入っている。影を入れた光で透けを描くとほとんど光らないので、
// 影を入れない太陽の光(uSunLight)で描き、そのかわり強さを控えめにする
/** 透けの強さ(設定の「葉の透け」の 1 にあたる強さ) */
const LEAF_TRANSLUCENCY_STRENGTH = 1.6
/** 太陽の方を向いて見たときの透けの鋭さ(大きいほど、太陽のまわりに絞られる) */
const LEAF_TRANSLUCENCY_FOCUS = 3
/** 樹冠の、太陽と反対の側の葉が、どこから見ても透けて見える分 */
const LEAF_TRANSLUCENCY_BACK = 0.3

/** lights_fragment_end のあとに置く */
const LEAF_TRANSLUCENCY_FRAGMENT = /* glsl */ `
{
  vec3 sunView = normalize((viewMatrix * vec4(uSunDirection, 0.0)).xyz);
  vec3 toCamera = normalize(vViewPosition);
  // 太陽の方を向いて見るほど強い(前方への散乱)
  float forward = pow(max(dot(-toCamera, sunView), 0.0), ${LEAF_TRANSLUCENCY_FOCUS.toFixed(1)});
  // 樹冠の、太陽と反対の側の葉(丸めた法線が太陽の反対を向く)
  float back = max(-dot(normal, sunView), 0.0);
  float translucency = (forward + ${LEAF_TRANSLUCENCY_BACK.toFixed(2)} * back) * back * uLeafTranslucency;
  // 葉を透けた光は、黄色みの強い緑になる
  vec3 transmitted = diffuseColor.rgb * vec3(1.1, 1.15, 0.65);
  reflectedLight.directDiffuse += uSunLight * transmitted * (RECIPROCAL_PI * translucency * ${LEAF_TRANSLUCENCY_STRENGTH.toFixed(1)});
}
`

const LEAF_GLINT_VERTEX_HEADER = /* glsl */ `
attribute vec3 aLeafNormal;
varying vec3 vLeafGlint;
`

/** windVertex のあとに置く(windRoot を使う) */
const LEAF_GLINT_VERTEX = /* glsl */ `
{
  float glintSeed = fract(sin(dot(aLeafNormal, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2832
    + windRoot.x * 0.37 + windRoot.z * 0.61;
  float glintTime = uWindTime * (1.2 + uWindStrength);
  vec3 glintNormal = aLeafNormal + ${LEAF_GLINT_WOBBLE.toFixed(2)} * vec3(
    sin(glintTime * 2.1 + glintSeed),
    sin(glintTime * 1.7 + glintSeed * 2.3),
    cos(glintTime * 2.6 + glintSeed * 3.7)
  );
#ifdef USE_INSTANCING
  glintNormal = mat3(instanceMatrix) * glintNormal;
#endif
  vLeafGlint = normalize(normalMatrix * glintNormal);
}
`

/** lights_physical_pars_fragment のあとに置き、太陽などの直接光を受けるたびに、葉の照り返しを足す */
const LEAF_GLINT_FRAGMENT = /* glsl */ `
uniform float uLeafGlint;
uniform float uLeafGlintScale;
uniform sampler2D uLeafGlintMap;
uniform float uLeafTranslucency;
uniform vec3 uSunDirection;
uniform vec3 uSunLight;
varying vec3 vLeafGlint;
void RE_Direct_Leaf(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal,
  const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
  inout ReflectedLight reflectedLight) {
  RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  // 設定で切ってあるときは光らせない(uLeafGlint が 0)
  if (uLeafGlint <= 0.0) return;
  float fade = 1.0 - smoothstep(${LEAF_GLINT_FADE_START.toFixed(1)}, ${LEAF_GLINT_FADE_END.toFixed(1)}, length(geometryPosition));
  if (fade <= 0.0) return;
  // 板に描いた葉 1 枚ずつの乱数(R、G)と、葉のある所(B)。縁では 3 つとも同じ割合で小さくなるので、B で割って戻す
  vec3 glintLeaf = texture2D(uLeafGlintMap, vMapUv).rgb;
  float spot = smoothstep(0.3, 0.8, glintLeaf.b);
  if (spot <= 0.0) return;
  vec2 glintRandom = glintLeaf.rg / max(glintLeaf.b, 1e-3) - 0.5;
  // 両面の板なので、裏から見ているときは向きを返す。葉ごとに、照り返す向きをずらす
  vec3 n = normalize(normalize(vLeafGlint) * (gl_FrontFacing ? 1.0 : -1.0)
    + vec3(glintRandom, glintRandom.x * glintRandom.y * 2.0) * ${LEAF_GLINT_SCATTER.toFixed(2)});
  float nl = dot(n, directLight.direction);
  if (nl <= 0.0) return;
  vec3 h = normalize(directLight.direction + geometryViewDir);
  float glint = pow(max(dot(n, h), 0.0), ${LEAF_GLINT_SHARPNESS.toFixed(1)});
  // 白く光らせず、葉の色を明るくした色(黄緑)で光らせる
  vec3 leafHue = material.diffuseColor / max(max(material.diffuseColor.r, max(material.diffuseColor.g, material.diffuseColor.b)), 1e-3);
  vec3 glintColor = mix(vec3(1.0), leafHue, ${LEAF_GLINT_TINT.toFixed(2)});
  // directLight.color は影で暗くなった後の光なので、影の中の葉は光らない
  reflectedLight.directSpecular += directLight.color * glintColor * (glint * spot * nl * fade * uLeafGlint * uLeafGlintScale * ${LEAF_GLINT_STRENGTH.toFixed(1)});
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`

// 葉は薄く、光を通す。裏から見ても暗くならないよう、裏面の法線を反転させない(芝の葉と同じ扱い)
const LEAF_NORMAL_FIX = /* glsl */ `
#ifdef DOUBLE_SIDED
normal *= faceDirection;
#endif
`

const WIND_HEADER = /* glsl */ `
uniform float uWindTime;
uniform float uWindStrength;
uniform float uTreeHeight;
`

/**
 * 風の揺れ。木ごとに少しずつずれた周期で、上へ行くほど大きくしなる。幹と葉で同じ式を使うので、
 * 葉が枝から離れない。葉はそれに加えて、1 枚ずつ細かく震える(flutter が 1 のとき)
 */
function windVertex(flutter: number): string {
  return /* glsl */ `
#ifdef USE_INSTANCING
  vec3 windRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 windRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif
  float windPhase = uWindTime * 1.1 + windRoot.x * 0.13 + windRoot.z * 0.09;
  float windBend = max(transformed.y, 0.0) / uTreeHeight;
  windBend *= windBend;
  vec2 windSway = vec2(
    sin(windPhase) + 0.4 * sin(windPhase * 2.3 + 1.7),
    cos(windPhase * 0.8) + 0.3 * sin(windPhase * 1.9)
  );
  transformed.xz += windSway * uWindStrength * 0.035 * uTreeHeight * windBend;
  float windFlutter = sin(uWindTime * 4.6 + transformed.x * 2.9 + transformed.z * 2.3 + transformed.y * 1.7 + windRoot.x);
  transformed.y += windFlutter * ${flutter.toFixed(1)} * uWindStrength * 0.004 * uTreeHeight;
`
}

/** 枝葉のかたまり。位置と大きさは、樹高 1、枝葉の広がり 1 の木に対する値 */
const CROWN_BLOBS: ReadonlyArray<readonly [number, number, number, number]> = [
  // 横、高さ、奥行き、大きさ
  [0, 0.62, 0, 1.0],
  [0.55, 0.5, 0.2, 0.72],
  [-0.45, 0.52, 0.35, 0.68],
  [-0.15, 0.48, -0.55, 0.7],
  [0.1, 0.84, 0.05, 0.62]
]

/** 広葉樹の、まとめた形の枝葉。横は「広がり」、縦は「樹高」で伸び縮みさせるので、どちらも 1 として作る */
function crownGeometry(): BufferGeometry {
  const parts = CROWN_BLOBS.map(([x, y, z, size], index) => {
    const blob = new IcosahedronGeometry(1, 1)
    const position = blob.getAttribute('position') as BufferAttribute
    for (let i = 0; i < position.count; i++) {
      const px = position.getX(i)
      const py = position.getY(i)
      const pz = position.getZ(i)
      // 表面をでこぼこさせる(葉のかたまりの凹凸)
      const bump =
        1 +
        gradientNoise(px * 2.2 + index * 9, py * 2.2 + pz * 2.2, 77) * 0.32 +
        gradientNoise(px * 6 + pz * 6, py * 6 + index * 5, 91) * 0.1
      position.setXYZ(i, x + px * size * bump, y + py * size * bump * 0.26, z + pz * size * bump)
    }
    // 同じ位置の頂点をまとめてから法線を求める。まとめないと面ごとに角ばって見える
    blob.deleteAttribute('normal')
    blob.deleteAttribute('uv')
    const smooth = mergeVertices(blob, 1e-4)
    smooth.computeVertexNormals()
    return smooth
  })
  return mergeGeometries(parts)
}

/** 幹と葉を 1 組にした、インスタンシングのメッシュ */
interface TreeMeshes {
  bark: InstancedMesh
  leaves: InstancedMesh
}

/** 1 つのモデルの木の置き方と、どの描き方で描くか */
interface LodGroup {
  trees: Tree[]
  /** 木ごとの行列(16 個ずつ) */
  matrices: Float32Array
  /** 木ごとの葉の色(3 個ずつ) */
  tints: Float32Array
  /** 細かいモデル。カメラの近くの木と、1 本立ちの木 */
  detail: TreeMeshes
  /**
   * 簡略モデル。影を落とす分(影を描く距離の内側)と、落とさない分に分ける。
   * 影の地図は段ごとにメッシュ全体を描き直すので、遠くの木まで影に入れると重い。trees.glb に無ければ null
   */
  simple: { shadowed: TreeMeshes; plain: TreeMeshes } | null
  /** 遠くの木のインポスター */
  impostor: InstancedMesh
}

export class Trees {
  readonly group = new Group()
  private readonly wind = {
    uWindTime: { value: 0 },
    uWindStrength: { value: 1 }
  }
  /** 葉のきらめきの強さの倍率(設定でオフのときは 0) */
  private readonly leafGlint = { value: 1 }
  /** 葉の透けの強さの倍率(設定の「葉の透け」。0 で透けない)と、透けに使う太陽の向きと光 */
  private readonly leafTranslucency = { value: 1 }
  private readonly sunDirection = { value: new Vector3(0, 1, 0) }
  private readonly sunLight = { value: new Color(0, 0, 0) }
  private readonly lodGroups: LodGroup[] = []
  /** 最後に描き方を分けたときのカメラの位置。分け直しが要るときは null */
  private lodAt: { x: number; z: number } | null = null
  /** 描き分けの境目(m)。setLodDistances で変える */
  private detailDistance = DETAIL_DISTANCE
  private impostorDistance = IMPOSTOR_DISTANCE
  /** 影を描く距離(m)。簡略モデルのうち、この内側の木だけが影を落とす */
  private shadowDistance = 220

  constructor(trees: Tree[], terrain: Terrain, renderer: WebGLRenderer) {
    if (trees.length === 0) return
    const matrix = new Matrix4()
    const position = new Vector3()
    const scale = new Vector3()
    const rotation = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const color = new Color()
    const leafColor = (tree: Tree): Color => {
      const t = tree.tone
      // 針葉樹は青みのある濃い緑、広葉樹と低木は濃い緑から少し黄みのある緑まで
      return tree.kind === 'conifer'
        ? color.setRGB(0.026 + 0.018 * t, 0.07 + 0.03 * t, 0.034 + 0.012 * t)
        : color.setRGB(0.035 + 0.035 * t, 0.085 + 0.05 * t, 0.018 + 0.012 * (1 - t))
    }
    const add = (mesh: InstancedMesh, shadows: boolean): void => {
      mesh.castShadow = shadows
      mesh.receiveShadow = true
      // 範囲が広いので、まとめて視錐台で切り捨てられないようにする
      mesh.frustumCulled = false
      this.group.add(mesh)
    }

    /** まとめた形の木を並べる(広葉樹は丸、針葉樹は円錐。低木は小さいので描かない)。モデルを読めないときの代わり */
    const buildSimple = (list: Tree[]): void => {
      const trunkMaterial = new MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.95 })
      const crownMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 })
      const trunkGeometry = new CylinderGeometry(0.55, 1, 1, 8)
      trunkGeometry.translate(0, 0.5, 0)
      const cone = new ConeGeometry(1, 0.86, 9, 3)
      cone.translate(0, 0.57, 0)
      for (const kind of ['broadleaf', 'conifer'] as const) {
        const members = list.filter((t) => t.kind === kind)
        if (members.length === 0) continue
        const trunks = new InstancedMesh(trunkGeometry, trunkMaterial, members.length)
        const crowns = new InstancedMesh(
          kind === 'conifer' ? cone : crownGeometry(),
          crownMaterial,
          members.length
        )
        members.forEach((tree, i) => {
          // 斜面では根元が浮かないよう、少し埋める
          position.set(tree.x, terrain.heightAt(tree.x, tree.z) - 0.3, tree.z)
          rotation.setFromAxisAngle(up, tree.tone * Math.PI * 2)
          const trunkRadius = tree.height * 0.028
          scale.set(trunkRadius, tree.height * 0.6, trunkRadius)
          trunks.setMatrixAt(i, matrix.compose(position, rotation, scale))
          scale.set(tree.spread, tree.height, tree.spread)
          crowns.setMatrixAt(i, matrix.compose(position, rotation, scale))
          crowns.setColorAt(i, leafColor(tree))
        })
        add(trunks, true)
        add(crowns, true)
      }
    }

    new GLTFLoader().load(
      treesUrl,
      (gltf) => {
        const leafTextures: Record<TreeKind, LeafTextures> = {
          broadleaf: broadleafTexture(),
          conifer: needleTexture(),
          shrub: broadleafTexture()
        }
        const textures: Record<TreeKind, Texture> = {
          broadleaf: leafTextures.broadleaf.map,
          conifer: leafTextures.conifer.map,
          shrub: leafTextures.shrub.map
        }
        const barkColor = new Color(0x2c2118)
        // 樹種とモデルの組ごとに、材質とジオメトリを用意する
        const variants: {
          kind: TreeKind
          variant: number
          bark: BufferGeometry
          leaves: BufferGeometry
          simple: { bark: BufferGeometry; leaves: BufferGeometry } | null
          barkMaterial: Material
          leafMaterial: Material
          barkShadow: Material
          leafShadow: Material
        }[] = []
        for (const kind of Object.keys(MODELS) as TreeKind[]) {
          const model = MODELS[kind]
          const uniforms = {
            ...this.wind,
            uLeafGlint: this.leafGlint,
            uLeafGlintScale: { value: kind === 'conifer' ? NEEDLE_GLINT_SCALE : 1 },
            uLeafGlintMap: { value: leafTextures[kind].glint },
            uLeafTranslucency: this.leafTranslucency,
            uSunDirection: this.sunDirection,
            uSunLight: this.sunLight,
            uTreeHeight: { value: model.height }
          }
          const withWind = <T extends Material>(material: T, flutter: number, leaf: boolean): T => {
            material.onBeforeCompile = (shader) => {
              Object.assign(shader.uniforms, uniforms)
              shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\n' + WIND_HEADER + (leaf ? LEAF_GLINT_VERTEX_HEADER : ''))
                .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + windVertex(flutter) + (leaf ? LEAF_GLINT_VERTEX : ''))
              if (leaf) {
                shader.fragmentShader = shader.fragmentShader
                  .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + LEAF_NORMAL_FIX)
                  .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + LEAF_GLINT_FRAGMENT)
                  .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LEAF_TRANSLUCENCY_FRAGMENT)
              }
            }
            // 樹種ごとに高さが違うので、シェーダーを使い回させない
            material.customProgramCacheKey = () => `tree-${kind}-${flutter}-${leaf}`
            return material
          }
          const barkMaterial = withWind(new MeshStandardMaterial({ color: barkColor, roughness: 0.95 }), 0, false)
          const leafMaterial = withWind(
            new MeshStandardMaterial({
              color: 0xffffff,
              map: textures[kind],
              alphaTest: LEAF_ALPHA_TEST,
              // つやを強くすると、葉のかたまり全体が白く光って見える
              roughness: 0.8,
              side: DoubleSide
            }),
            1,
            true
          )
          // 影にも、葉の形の切り抜きと風の揺れを反映する
          const leafShadow = withWind(
            new MeshDepthMaterial({
              depthPacking: RGBADepthPacking,
              map: textures[kind],
              alphaTest: LEAF_ALPHA_TEST
            }),
            1,
            false
          )
          const barkShadow = withWind(new MeshDepthMaterial({ depthPacking: RGBADepthPacking }), 0, false)

          for (let v = 0; v < model.variants; v++) {
            const bark = gltf.scene.getObjectByName(`${kind}_${v}_bark`)
            const leaves = gltf.scene.getObjectByName(`${kind}_${v}_leaves`)
            if (!(bark instanceof Mesh) || !(leaves instanceof Mesh)) {
              console.warn(`trees.glb に ${kind}_${v} が見つかりません`)
              continue
            }
            // 葉の法線は、枝葉のかたまりの中心(針葉樹は幹)から外へ向かう向きを混ぜる。
            // 板 1 枚ずつの向きだけで照らすと、全体がざらついて見え、木としての丸みが出ない
            const roundLeafNormals = (geometry: BufferGeometry): BufferGeometry => {
              const p = geometry.getAttribute('position')
              const n = geometry.getAttribute('normal')
              // 葉 1 枚ずつの向きは、きらめきの照り返しに使うので残しておく
              if (!geometry.getAttribute('aLeafNormal')) geometry.setAttribute('aLeafNormal', n.clone())
              const out = new Vector3()
              const own = new Vector3()
              for (let i = 0; i < p.count; i++) {
                if (kind === 'conifer') out.set(p.getX(i), model.height * 0.12, p.getZ(i)).normalize()
                else out.set(p.getX(i), p.getY(i) - model.height * 0.6, p.getZ(i)).normalize()
                own.set(n.getX(i), Math.abs(n.getY(i)), n.getZ(i))
                out.multiplyScalar(0.7).addScaledVector(own, 0.3).normalize()
                n.setXYZ(i, out.x, out.y, out.z)
              }
              return geometry
            }
            const leafGeometry = roundLeafNormals(leaves.geometry as BufferGeometry)
            // 簡略モデル(LOD1)。古い trees.glb には無い
            const simpleBark = gltf.scene.getObjectByName(`${kind}_${v}_lod1_bark`)
            const simpleLeaves = gltf.scene.getObjectByName(`${kind}_${v}_lod1_leaves`)
            const simple =
              simpleBark instanceof Mesh && simpleLeaves instanceof Mesh
                ? {
                    bark: simpleBark.geometry as BufferGeometry,
                    leaves: roundLeafNormals(simpleLeaves.geometry as BufferGeometry)
                  }
                : null
            if (!simple) console.warn(`trees.glb に ${kind}_${v} の簡略モデルが無いため、${FALLBACK_DISTANCE} m から先をインポスターにします`)
            variants.push({
              kind,
              variant: v,
              bark: bark.geometry as BufferGeometry,
              leaves: leafGeometry,
              simple,
              barkMaterial,
              leafMaterial,
              barkShadow,
              leafShadow
            })
          }
        }

        // 遠くの木の絵を、モデルを周りから撮って作る
        const atlas = buildImpostorAtlas(
          renderer,
          variants.map((v) => ({
            bark: v.bark,
            leaves: v.leaves,
            leafTexture: textures[v.kind],
            leafAlphaTest: LEAF_ALPHA_TEST
          }))
        )

        variants.forEach((v, row) => {
          const model = MODELS[v.kind]
          const members = trees.filter(
            (t) => t.kind === v.kind && Math.min(Math.floor(t.tone * model.variants), model.variants - 1) === v.variant
          )
          if (members.length === 0) return
          const matrices = new Float32Array(members.length * 16)
          const tints = new Float32Array(members.length * 3)
          members.forEach((tree, i) => {
            position.set(tree.x, terrain.heightAt(tree.x, tree.z), tree.z)
            rotation.setFromAxisAngle(up, tree.tone * 37)
            const size = tree.height / model.height
            scale.set(size, size, size)
            matrix.compose(position, rotation, scale).toArray(matrices, i * 16)
            // 葉の絵が明るい灰緑なので、その分だけ色を濃く掛ける
            leafColor(tree).multiplyScalar(2.2).toArray(tints, i * 3)
          })
          /** 幹と葉のメッシュを作る(中身は分け直すたびに書き換える) */
          const makeMeshes = (bark: BufferGeometry, leaves: BufferGeometry, shadows: boolean): TreeMeshes => {
            const barkMesh = new InstancedMesh(bark, v.barkMaterial, members.length)
            const leafMesh = new InstancedMesh(leaves, v.leafMaterial, members.length)
            barkMesh.customDepthMaterial = v.barkShadow
            leafMesh.customDepthMaterial = v.leafShadow
            // 色の入れ物を作っておく
            leafMesh.setColorAt(0, color.setRGB(1, 1, 1))
            barkMesh.count = 0
            leafMesh.count = 0
            add(barkMesh, shadows)
            add(leafMesh, shadows)
            return { bark: barkMesh, leaves: leafMesh }
          }
          const detail = makeMeshes(v.bark, v.leaves, true)
          const simple = v.simple
            ? {
                shadowed: makeMeshes(v.simple.bark, v.simple.leaves, true),
                plain: makeMeshes(v.simple.bark, v.simple.leaves, false)
              }
            : null
          const impostor = createImpostorMesh(atlas, row, barkColor, members.length)
          add(impostor, true)
          this.lodGroups.push({ trees: members, matrices, tints, detail, simple, impostor })
        })
        this.lodAt = null
      },
      undefined,
      (error) => {
        console.warn('trees.glb を読み込めないため、まとめた形の木を使います', error)
        buildSimple(trees)
      }
    )
  }

  /**
   * 毎フレーム呼ぶ。time は秒。strength は風の強さ(0 で止まる)。
   * camera はカメラの位置で、そこからの距離で木ごとに描き方(細かいモデル、簡略モデル、インポスター)を決める
   */
  update(time: number, strength: number, camera: Vector3): void {
    this.wind.uWindTime.value = time
    this.wind.uWindStrength.value = strength
    const at = this.lodAt
    if (at && Math.hypot(camera.x - at.x, camera.z - at.z) < LOD_REFRESH_DISTANCE) return
    this.lodAt = { x: camera.x, z: camera.z }
    for (const group of this.lodGroups) this.assignLod(group, camera.x, camera.z)
  }

  /** 影を描く距離(m)を変える。簡略モデルのうち、影を落とす木の範囲が変わる */
  /** 葉の透けの強さ(0 で透けない) */
  setLeafTranslucency(strength: number): void {
    this.leafTranslucency.value = strength
  }

  /** 葉の透けに使う太陽の向き(太陽へ向かう向き)と光。毎フレーム呼ぶ */
  setSun(direction: Vector3, light: Color): void {
    this.sunDirection.value.copy(direction)
    this.sunLight.value.copy(light)
  }

  /** 葉のきらめきを入れるか、切るか */
  setLeafGlint(on: boolean): void {
    this.leafGlint.value = on ? 1 : 0
  }

  setShadowDistance(distance: number): void {
    this.shadowDistance = distance
    this.lodAt = null
  }

  /**
   * 描き分けの境目(カメラからの水平の距離、m)を変える。detail より近い木は細かいモデル、
   * impostor より遠い木はインポスター、その間は簡略モデル。impostor が detail より近いときは detail に揃える
   */
  setLodDistances(detail: number, impostor: number): void {
    this.detailDistance = detail
    this.impostorDistance = Math.max(impostor, detail)
    this.lodAt = null
  }

  /** 木ごとに、カメラからの距離で描き方を決めて、それぞれのメッシュに入れる */
  private assignLod(group: LodGroup, cx: number, cz: number): void {
    const { trees, matrices, tints, detail, simple, impostor } = group
    const tintAttribute = impostor.geometry.getAttribute('aTint') as InstancedBufferAttribute
    const farMatrices = impostor.instanceMatrix.array as Float32Array
    const farTints = tintAttribute.array as Float32Array
    const slots = [detail, ...(simple ? [simple.shadowed, simple.plain] : [])].map((meshes) => ({
      meshes,
      barkMatrices: meshes.bark.instanceMatrix.array as Float32Array,
      leafMatrices: meshes.leaves.instanceMatrix.array as Float32Array,
      leafColors: meshes.leaves.instanceColor?.array as Float32Array | undefined,
      count: 0
    }))
    const detailReach = simple ? this.detailDistance : FALLBACK_DISTANCE
    const simpleReach = simple ? this.impostorDistance : FALLBACK_DISTANCE
    let far = 0
    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i]
      const m = matrices.subarray(i * 16, i * 16 + 16)
      const tint = tints.subarray(i * 3, i * 3 + 3)
      const distance = Math.hypot(tree.x - cx, tree.z - cz)
      // 0: 細かいモデル、1: 簡略モデル(影あり)、2: 簡略モデル(影なし)、-1: インポスター
      const slot =
        tree.lone || distance < detailReach
          ? 0
          : distance < simpleReach
            ? distance < this.shadowDistance
              ? 1
              : 2
            : -1
      if (slot < 0) {
        farMatrices.set(m, far * 16)
        farTints.set(tint, far * 3)
        far++
        continue
      }
      const s = slots[slot]
      s.barkMatrices.set(m, s.count * 16)
      s.leafMatrices.set(m, s.count * 16)
      s.leafColors?.set(tint, s.count * 3)
      s.count++
    }
    for (const s of slots) {
      s.meshes.bark.count = s.count
      s.meshes.leaves.count = s.count
      s.meshes.bark.instanceMatrix.needsUpdate = true
      s.meshes.leaves.instanceMatrix.needsUpdate = true
      if (s.meshes.leaves.instanceColor) s.meshes.leaves.instanceColor.needsUpdate = true
    }
    impostor.count = far
    impostor.instanceMatrix.needsUpdate = true
    tintAttribute.needsUpdate = true
  }
}
