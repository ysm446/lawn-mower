import './style.css'
import {
  ACESFilmicToneMapping,
  DepthTexture,
  HalfFloatType,
  PCFShadowMap,
  Scene,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { KeyboardInput } from './input'
import { CAMERA_MODES, CAMERA_MODE_LABELS, CameraRig, type CameraMode } from './render/cameraRig'
import { Clippings } from './render/clippings'
import { GrassBlades } from './render/grassBlades'
import { createGround } from './render/ground'
import { Lighting } from './render/lighting'
import { MowMap } from './render/mowMap'
import { MowerModel } from './render/mowerModel'
import { overlayPixelRatio, overlayResolution } from './render/overlay/ribbon'
import { PathLine } from './render/pathLine'
import { Trees } from './render/trees'
import { DofPass, MeterPass } from './render/postfx'
import { ZoneOverlay } from './render/zoneOverlay'
import { ev100, ev100FromLuminance, shutterTimeForEv100 } from './camera/exposure'
import { CoverageGrid } from './sim/coverage'
import { planCoverage, type CoveragePlan } from './sim/coveragePlan'
import { DEFAULT_FOLLOWER, PathFollower } from './sim/pathFollower'
import { GrassField } from './sim/grassField'
import { loadSettings, setupSettings, type AppSettings } from './settings'
import { MAPS, findMap } from './sim/maps'
import { DEFAULT_TERRAIN, Terrain } from './sim/terrain'
import { blockedByTrees, generateTrees } from './sim/trees'
import {
  DEFAULT_ZONING,
  ZONE_NONE,
  ZONE_RIDE,
  ZONE_SLOPE,
  computeZoning,
  type ZoningResult
} from './sim/zoning'
import {
  FAIRWAY_MOWER,
  createVehicleState,
  deckSegment,
  minTurnRadius,
  stepVehicle,
  reelSegments,
  wheelPositions
} from './sim/vehicle'
import { addCheck, addReadout, addSlider, addSwitch, byId, setupHelp, stopsSlider, type Sync } from './ui'

// 単位はすべて実寸(1 = 1 m)
const FIELD_SIZE = 512
const FIELD_ORIGIN = -FIELD_SIZE / 2
const GROUND_EXTENT = 7000
const MAX_GRASS_HEIGHT = 0.2
const SIM_DT = 1 / 120
const MAX_STEPS_PER_FRAME = 600
// 刈った芝が寝る強さ(1 で完全に寝る)。車輪に踏まれた所は 1 にして、刈り跡の中でも筋が残るようにする
const CUT_LEAN = 0.8
// 刈刃の上げ下げにかかる時間(秒)と、上げきったときの高さ(m)
const DECK_MOVE_TIME = 0.5
const DECK_LIFT_HEIGHT = 0.1
// 刈刃がこれより上がっている間は刈らない(0 が下げきり、1 が上げきり)
const DECK_CUT_LIMIT = 0.8
// 車輪の跡を描き込む間隔(m)
const TRACK_STEP = 0.12
// 刈った量(m² × 長さの倍率)あたりの粒の数
const CLIPPINGS_PER_VOLUME = 40
const TIME_SCALES = [1, 2, 4, 8, 16, 32, 64]

const F_STOPS = [
  1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18,
  20, 22
]
// シャッター速度は 1/x 秒の x で持つ
const SHUTTER_STOPS = [
  15, 20, 30, 40, 60, 80, 125, 160, 250, 320, 500, 640, 1000, 1250, 2000, 2500, 4000, 5000, 8000
]
const ISO_STOPS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1600, 3200, 6400]
const FOCAL_MIN = 12
const FOCAL_MAX = 400
const MINIATURE_MAX = 200

// 例外は、起きた場所が分かるように呼び出しの経路ごと記録する(メインプロセスのログにも出る)
window.addEventListener('error', (event) => {
  if (event.error instanceof Error) console.error(event.error.stack)
})

const query = new URLSearchParams(window.location.search)

// 設定ウインドウで変える設定(前回の値を引き継ぐ)
const settings = loadSettings()

// マップ。?map= で選ぶ(切り替えるときはページを読み込み直す)
const map = findMap(query.get('map'))
const UNCUT_HEIGHT = map.grass.uncutHeight
// 芝刈り機の出発点
const START_X = map.startX
const START_Z = map.startZ

const canvas = byId<HTMLCanvasElement>('view')

const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio))
renderer.toneMapping = ACESFilmicToneMapping
renderer.toneMappingExposure = 1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFShadowMap

const scene = new Scene()
const rig = new CameraRig(canvas)
const lighting = new Lighting(scene, rig.camera)

const mowMap = new MowMap(renderer, {
  size: FIELD_SIZE,
  resolution: 4096,
  originX: FIELD_ORIGIN,
  originZ: FIELD_ORIGIN,
  maxHeight: MAX_GRASS_HEIGHT
})
mowMap.reset(UNCUT_HEIGHT)

// 地形のシード値は ?seed= で変えられる
const querySeed = Number(query.get('seed'))
const terrain = new Terrain({
  ...DEFAULT_TERRAIN,
  seed: Number.isInteger(querySeed) && querySeed > 0 ? querySeed : map.seed,
  shape: map.shape
})

// 樹木。芝刈り機が入れない所の格子も作る(区分けで「刈らない」になる)
const treeList = map.trees ? generateTrees(map.trees, terrain.options.seed, START_X, START_Z) : []
const blocked = map.trees
  ? blockedByTrees(
      treeList,
      map.trees,
      terrain.options.seed,
      terrain.samples,
      terrain.options.cell,
      terrain.origin
    )
  : undefined
const treeModels = new Trees(treeList, terrain)
scene.add(treeModels.group)
const windSettings = { strength: 1 }

const zoneOverlay = new ZoneOverlay(terrain)
scene.add(zoneOverlay.lines)

// 刈る前の芝の長さのむら(場所ごとの倍率)
const grassField = new GrassField({
  seed: terrain.options.seed,
  size: FIELD_SIZE,
  resolution: 1024
})

const ground = createGround(
  mowMap,
  terrain,
  grassField,
  GROUND_EXTENT,
  UNCUT_HEIGHT
)
scene.add(ground.mesh)
ground.uniforms.uRough.value = map.grass.roughness

// 近景の芝の葉。?blades=0 で描かない
const grassBlades = new GrassBlades(terrain, ground.uniforms)
const bladeSettings = { show: query.get('blades') !== '0' }
scene.add(grassBlades.mesh)

// 刈りカスの粒
const clippings = new Clippings(terrain)
scene.add(clippings.mesh)
// このフレームで刈った芝の量(面積 × 長さの倍率)。粒の数を決めるのに使う
let cutVolume = 0
let clippingDebt = 0

// 勾配による区分け。設定を変えたら次のフレームで計算し直す
const zoning = {
  options: { ...DEFAULT_ZONING },
  show: query.get('zones') === '1',
  dirty: true,
  result: null as ZoningResult | null
}

function updateZoning(): void {
  zoning.dirty = false
  const result = computeZoning(
    { samples: terrain.samples, cell: terrain.options.cell, heights: terrain.heights },
    zoning.options,
    (START_X - terrain.origin) / terrain.options.cell,
    (START_Z - terrain.origin) / terrain.options.cell,
    blocked
  )
  zoning.result = result
  route.dirty = true
  zoneOverlay.update(result, blocked)
  const total = result.zoneArea.reduce((a, b) => a + b)
  const area = (m2: number): string =>
    `${(m2 / 10000).toFixed(2)} ha(${((m2 / total) * 100).toFixed(0)}%)`
  setZoneReadout({
    ride: area(result.zoneArea[ZONE_RIDE]),
    reachable: area(result.reachableArea),
    slope: area(result.zoneArea[ZONE_SLOPE]),
    none: area(result.zoneArea[ZONE_NONE]),
    regions: `${result.regions.length}`
  })
}

const params = FAIRWAY_MOWER
const mower = new MowerModel(params)
scene.add(mower.root)

const coverage = new CoverageGrid(FIELD_ORIGIN, FIELD_ORIGIN, FIELD_SIZE, FIELD_SIZE, 0.5)

// HDR(半精度浮動小数点)で描いてから、トーンマッピングして画面に出す
const composer = new EffectComposer(
  renderer,
  new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    samples: 4,
    // 被写界深度で使うので、深度も読める形で持つ
    depthTexture: new DepthTexture(1, 1)
  })
)
const meterPass = new MeterPass()
const dofPass = new DofPass()
composer.addPass(new RenderPass(scene, rig.camera))
composer.addPass(meterPass)
composer.addPass(dofPass)
composer.addPass(new OutputPass())

const sim = {
  state: createVehicleState(START_X, START_Z, 0),
  timeScale: 1,
  cutHeightMm: 18,
  autoDrive: false,
  elapsed: 0,
  distance: 0
}
let deckLift = 0
const unitsNow = new Float64Array(params.reels.length * 4)
const unitsPrev = new Float64Array(params.reels.length * 4)
let unitsStarted = false
let accumulator = 0
const wheelsNow = new Float64Array(params.wheels.length * 2)
const wheelsPrev = new Float64Array(params.wheels.length * 2)
let tracksStarted = false

// 自動運転の経路。区分けや設定が変わったら、必要になった時点で作り直す
const route = {
  options: { angleDeg: 0, overlap: 0.2, headlandPasses: 3 },
  // 刈る範囲の一辺(m)。出発点を中心とする正方形に絞る。FIELD_SIZE 以上なら絞らない
  extent: map.routeExtent,
  show: query.get('path') === '1',
  dirty: true,
  plan: null as CoveragePlan | null,
  follower: null as PathFollower | null,
  text: { area: '-', lines: '-', cut: '-', transit: '-', time: '-' }
}
const pathLine = new PathLine(terrain)
scene.add(pathLine.lines)

const formatKm = (m: number): string => `${(m / 1000).toFixed(2)} km`

/** 今いる所を出発点として、乗用機で刈れて届く範囲の経路を作る */
function updateRoute(): void {
  if (zoning.dirty || !zoning.result) updateZoning()
  route.dirty = false
  const result = zoning.result as ZoningResult
  const n = result.samples
  const cell = terrain.options.cell
  const startIx = Math.round((START_X - terrain.origin) / cell)
  const startIz = Math.round((START_Z - terrain.origin) / cell)
  const half = route.extent >= FIELD_SIZE ? Infinity : route.extent / 2 / cell
  // 出発点から、届く範囲と正方形の両方に入る所だけをたどって広げる
  const mask = new Uint8Array(n * n)
  const stack = [startIz * n + startIx]
  while (stack.length > 0) {
    const i = stack.pop() as number
    if (mask[i] === 1 || !result.regions[result.labels[i]].reachable) continue
    const ix = i % n
    const iz = (i - ix) / n
    if (Math.abs(ix - startIx) > half || Math.abs(iz - startIz) > half) continue
    mask[i] = 1
    if (ix > 0) stack.push(i - 1)
    if (ix < n - 1) stack.push(i + 1)
    if (iz > 0) stack.push(i - n)
    if (iz < n - 1) stack.push(i + n)
  }
  const plan = planCoverage(
    { samples: terrain.samples, cell: terrain.options.cell, origin: terrain.origin, mask },
    {
      ...route.options,
      cutWidth: params.cutWidth,
      turnRadius: minTurnRadius(params) * 1.15,
      deckOffset: params.deckOffset,
      runIn: 1
    },
    sim.state.x,
    sim.state.z,
    sim.state.heading
  )
  route.plan = plan
  route.follower = new PathFollower(plan.path, params)
  pathLine.update(plan.path)
  // 旋回や外周では操舵に応じて減速するので、その分を大まかに見込む
  const seconds =
    plan.cutLength / (params.maxSpeed * 0.85) +
    plan.transitLength / (params.maxSpeed * DEFAULT_FOLLOWER.transitThrottle * 0.5)
  let cells = 0
  for (let i = 0; i < mask.length; i++) cells += mask[i]
  route.text = {
    area: `${((cells * cell * cell) / 10000).toFixed(2)} ha`,
    lines: `${plan.sweepCount}`,
    cut: formatKm(plan.cutLength),
    transit: formatKm(plan.transitLength),
    time: formatTime(seconds)
  }
}

function resetAll(): void {
  sim.state = createVehicleState(START_X, START_Z, 0)
  sim.elapsed = 0
  sim.distance = 0
  route.dirty = true
  route.follower = null
  deckLift = 0
  unitsStarted = false
  accumulator = 0
  coverage.reset()
  clippings.clear()
  mowMap.reset(UNCUT_HEIGHT)
}

// 起動時の指定(動作確認用): ?auto=1&timescale=16&cam=orbit&ui=0&help=1&seed=7&zones=1&path=1
if (query.get('auto') === '1') sim.autoDrive = true
const queryScale = Number(query.get('timescale'))
if (queryScale > 0) sim.timeScale = queryScale
const queryCam = query.get('cam') as CameraMode | null
if (queryCam && CAMERA_MODES.includes(queryCam)) rig.setMode(queryCam)
const queryZoom = Number(query.get('zoom'))
if (queryZoom > 0) rig.setZoom(queryZoom)
if (query.get('ui') === '0') document.body.classList.add('minimal-ui')
// ------------------------------------------------ UI

const syncs: Sync[] = []
function syncUi(): void {
  for (const sync of syncs) sync()
}

// マップの切り替え。選ぶと、そのマップでページを読み込み直す
byId('map-description').textContent = map.description
syncs.push(
  addSwitch(
    byId('map-switch'),
    MAPS.map((m) => ({ value: m.id, label: m.name, title: m.description })),
    () => map.id,
    (id) => {
      if (id === map.id) return
      const next = new URLSearchParams(window.location.search)
      next.set('map', id)
      next.delete('seed')
      window.location.search = next.toString()
    }
  )
)

const setStatus = addReadout(byId('status-readout'), {
  speed: '速度',
  deck: '刈刃',
  area: '刈った面積',
  slope: '勾配',
  altitude: '標高',
  distance: '走行距離',
  elapsed: '経過時間'
})
const setCameraReadout = addReadout(byId('camera-readout'), {
  lens: 'レンズ',
  exposure: '露出',
  focus: 'ピント'
})
const fpsCounter = byId('fps-counter')

const cameraFields = byId('camera-fields')
const focalRange = Math.log(FOCAL_MAX / FOCAL_MIN)
syncs.push(
  addCheck(
    cameraFields,
    '自動露出',
    '画面の明るさに合わせて、シャッター速度を自動で決めます。F 値や ISO を変えても明るさが保たれます',
    () => rig.settings.autoExposure,
    (v) => {
      rig.settings.autoExposure = v
    }
  ),
  addCheck(
    cameraFields,
    '被写界深度',
    '機体にピントを合わせ、手前や奥へ離れるほどぼかします。F 値が小さいほど、焦点距離が長いほど強くぼけます',
    () => rig.settings.depthOfField,
    (v) => {
      rig.settings.depthOfField = v
    }
  ),
  addSlider(cameraFields, {
    label: '焦点距離',
    title: 'レンズの焦点距離。大きいほど望遠になります。視点を切り替えると、その視点の初期値に戻ります',
    min: 0,
    max: 1,
    step: 0.005,
    get: () => Math.log(rig.settings.focalLength / FOCAL_MIN) / focalRange,
    set: (t) => {
      rig.settings.focalLength = Math.round(FOCAL_MIN * Math.exp(t * focalRange))
    },
    format: (t) => `${Math.round(FOCAL_MIN * Math.exp(t * focalRange))} mm`,
    // 視点ごとに初期値が違う
    defaultValue: () => Math.log(rig.defaultFocalLength / FOCAL_MIN) / focalRange
  }),
  addSlider(
    cameraFields,
    stopsSlider(
      'F 値',
      F_STOPS,
      () => rig.settings.fNumber,
      (v) => {
        rig.settings.fNumber = v
      },
      (v) => `F${v}`,
      'レンズの絞り。小さいほど明るくなります(1 段で 2 倍)'
    )
  ),
  addSlider(
    cameraFields,
    stopsSlider(
      'シャッター',
      SHUTTER_STOPS,
      () => 1 / rig.settings.shutterTime,
      (v) => {
        rig.settings.shutterTime = 1 / v
      },
      (v) => `1/${v}`,
      'シャッター速度(秒)。遅いほど明るくなります'
    )
  ),
  addSlider(
    cameraFields,
    stopsSlider(
      'ISO',
      ISO_STOPS,
      () => rig.settings.iso,
      (v) => {
        rig.settings.iso = v
      },
      (v) => String(v),
      'ISO 感度。高いほど明るくなります'
    )
  ),
  addSlider(cameraFields, {
    label: '露出補正',
    title: '全体の明るさを段数でずらします',
    min: -3,
    max: 3,
    step: 1 / 3,
    get: () => rig.settings.exposureCompensation,
    set: (v) => {
      rig.settings.exposureCompensation = v
    },
    format: (v) => `${v > 0.01 ? '+' : ''}${v.toFixed(1)} EV`
  }),
  addSlider(cameraFields, {
    label: 'ミニチュア倍率',
    title: '景色を「1 / 倍率 の大きさの模型」とみなして、ぼけを計算します。大きいほど模型を近くで撮ったような強いぼけになります。1 で実物どおり',
    min: 0,
    max: 1,
    step: 0.01,
    get: () => Math.log(rig.settings.miniatureScale) / Math.log(MINIATURE_MAX),
    set: (t) => {
      rig.settings.miniatureScale = Math.round(Math.pow(MINIATURE_MAX, t))
    },
    format: (t) => `${Math.round(Math.pow(MINIATURE_MAX, t))} 倍`
  }),
  addSlider(cameraFields, {
    label: 'ティルト',
    title: 'ピントの合う面を傾けます。正で画面の上側(奥)が、負で下側(手前)が、より強くぼけます',
    min: -60,
    max: 60,
    step: 1,
    get: () => rig.settings.tiltDeg,
    set: (v) => {
      rig.settings.tiltDeg = v
    },
    format: (v) => `${v.toFixed(0)}°`
  })
)

const lightFields = byId('light-fields')
syncs.push(
  addSlider(lightFields, {
    label: '太陽の高度',
    title: '低いほど影が長くなり、縞がはっきり見えます',
    min: 3,
    max: 85,
    step: 1,
    get: () => lighting.settings.sunElevation,
    set: (v) => {
      lighting.settings.sunElevation = v
    },
    format: (v) => `${v.toFixed(0)}°`
  }),
  addSlider(lightFields, {
    label: '太陽の方位',
    min: 0,
    max: 360,
    step: 1,
    get: () => lighting.settings.sunAzimuth,
    set: (v) => {
      lighting.settings.sunAzimuth = v
    },
    format: (v) => `${v.toFixed(0)}°`
  })
)

syncs.push(
  addSlider(lightFields, {
    label: '風',
    title: '木の枝と葉を揺らす風の強さ。0 で止まります',
    min: 0,
    max: 3,
    step: 0.1,
    get: () => windSettings.strength,
    set: (v) => {
      windSettings.strength = v
    },
    format: (v) => v.toFixed(1)
  })
)

const grassFields = byId('grass-fields')
syncs.push(
  addCheck(
    grassFields,
    '芝の葉',
    '機体のまわりの芝を、葉の 1 枚ずつまで描きます。重いときは外してください',
    () => bladeSettings.show,
    (v) => {
      bladeSettings.show = v
    }
  ),
  addSlider(grassFields, {
    label: '縞(視線)',
    title: '芝の倒れた向きと、見る向きの関係でつく明暗の強さ',
    min: 0,
    max: 1,
    step: 0.01,
    get: () => ground.uniforms.uStripe.value,
    set: (v) => {
      ground.uniforms.uStripe.value = v
    },
    format: (v) => v.toFixed(2)
  }),
  addSlider(grassFields, {
    label: '縞(太陽)',
    title: '芝の倒れた向きと、太陽の向きの関係でつく明暗の強さ',
    min: 0,
    max: 1,
    step: 0.01,
    get: () => ground.uniforms.uTilt.value,
    set: (v) => {
      ground.uniforms.uTilt.value = v
    },
    format: (v) => v.toFixed(2)
  }),
  addSlider(grassFields, {
    label: '刈高',
    title: 'これから刈る所の芝丈',
    min: 5,
    max: 60,
    step: 1,
    get: () => sim.cutHeightMm,
    set: (v) => {
      sim.cutHeightMm = v
    },
    format: (v) => `${v.toFixed(0)} mm`
  })
)

const setZoneReadout = addReadout(byId('zone-readout'), {
  ride: '乗用機',
  reachable: 'うち届く範囲',
  slope: '斜面用機',
  none: '刈らない',
  regions: '領域の数'
})
const zoneFields = byId('zone-fields')
const zoneSlider = (
  label: string,
  title: string,
  key: keyof typeof zoning.options,
  min: number,
  max: number,
  step: number,
  unit: string
): Sync =>
  addSlider(zoneFields, {
    label,
    title,
    min,
    max,
    step,
    get: () => zoning.options[key],
    set: (v) => {
      zoning.options[key] = v
      // 乗用機の上限が斜面用機の上限を超えないようにする
      if (key === 'rideMaxDeg' && v > zoning.options.slopeMaxDeg) zoning.options.slopeMaxDeg = v
      if (key === 'slopeMaxDeg' && v < zoning.options.rideMaxDeg) zoning.options.rideMaxDeg = v
      zoning.dirty = true
      syncUi()
    },
    format: (v) => `${v.toFixed(step < 1 ? 1 : 0)}${unit}`
  })
function setZoneShow(on: boolean): void {
  zoning.show = on
  syncUi()
}
syncs.push(
  addSwitch(
    byId('zone-switch'),
    [
      { value: false, label: '隠す', title: '区分けを表示しない(Z)' },
      { value: true, label: '表示', title: '区分けを色と輪郭線で表示する(Z)' }
    ],
    () => zoning.show,
    setZoneShow
  ),
  () => {
    zoneOverlay.visible = zoning.show
  },
  zoneSlider('乗用機の上限', '乗用の芝刈り機で刈る勾配の上限', 'rideMaxDeg', 5, 30, 1, '°'),
  zoneSlider('斜面用機の上限', '斜面用の機種で刈る勾配の上限。これより急な所は刈らない', 'slopeMaxDeg', 10, 45, 1, '°'),
  zoneSlider('境目の幅', '閾値の前後に取る幅。大きいほど境目の細かな出入りが減る', 'hysteresisDeg', 0, 5, 0.5, '°'),
  zoneSlider('ならし', '勾配を求める前に地形をならす半径。細かな凹凸を無視する', 'smoothRadius', 0, 8, 1, ' m'),
  zoneSlider('整形', '周りの多数派に合わせて形を整える半径', 'majorityRadius', 0, 8, 1, ' m'),
  zoneSlider('最小の面積', 'これより狭い領域は周りの区分に吸収する', 'minArea', 0, 1000, 25, ' m²')
)
if (zoning.show) byId<HTMLDetailsElement>('zone-panel').open = true

const setRouteReadout = addReadout(byId('route-readout'), {
  area: '刈る面積',
  lines: '列の数',
  cut: '刈る距離',
  transit: '移動距離',
  time: '所要時間の目安',
  progress: '進み具合'
})
const routeFields = byId('route-fields')
const routeSlider = (
  label: string,
  title: string,
  key: keyof typeof route.options,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string
): Sync =>
  addSlider(routeFields, {
    label,
    title,
    min,
    max,
    step,
    get: () => route.options[key],
    set: (v) => {
      route.options[key] = v
      route.dirty = true
    },
    format
  })
function setRouteShow(on: boolean): void {
  route.show = on
  syncUi()
}
syncs.push(
  addSwitch(
    byId('route-switch'),
    [
      { value: false, label: '隠す', title: '経路を表示しない(G)' },
      { value: true, label: '表示', title: '経路を線で表示する(G)。暗い線は刈刃を上げて移動する区間' }
    ],
    () => route.show,
    setRouteShow
  ),
  () => {
    pathLine.visible = route.show
  },
  addSlider(routeFields, {
    label: '刈る範囲',
    title: '出発点を中心とする正方形の一辺。右端まで動かすと全体を刈る',
    min: 40,
    max: FIELD_SIZE,
    step: 4,
    get: () => route.extent,
    set: (v) => {
      route.extent = v
      route.dirty = true
    },
    format: (v) => (v >= FIELD_SIZE ? '全体' : `${v.toFixed(0)} m 四方`)
  }),
  routeSlider('刈る向き', '往復刈りの列の向き。0° で画面の奥行き方向', 'angleDeg', 0, 175, 5, (v) => `${v.toFixed(0)}°`),
  routeSlider('重ねる幅', '隣の列と重ねる幅。刈り残しを防ぐ', 'overlap', 0, 1, 0.05, (v) => `${(v * 100).toFixed(0)} cm`),
  routeSlider('外周の周回', '最後に境界沿いを回る回数。旋回の場所にもなる', 'headlandPasses', 0, 5, 1, (v) => `${v.toFixed(0)} 周`)
)
if (route.show) byId<HTMLDetailsElement>('route-panel').open = true

syncs.push(
  addSwitch(
    byId('speed-switch'),
    TIME_SCALES.map((scale, i) => ({
      value: scale,
      label: `${scale}×`,
      title: `${scale} 倍速(${i + 1})`
    })),
    () => sim.timeScale,
    (v) => {
      sim.timeScale = v
    }
  ),
  addSwitch(
    byId('view-switch'),
    CAMERA_MODES.map((mode) => ({
      value: mode,
      label: CAMERA_MODE_LABELS[mode],
      title: `${CAMERA_MODE_LABELS[mode]}の視点(C で切り替え)`
    })),
    () => rig.mode,
    (mode) => {
      rig.setMode(mode)
      syncUi()
    }
  )
)

const autoButton = byId<HTMLButtonElement>('toggle-auto')
function setAutoDrive(on: boolean): void {
  sim.autoDrive = on
  // まだ走り出していない経路は、今いる所から作り直す
  if (on && (!route.follower || route.follower.segment === 0)) route.dirty = true
  syncUi()
}
syncs.push(() => {
  autoButton.setAttribute('aria-pressed', String(sim.autoDrive))
  const label = sim.autoDrive ? '自動運転を止める' : '自動運転'
  autoButton.setAttribute('aria-label', label)
  autoButton.title = `${label}(P)`
})
autoButton.addEventListener('click', () => {
  setAutoDrive(!sim.autoDrive)
  autoButton.blur()
})
const resetButton = byId<HTMLButtonElement>('reset')
resetButton.addEventListener('click', () => {
  resetAll()
  resetButton.blur()
})

const toggleHelp = setupHelp([
  {
    title: '運転',
    items: [
      { keys: ['W', '↑'], text: '前進' },
      { keys: ['S', '↓'], text: '後退' },
      { keys: ['A', '←'], text: '左へ操舵' },
      { keys: ['D', '→'], text: '右へ操舵' },
      { keys: ['Space'], text: '刈刃の上げ下げ' }
    ]
  },
  {
    title: '視点',
    items: [
      { keys: ['C'], text: '視点を切り替える(追従、ドローン、俯瞰、定点)' },
      { keys: ['右ドラッグ'], text: '定点の視点で、カメラの位置を動かす' },
      { keys: ['左ドラッグ'], text: '機体を中心に回り込む(追従視点では、離して 2 秒で背後に戻る)' },
      { keys: ['ホイール'], text: 'カメラを近づける、離す(画角は変わらない)' }
    ]
  },
  {
    title: 'シミュレーション',
    items: [
      { keys: ['1', '〜', '7'], text: '倍速(1、2、4、8、16、32、64 倍)' },
      { keys: ['P'], text: '自動運転の開始と停止' },
      { keys: ['G'], text: '経路の表示と非表示' },
      { keys: ['R'], text: 'やり直し(芝を元に戻す)' },
      { keys: ['Z'], text: '勾配による区分けの表示と非表示' }
    ]
  },
  {
    title: 'その他',
    items: [
      { keys: [','], text: '設定ウインドウを開く、閉じる' },
      { keys: ['?'], text: 'この一覧を開く、閉じる' }
    ]
  }
])
if (query.get('help') === '1') toggleHelp()

const input = new KeyboardInput(window)
input.onPress('Space', () => {
  if (!sim.autoDrive) sim.state.deckDown = !sim.state.deckDown
})
input.onPress('KeyC', () => {
  rig.nextMode()
  syncUi()
})
input.onPress('KeyP', () => setAutoDrive(!sim.autoDrive))
input.onPress('KeyR', resetAll)
input.onPress('KeyG', () => setRouteShow(!route.show))
input.onPress('KeyZ', () => setZoneShow(!zoning.show))
// 設定ウインドウ。セクション(タブ)ごとに項目を並べる
function applySetting(key: keyof AppSettings): void {
  if (key === 'pixelRatio') resize()
  else if (key === 'showFps') fpsCounter.hidden = !settings.showFps
  else if (key === 'showHint') byId('view-hint').hidden = !settings.showHint
  else if (key === 'grassDistance') grassBlades.setRadius(settings.grassDistance)
  else if (key === 'shadowDistance') lighting.setShadowDistance(settings.shadowDistance)
  else if (key === 'shadowMapSize') lighting.setShadowMapSize(settings.shadowMapSize)
  else if (key === 'clippings') {
    clippings.mesh.visible = settings.clippings
    if (!settings.clippings) clippings.clear()
  }
}
const toggleSettings = setupSettings(
  settings,
  [
    {
      title: '描画',
      items: [
        {
          type: 'choice',
          key: 'fpsLimit',
          label: '描画 FPS の上限',
          title: '1 秒あたりに描く回数の上限。下げると、PC の負荷と発熱が減ります。「なし」は画面の更新に合わせます',
          options: [
            { value: 30, label: '30' },
            { value: 60, label: '60' },
            { value: 90, label: '90' },
            { value: 120, label: '120' },
            { value: 0, label: 'なし' }
          ]
        },
        {
          type: 'choice',
          key: 'pixelRatio',
          label: '描画の細かさ',
          title: '高精細の画面で、どこまで細かく描くか。下げると軽くなり、少しぼやけます',
          options: [
            { value: 1, label: '標準' },
            { value: 1.5, label: '高' },
            { value: 2, label: '最高' }
          ]
        },
        {
          type: 'slider',
          key: 'grassDistance',
          label: '芝を描く距離',
          title: 'カメラが見ている地面のまわり、この距離まで芝の葉を 1 枚ずつ描きます。12 m より先は葉をまばらにします。長くすると重くなります',
          min: 8,
          max: 60,
          step: 2,
          format: (v) => `${v.toFixed(0)} m`
        }
      ]
    },
    {
      title: '影',
      items: [
        {
          type: 'slider',
          key: 'shadowDistance',
          label: '影を描く距離',
          title: 'カメラからこの距離までに影を落とします。短くすると、近くの影が細かくなります',
          min: 60,
          max: 500,
          step: 10,
          format: (v) => `${v.toFixed(0)} m`
        },
        {
          type: 'choice',
          key: 'shadowMapSize',
          label: '影の細かさ',
          title: '影の地図の大きさ。大きいほど影の縁がくっきりし、重くなります',
          options: [
            { value: 1024, label: '低' },
            { value: 2048, label: '中' },
            { value: 4096, label: '高' }
          ]
        }
      ]
    },
    {
      title: '表示',
      items: [
        { type: 'check', key: 'showFps', label: 'FPS を表示', title: '左上に、1 秒あたりの描画の回数を出します' },
        { type: 'check', key: 'showHint', label: '操作の案内を表示', title: '画面の上に、操作の案内を出します' },
        { type: 'check', key: 'clippings', label: '刈りカスを表示', title: '刈刃から飛ぶ刈りカスの粒を描きます' }
      ]
    }
  ],
  applySetting
)
for (const key of Object.keys(settings) as (keyof AppSettings)[]) applySetting(key)
input.onPress('Comma', toggleSettings)
if (query.get('settings') === '1') toggleSettings()
input.onPress('Slash', toggleHelp)
TIME_SCALES.forEach((scale, i) => {
  input.onPress(`Digit${i + 1}`, () => {
    sim.timeScale = scale
    syncUi()
  })
})
syncUi()

// ------------------------------------------------ シミュレーション

function stepSimulation(): void {
  const state = sim.state
  let vehicleInput = input.read()
  if (sim.autoDrive && route.follower) {
    const out = route.follower.update(state)
    vehicleInput = out
    state.deckDown = out.deckDown
    if (out.finished) setAutoDrive(false)
  }

  const grade = terrain.gradeAlong(state.x, state.z, state.heading, params.wheelbase)
  stepVehicle(state, vehicleInput, params, SIM_DT, grade)
  sim.elapsed += SIM_DT
  sim.distance += Math.abs(state.speed) * SIM_DT

  // 刈刃は一瞬では上下しない。下りきるまでの間は、高めに刈る(刈り始めと刈り終わりがなだらかになる)
  const liftTarget = state.deckDown ? 0 : 1
  const liftStep = SIM_DT / DECK_MOVE_TIME
  deckLift += Math.min(Math.max(liftTarget - deckLift, -liftStep), liftStep)
  const cutting = deckLift < DECK_CUT_LIMIT && Math.abs(state.speed) > 0.01

  // リールは 1 連ずつ別々の帯として描き込む(位置と幅は機種の定義による)
  const hx = Math.sin(state.heading)
  const hz = Math.cos(state.heading)
  reelSegments(state, params, unitsNow)
  const deck = deckSegment(state, params)
  if (cutting && unitsStarted) {
    const sign = state.speed >= 0 ? 1 : -1
    const height = sim.cutHeightMm / 1000 + deckLift * DECK_LIFT_HEIGHT
    for (let k = 0; k < unitsNow.length; k += 4) {
      mowMap.addQuad(
        unitsPrev[k],
        unitsPrev[k + 1],
        unitsPrev[k + 2],
        unitsPrev[k + 3],
        unitsNow[k + 2],
        unitsNow[k + 3],
        unitsNow[k],
        unitsNow[k + 1],
        hx * sign * CUT_LEAN,
        hz * sign * CUT_LEAN,
        height
      )
    }
    // まだ刈っていない所を通った分だけ、刈りカスが出る。長い芝ほど多い
    if (deckLift < 0.4) {
      const newCells = coverage.markSegment(deck.lx, deck.lz, deck.rx, deck.rz)
      if (newCells > 0) {
        const length = grassField.lengthFactorAt((deck.lx + deck.rx) / 2, (deck.lz + deck.rz) / 2)
        cutVolume += newCells * coverage.cellSize * coverage.cellSize * length
      }
    }
  }
  unitsPrev.set(unitsNow)
  unitsStarted = cutting

  // 車輪の跡: 芝丈は変えずに、踏んだ所の芝を進行方向へ寝かせる。
  // 刈刃は車輪より前にあるので、刈った直後の芝の上にも跡が重なる
  wheelPositions(state, params, wheelsNow)
  if (!tracksStarted) {
    wheelsPrev.set(wheelsNow)
    tracksStarted = true
  }
  const moved = Math.hypot(wheelsNow[0] - wheelsPrev[0], wheelsNow[1] - wheelsPrev[1])
  if (moved > 5) {
    // やり直しなどで位置が飛んだときは、線を引かない
    wheelsPrev.set(wheelsNow)
  } else if (moved >= TRACK_STEP) {
    const sign = state.speed >= 0 ? 1 : -1
    const dirX = Math.sin(state.heading) * sign
    const dirZ = Math.cos(state.heading) * sign
    for (let i = 0; i < wheelsNow.length; i += 2) {
      const width = params.wheels[i / 2].width
      const halfX = (Math.cos(state.heading) * width) / 2
      const halfZ = (-Math.sin(state.heading) * width) / 2
      mowMap.addQuad(
        wheelsPrev[i] + halfX,
        wheelsPrev[i + 1] + halfZ,
        wheelsPrev[i] - halfX,
        wheelsPrev[i + 1] - halfZ,
        wheelsNow[i] - halfX,
        wheelsNow[i + 1] - halfZ,
        wheelsNow[i] + halfX,
        wheelsNow[i + 1] + halfZ,
        dirX,
        dirZ,
        MAX_GRASS_HEIGHT,
        0.3
      )
    }
    wheelsPrev.set(wheelsNow)
  }
}

function resize(): void {
  const w = window.innerWidth
  const h = window.innerHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio))
  renderer.setSize(w, h, false)
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(w, h)
  // 重ねて描く線の太さは画素で決めるので、描画先の大きさを伝える
  overlayPixelRatio.value = renderer.getPixelRatio()
  overlayResolution.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio())
  rig.setAspect(w / h)
}
window.addEventListener('resize', resize)
resize()

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

let fps = 60
const logFps = query.get('log') === '1'
let logTimer = 0
function updateReadouts(dt: number): void {
  if (dt > 0) fps += (1 / dt - fps) * 0.05
  const s = rig.settings
  setStatus({
    speed: `${(sim.state.speed * 3.6).toFixed(1)} km/h`,
    deck: sim.state.deckDown ? '下げ' : '上げ',
    area: `${coverage.coveredArea.toFixed(0)} m²`,
    slope: `${((terrain.slopeAt(sim.state.x, sim.state.z, 2) * 180) / Math.PI).toFixed(0)}°`,
    altitude: `${terrain.heightAt(sim.state.x, sim.state.z).toFixed(1)} m`,
    distance: `${sim.distance.toFixed(0)} m`,
    elapsed: formatTime(sim.elapsed)
  })
  setCameraReadout({
    lens: `${s.focalLength.toFixed(0)} mm  F${s.fNumber}`,
    focus: `${focusDistance.toFixed(1)} m`,
    exposure: `1/${Math.round(1 / s.shutterTime)} 秒  ISO ${s.iso}  EV ${ev100(s.fNumber, s.shutterTime, s.iso).toFixed(1)}`
  })
  setRouteReadout({
    ...route.text,
    progress: route.follower ? `${(route.follower.progress * 100).toFixed(1)}%` : '-'
  })
  // 動作確認用: ?log=1 で、描画の速さをログに出す
  if (logFps && (logTimer += dt) > 2) {
    logTimer = 0
    console.warn(`fps ${fps.toFixed(0)}`)
  }
  const fpsText = `${fps.toFixed(0)} fps`
  if (fpsCounter.textContent !== fpsText) fpsCounter.textContent = fpsText
}

let focusDistance = 0
let frameCount = 0
let autoSyncTimer = 0
const viewDirection = new Vector3()
const scratch = new Vector3()
/** このフレームで刈った量に応じて、刈刃から刈りカスを飛ばす */
function emitClippings(): void {
  // 倍速が高いときは粒を間引く(見た目の量をおおよそ保ち、重くしない)
  clippingDebt += (cutVolume * CLIPPINGS_PER_VOLUME) / Math.sqrt(sim.timeScale)
  cutVolume = 0
  const count = Math.min(Math.floor(clippingDebt), 80)
  clippingDebt -= Math.floor(clippingDebt)
  if (count === 0) return
  const state = sim.state
  const deck = deckSegment(state, params)
  const fx = Math.sin(state.heading)
  const fz = Math.cos(state.heading)
  for (let i = 0; i < count; i++) {
    const t = Math.random()
    const x = deck.lx + (deck.rx - deck.lx) * t - fx * 0.15
    const z = deck.lz + (deck.rz - deck.lz) * t - fz * 0.15
    // 機体の動きを少し引き継ぎつつ、後ろ斜め上へ飛ばす
    const back = 0.4 + Math.random() * 1.6
    const side = (Math.random() - 0.5) * 1.8
    const carry = state.speed * 0.35
    spawnClipping(
      x,
      z,
      fx * (carry - back) + fz * side,
      1.6 + Math.random() * 2.6,
      fz * (carry - back) - fx * side
    )
  }
}

function spawnClipping(x: number, z: number, vx: number, vy: number, vz: number): void {
  clippings.spawn(x, terrain.heightAt(x, z) + 0.1 + Math.random() * 0.1, z, vx, vy, vz)
}

let last = performance.now()
function frame(now: number): void {
  requestAnimationFrame(frame)
  // 描画 FPS の上限。前に描いてからの時間が足りなければ、この回は描かない。
  // 画面の更新の間隔には揺れがあるので、少し(1.5 ミリ秒)手前で描いてよいことにする
  if (settings.fpsLimit > 0 && now - last < 1000 / settings.fpsLimit - 1.5) return
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  accumulator += dt * sim.timeScale
  let steps = 0
  while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
    stepSimulation()
    accumulator -= SIM_DT
    steps++
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
  mowMap.flush()
  if (settings.clippings) emitClippings()
  else cutVolume = 0
  // 粒は、倍速を上げても速くなりすぎないように進める
  clippings.update(dt * Math.min(sim.timeScale, 3))
  if (zoning.dirty) updateZoning()
  if (route.dirty && (route.show || sim.autoDrive)) updateRoute()

  mower.sync(sim.state, dt * sim.timeScale, terrain)
  rig.update(sim.state, dt, terrain)
  const exposure = rig.exposure
  treeModels.update(now / 1000, windSettings.strength)
  // 後から読み込んだモデルの材質も、影の仕組みに対応させる
  if (frameCount++ % 30 === 0) lighting.prepareMaterials(scene)
  pathLine.done = sim.autoDrive || (route.follower && route.follower.segment > 0) ? (route.follower?.progress ?? 0) : 0
  grassBlades.update(rig.camera, bladeSettings.show)
  lighting.update(exposure, rig.camera.position)

  // ピントは機体に合わせる。視線に沿った距離で持つ
  const s = rig.settings
  const focusTarget = Math.max(
    0.5,
    viewDirection.copy(rig.focusPoint).sub(rig.camera.position).dot(rig.camera.getWorldDirection(scratch))
  )
  focusDistance = focusDistance === 0 ? focusTarget : focusDistance + (focusTarget - focusDistance) * Math.min(1, dt * 6)
  dofPass.enabled = s.depthOfField
  dofPass.update({
    focalLength: s.focalLength,
    fNumber: s.fNumber,
    sensorWidth: s.sensorWidth,
    focusDistance,
    // 機体の前後がぼけないように、ピントの前後この距離まではくっきり写す
    focusRange: 2.2,
    scale: s.miniatureScale,
    tiltDeg: s.tiltDeg,
    fovY: rig.camera.fov,
    near: rig.camera.near,
    far: rig.camera.far
  })
  composer.render()

  // 自動露出: 測った明るさが標準の明るさになる露出へ、少しずつ寄せる
  if (s.autoExposure && meterPass.log2Average !== null) {
    const luminance = Math.pow(2, meterPass.log2Average) / exposure
    const target = ev100FromLuminance(luminance)
    const current = ev100(s.fNumber, s.shutterTime, s.iso)
    const next = current + (target - current) * (1 - Math.exp(-dt * 3))
    s.shutterTime = Math.min(Math.max(shutterTimeForEv100(next, s.fNumber, s.iso), 1 / 32000), 0.5)
    autoSyncTimer += dt
    if (autoSyncTimer > 0.5) {
      autoSyncTimer = 0
      syncUi()
    }
  }
  updateReadouts(dt)
}
requestAnimationFrame(frame)
