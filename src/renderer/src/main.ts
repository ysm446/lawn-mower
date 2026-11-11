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
import { CAMERA_MODES, CAMERA_MODE_LABELS, CameraRig, ORBIT_LEVELS, type CameraMode } from './render/cameraRig'
import { Clippings } from './render/clippings'
import { GrassBlades } from './render/grassBlades'
import { NormalPreview } from './render/normalPreview'
import { createGround } from './render/ground'
import { Lighting } from './render/lighting'
import { MowMap } from './render/mowMap'
import { overlayPixelRatio, overlayResolution } from './render/overlay/ribbon'
import { PathLine } from './render/pathLine'
import { Trees } from './render/trees'
import { DofPass, MeterPass } from './render/postfx'
import { PlotOverlay } from './render/plotOverlay'
import { ZoneOverlay } from './render/zoneOverlay'
import { ev100, ev100FromLuminance, shutterTimeForEv100 } from './camera/exposure'
import { CoverageGrid } from './sim/coverage'
import { planCoverage, type MowPattern } from './sim/coveragePlan'
import { DEFAULT_FOLLOWER, PathFollower } from './sim/pathFollower'
import { GrassField } from './sim/grassField'
import { loadSettings, setupSettings, type AppSettings } from './settings'
import { MAPS, findMap } from './sim/maps'
import { DEFAULT_TERRAIN, Terrain } from './sim/terrain'
import { DEFAULT_PLOTS, clusterPlots, type PlotResult } from './sim/plots'
import { advanceHour, daylightHours, formatHour, sunAngles } from './sim/sunPath'
import { blockedByTrees, generateTrees } from './sim/trees'
import {
  DEFAULT_ZONING,
  ZONE_NONE,
  ZONE_RIDE,
  ZONE_SLOPE,
  computeZoning,
  type ZoningResult
} from './sim/zoning'
import { FAIRWAY_MOWER, minTurnRadius, type VehicleInput } from './sim/vehicle'
import { MowerUnit, type StepContext } from './mowerUnit'
import { initScreenRecorder } from './screenRecorder'
import { SunGizmo } from './sunGizmo'
import {
  addCheck,
  addPanelToggle,
  addReadout,
  addSelect,
  addSlider,
  addSwitch,
  byId,
  restorePanelValues,
  setupHelp,
  stopsSlider,
  type Sync
} from './ui'

// 単位はすべて実寸(1 = 1 m)
const FIELD_SIZE = 512
const FIELD_ORIGIN = -FIELD_SIZE / 2
const GROUND_EXTENT = 7000
const MAX_GRASS_HEIGHT = 0.2
const SIM_DT = 1 / 120
// 1 回の描画で進める刻みの上限。タイムラプスでは 1 コマの間に長い時間が進むので、多めに取る
const MAX_STEPS_PER_FRAME = 4000
// 乗っていない機体と、自動運転中の機体に渡す、手の運転の入力(何もしない)
const IDLE_INPUT: VehicleInput = { throttle: 0, steer: 0 }
// 刈った量(m² × 長さの倍率)あたりの粒の数
const CLIPPINGS_PER_VOLUME = 40
const TIME_SCALES = [1, 2, 4, 8, 16, 32, 64, 128, 256]
/** 起動時の時刻(時)。太陽が既定の向き(高度 28°、方位 125°)に近い朝 */
const START_HOUR = 7.5
/** タイムラプスに切り替えたとき、倍速がこれより低ければ TIMELAPSE_SCALE に上げる */
const TIMELAPSE_MIN_SCALE = 16
const TIMELAPSE_SCALE = 32
/** 1 秒(実時間)に飛ばす刈りカスの粒の数の上限。これを超えそうなときは、道のり全体から均等に間引く */
const CLIPPINGS_PER_SECOND = 6000

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
// 時間の表現。タイムラプス(コマ落ち)と、時刻で動く太陽
const queryHour = Number(query.get('time'))
const timeSettings = {
  /** タイムラプス: 時間を毎秒 fps 回にまとめて進め、1 コマごとに動きが飛ぶようにする(画面は間引かない) */
  timelapse: query.get('timelapse') === '1',
  fps: 12,
  /** 時刻(時)。シミュレーションの時間とともに進む */
  hour: queryHour > 0 ? queryHour : START_HOUR,
  /** 太陽を時刻に合わせて動かすか。太陽を手で動かすとオフになる */
  sunFollowsClock: true
}
// 太陽の向きを直接決める(動作確認用)。時刻では動かさなくなる
const querySunElevation = Number(query.get('sunel'))
if (querySunElevation > 0) {
  lighting.settings.sunElevation = querySunElevation
  lighting.settings.sunAzimuth = Number(query.get('sunaz') ?? 0)
  timeSettings.sunFollowsClock = false
}
const queryClouds = query.get('clouds')
if (queryClouds !== null) lighting.settings.cloudCover = Number(queryClouds)
// スカイライト強度(動作確認用)
const querySkylight = query.get('skylight')
if (querySkylight !== null) lighting.settings.skylightIntensity = Number(querySkylight)
function setTimelapse(on: boolean): void {
  timeSettings.timelapse = on
  // 等倍のままでは、ただ動きが粗くなるだけなので、倍速を上げる
  if (on && sim.timeScale < TIMELAPSE_MIN_SCALE) sim.timeScale = TIMELAPSE_SCALE
  syncUi()
}

const zoneOverlay = new ZoneOverlay(terrain)
scene.add(zoneOverlay.lines)
const plotOverlay = new PlotOverlay(terrain)
scene.add(plotOverlay.lines)

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
// 太陽の向きは、光の設定と同じものを見る(逆光のときの芝の色に使う)
ground.uniforms.uSunDir.value = lighting.sunDirection

// 近景の芝の葉。?blades=0 で描かない
const grassBlades = new GrassBlades(terrain, ground.uniforms)
const bladeSettings = { show: query.get('blades') !== '0' }
// 動作確認用: 刈った地面の法線マップを、左上に 2D の画像で出す(起動時の指定 normals=1 でも出せる)
const debugSettings = { normals: query.get('normals') === '1' }
const normalPanel = byId('normal-panel')
const normalPreview = new NormalPreview(ground.uniforms, byId<HTMLCanvasElement>('normal-canvas'))
byId('normal-note').textContent = `機体のまわり ${normalPreview.span} m 四方。上がカメラの向き。赤は右、緑は上へ傾いた所`
normalPanel.hidden = !debugSettings.normals
let normalTimer = 0
scene.add(grassBlades.mesh)

// 刈りカスの粒
const clippings = new Clippings(terrain)
scene.add(clippings.mesh)
// このフレームで刈った芝の量(面積 × 長さの倍率)。粒の数を決めるのに使う
let clippingDebt = 0
// この描画の間に出るはずだった粒の数と、それをもとに決めた次の描画での間引きの割合
let clippingDemand = 0
let clippingKeep = 1
let clippingTime = 0

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
  plotting.dirty = true
  markRoutesDirty()
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

// 区画分け。乗用機で刈れて届く範囲を、地形の特徴でいくつかの区画に分ける。自動運転は区画ごとに刈る
const plotting = {
  options: { ...DEFAULT_PLOTS, targetArea: map.plotArea },
  dirty: true,
  result: null as PlotResult | null,
  /** 乗用機で刈れて、出発点から届く範囲(1)。区画をまたぐ移動で通ってよい所 */
  reach: null as Uint8Array | null,
  /** 刈り終えた区画。どの機体が刈る区画かは、機体ごとに持つ(MowerUnit.plot) */
  done: new Set<number>(),
  /** 1 つ刈り終えたら、続けて次の区画へ進むか */
  sequence: true,
  /** 自動運転の機体が、同じ区画の列を分け合って刈るか(オフなら、別々の区画を刈る)。起動時の指定 team=1 でオン */
  teamwork: query.get('team') === '1'
}

function updatePlots(): void {
  if (zoning.dirty || !zoning.result) updateZoning()
  plotting.dirty = false
  const zones = zoning.result as ZoningResult
  const n = zones.samples
  const cell = terrain.options.cell
  const reach = new Uint8Array(n * n)
  for (let i = 0; i < reach.length; i++) reach[i] = zones.regions[zones.labels[i]].reachable ? 1 : 0
  const result = clusterPlots(
    reach,
    terrain.heights,
    n,
    cell,
    plotting.options,
    (START_X - terrain.origin) / cell,
    (START_Z - terrain.origin) / cell
  )
  plotting.reach = reach
  plotting.result = result
  plotting.done.clear()
  // 区画が変わったので、受け持つ区画は決め直す(自動運転のとき、空いている区画を引き受ける)
  for (const unit of mowers) {
    unit.plot = -1
    unit.finishedPlot = -1
  }
  plotOverlay.update(result)
  refreshPlotOverlay()
  markRoutesDirty()
}

/** 全台の経路を作り直す印をつける。dropFollower なら、走っている経路も捨てる */
function markRoutesDirty(dropFollower = false): void {
  for (const unit of mowers) {
    unit.route.dirty = true
    if (dropFollower) unit.route.follower = null
  }
}

/** 区画の線を描き直す。乗っている機体の受け持つ区画を「今の区画」として目立たせる */
function refreshPlotOverlay(): void {
  plotOverlay.setState(rider ? rider.plot : -1, plotting.done)
}

/** ほかの機体が受け持っていて、まだ刈り終えていない区画か */
function plotTaken(id: number, except: MowerUnit): boolean {
  return mowers.some((m) => m !== except && m.plot === id && m.autoDrive && !plotting.done.has(id))
}

/**
 * 機体に、刈る区画を割り当てる。今の区画がまだ刈り終えておらず、ほかの機体と重ならなければそのまま。
 * そうでなければ、機体のいる区画、なければ近い順に、刈り終えておらず誰も受け持っていない区画を選ぶ
 */
function assignPlot(unit: MowerUnit): void {
  const result = plotting.result
  if (!result || result.plots.length === 0) return
  if (plotting.teamwork) {
    // 分担して刈るときは、今の区画を続けるか、ほかの機体が刈っている区画に加わる(自分の分を終えた区画には戻らない)
    const open = (id: number): boolean => id >= 0 && !plotting.done.has(id) && id !== unit.finishedPlot
    if (open(unit.plot)) return
    const joined = teamPlots(unit).find(open)
    if (joined !== undefined) {
      unit.plot = joined
      return
    }
  }
  const free = (id: number): boolean =>
    id >= 0 && !plotting.done.has(id) && !plotTaken(id, unit) && id !== unit.finishedPlot
  if (free(unit.plot)) return
  const here = plotAt(unit.state.x, unit.state.z)
  if (free(here)) {
    unit.plot = here
    return
  }
  const cell = terrain.options.cell
  let best = -1
  let bestDistance = Infinity
  for (const plot of result.plots) {
    if (!free(plot.id)) continue
    const d = Math.hypot(
      terrain.origin + plot.centerX * cell - unit.state.x,
      terrain.origin + plot.centerZ * cell - unit.state.z
    )
    if (d < bestDistance) {
      bestDistance = d
      best = plot.id
    }
  }
  // 空いている区画がなければ、刈り終えていない区画のうち、受け持つ機体がいちばん少ない所に加わる(近い順)。
  // 同じ区画を受け持った機体どうしは、列を分け合って刈る(teamOf)
  if (best < 0) {
    let fewest = Infinity
    bestDistance = Infinity
    for (const plot of result.plots) {
      if (plotting.done.has(plot.id) || plot.id === unit.finishedPlot) continue
      const count = mowers.filter((m) => m !== unit && m.autoDrive && m.plot === plot.id).length
      const d = Math.hypot(
        terrain.origin + plot.centerX * cell - unit.state.x,
        terrain.origin + plot.centerZ * cell - unit.state.z
      )
      if (count < fewest || (count === fewest && d < bestDistance)) {
        fewest = count
        bestDistance = d
        best = plot.id
      }
    }
  }
  unit.plot = best
}

/** ほかの自動運転の機体が刈っている区画(近い機体の順) */
function teamPlots(unit: MowerUnit): number[] {
  return mowers
    .filter((m) => m !== unit && m.autoDrive && m.plot >= 0 && !plotting.done.has(m.plot))
    .sort(
      (a, b) =>
        Math.hypot(a.state.x - unit.state.x, a.state.z - unit.state.z) -
        Math.hypot(b.state.x - unit.state.x, b.state.z - unit.state.z)
    )
    .map((m) => m.plot)
}

/**
 * 区画を分担して刈る組。その区画を受け持つ自動運転の機体を、列に直交する向きの位置の順に並べる
 * (列の並びの左から順に、まとまりを割り振るため)。分担しないときは、その機体だけ
 */
function teamOf(unit: MowerUnit): MowerUnit[] {
  // 「分担して刈る」がオフでも、区画が足りずに同じ区画を受け持ったときは分担する(同じ経路を重ねて走らないように)
  if (unit.plot < 0) return [unit]
  const angle = (route.options.angleDeg * Math.PI) / 180
  const nx = Math.cos(angle)
  const nz = -Math.sin(angle)
  return mowers
    .filter((m) => m === unit || (m.autoDrive && m.plot === unit.plot && m.finishedPlot !== unit.plot))
    .sort((a, b) => a.state.x * nx + a.state.z * nz - (b.state.x * nx + b.state.z * nz))
}

/**
 * 分担している組に新しい機体が加わったら、組の全員の経路を作り直す(残っている列を、新しい組で分け直す)。
 * 機体が抜けたときは作り直さない(残りの機体は、自分の分をそのまま刈る)。毎フレーム呼ぶ
 */
function checkTeams(): void {
  for (const unit of mowers) {
    if (!unit.autoDrive || !unit.route.plan || unit.route.dirty) continue
    const team = teamOf(unit).map((m) => m.index)
    if (team.some((i) => !unit.route.team.includes(i))) {
      unit.route.dirty = true
      unit.route.follower = null
    }
  }
}

/** その地点の区画の番号。区画の外なら -1 */
function plotAt(x: number, z: number): number {
  const result = plotting.result
  if (!result) return -1
  const n = result.samples
  const ix = Math.round((x - terrain.origin) / terrain.options.cell)
  const iz = Math.round((z - terrain.origin) / terrain.options.cell)
  if (ix < 0 || iz < 0 || ix >= n || iz >= n) return -1
  return result.labels[iz * n + ix]
}

/**
 * 乗っている機体が刈る区画を選ぶ。自動運転は止めずに、今いる所からその区画へ向かう経路を作り直す。
 * 誰にも乗っていないときは何もしない
 */
function selectPlot(id: number): void {
  const count = plotting.result?.plots.length ?? 0
  if (count === 0 || !rider) return
  const plot = ((id % count) + count) % count
  // その区画を受け持っていたほかの機体は、別の区画を選び直す
  for (const other of mowers) {
    if (other === rider || other.plot !== plot) continue
    other.plot = -1
    other.route.dirty = true
    other.route.follower = null
  }
  rider.plot = plot
  rider.route.dirty = true
  rider.route.follower = null
  refreshPlotOverlay()
  syncUi()
}

/** 機体が受け持つ区画を刈り終えたとき。続けて進む設定なら、まだ刈っていない空いた区画へ移る */
function finishPlot(unit: MowerUnit): void {
  if (unit.plot >= 0) {
    // 分担しているときは、組のほかの機体がまだ刈っていれば、区画はまだ刈り終えていない。自分は次の区画へ移る
    const others = teamOf(unit).filter((m) => m !== unit)
    if (others.length > 0) {
      unit.finishedPlot = unit.plot
      unit.plot = -1
    } else {
      plotting.done.add(unit.plot)
    }
  }
  unit.route.follower = null
  unit.route.dirty = true
  if (plotting.sequence) {
    assignPlot(unit)
    if (unit.plot >= 0 && !plotting.done.has(unit.plot)) {
      refreshPlotOverlay()
      syncUi()
      return
    }
  }
  unit.autoDrive = false
  refreshPlotOverlay()
  syncUi()
}

const params = FAIRWAY_MOWER

// 芝刈り機。出発点に、横に並べて置く。台数は「区画と経路」パネルで 1〜5 台に変えられる(既定は 3 台)。
// 起動時の指定 mowers=1〜5 でも変えられる
const MAX_MOWERS = 5
const DEFAULT_MOWERS = 3
const initialMowers = Math.min(Math.max(Math.round(Number(query.get('mowers')) || DEFAULT_MOWERS), 1), MAX_MOWERS)
/** 出発点に並べるときの、機体どうしの横の間隔(m) */
const MOWER_SPACING = 5
/** i 台目の出発点。出発点を中心に、進む向き(+Z)と直交する向き(X)に並べる */
function startPose(i: number): { x: number; z: number; heading: number } {
  return { x: START_X + (i - (mowers.length - 1) / 2) * MOWER_SPACING, z: START_Z, heading: 0 }
}
const mowers: MowerUnit[] = []
/** 乗っている機体。null なら誰にも乗っておらず、俯瞰で全体を見る */
let rider: MowerUnit | null = null

/**
 * 台数を変える。足りない分は作り、多い分は後ろの番号から消す。
 * 出発点の並びが変わるので、全台を出発点に並べ直す(自動運転は止め、受け持つ区画も決め直す)。刈った芝はそのまま
 */
function setMowerCount(count: number): void {
  const n = Math.min(Math.max(Math.round(count), 1), MAX_MOWERS)
  if (n === mowers.length) return
  while (mowers.length > n) {
    const unit = mowers.pop() as MowerUnit
    if (unit === rider) leaveMower()
    scene.remove(unit.model.root)
    unit.model.dispose()
  }
  while (mowers.length < n) {
    const unit = new MowerUnit(mowers.length, params, START_X, START_Z, 0)
    scene.add(unit.model.root)
    mowers.push(unit)
  }
  mowers.forEach((unit, i) => {
    const pose = startPose(i)
    unit.reset(pose.x, pose.z, pose.heading)
  })
  refreshPathLine()
  refreshPlotOverlay()
}
for (let i = 0; i < initialMowers; i++) {
  const unit = new MowerUnit(i, params, START_X, START_Z, 0)
  scene.add(unit.model.root)
  mowers.push(unit)
}
mowers.forEach((unit, i) => {
  const pose = startPose(i)
  unit.reset(pose.x, pose.z, pose.heading)
})

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
  timeScale: 1,
  cutHeightMm: 18,
  elapsed: 0
}
let accumulator = 0

// 自動運転の経路の設定(全台で共通)。経路そのものは機体ごとに持つ(MowerUnit.route)。
// 区分けや設定が変わったら、必要になった時点で作り直す
const route = {
  options: { angleDeg: 0, overlap: 0.2, headlandPasses: 3 },
  /** 刈り方(往復刈り、チェッカー)。起動時の指定 pattern=checker でも変えられる */
  pattern: (query.get('pattern') === 'checker' ? 'checker' : 'stripes') as MowPattern,
  show: query.get('path') === '1'
}
/** 経路の設定(機体ごとの経路を作る所では、route が機体の経路を指すので、こちらから読む) */
function routeOptions(): typeof route.options {
  return route.options
}
/** 刈り方(routeOptions と同じく、機体ごとの経路を作る所から読む) */
function routePattern(): MowPattern {
  return route.pattern
}
// 地面に描く経路の線。乗っている機体の経路を出す
const pathLine = new PathLine(terrain)
scene.add(pathLine.lines)

/** 経路の線を、乗っている機体の経路に描き直す */
function refreshPathLine(): void {
  pathLine.update(rider?.route.plan?.path ?? null)
}

const formatKm = (m: number): string => `${(m / 1000).toFixed(2)} km`

/**
 * 機体の今いる所を出発点として、受け持つ区画の経路を作る。
 * 分担して刈るときは、組の全員の経路を同じ時点の並びで作り直す(列の割り振りが食い違わないように)
 */
function updateRoute(unit: MowerUnit): void {
  if (zoning.dirty || !zoning.result || plotting.dirty || !plotting.result) updatePlots()
  assignPlot(unit)
  const team = teamOf(unit)
  const ids = team.map((m) => m.index)
  for (const member of team) {
    if (member !== unit && !member.route.dirty && ids.every((i) => member.route.team.includes(i))) continue
    planRoute(member, team)
  }
}

/** 組(team。分担しないときはその機体だけ)の中での受け持ちで、機体の経路を作る */
function planRoute(unit: MowerUnit, team: MowerUnit[]): void {
  const route = unit.route
  route.dirty = false
  route.team = team.map((m) => m.index)
  const plots = plotting.result as PlotResult
  const cell = terrain.options.cell
  const mask = new Uint8Array(plots.labels.length)
  for (let i = 0; i < mask.length; i++) mask[i] = plots.labels[i] === unit.plot ? 1 : 0
  const plan = planCoverage(
    {
      samples: terrain.samples,
      cell: terrain.options.cell,
      origin: terrain.origin,
      mask,
      // ほかの区画にいるときは、刈れる範囲の中を通って、この区画まで移動する
      transit: plotting.reach ?? undefined
    },
    {
      ...routeOptions(),
      pattern: routePattern(),
      cutWidth: params.cutWidth,
      turnRadius: minTurnRadius(params) * 1.15,
      deckOffset: params.deckOffset,
      runIn: 1,
      share: team.length > 1 ? { index: team.indexOf(unit), count: team.length } : undefined,
      // 刈り終えた列と周は飛ばす(途中から作り直しても、刈った所を刈り直さない)
      isCut: (x, z, bits) => coverage.isCovered(x, z, bits)
    },
    unit.state.x,
    unit.state.z,
    unit.state.heading
  )
  route.plan = plan
  route.follower = new PathFollower(plan.path, params)
  if (unit === rider) refreshPathLine()
  refreshPlotOverlay()
  // 旋回や外周では操舵に応じて減速するので、その分を大まかに見込む
  const seconds =
    plan.cutLength / (params.maxSpeed * 0.85) +
    plan.transitLength / (params.maxSpeed * DEFAULT_FOLLOWER.transitThrottle * 0.5)
  let cells = 0
  for (let i = 0; i < mask.length; i++) cells += mask[i]
  route.text = {
    plot: `${unit.plot + 1} / ${plots.plots.length}(済み ${plotting.done.size}${team.length > 1 ? `、${team.length} 台で分担` : ''})`,
    area: `${((cells * cell * cell) / 10000).toFixed(2)} ha`,
    lines: `${plan.sweepCount}`,
    cut: formatKm(plan.cutLength),
    transit: formatKm(plan.transitLength),
    time: formatTime(seconds)
  }
}

function resetAll(): void {
  mowers.forEach((unit, i) => {
    const pose = startPose(i)
    unit.reset(pose.x, pose.z, pose.heading)
  })
  sim.elapsed = 0
  timeSettings.hour = queryHour > 0 ? queryHour : START_HOUR
  // 区画は最初の状態に戻す(刈り終えた印を消す)
  plotting.dirty = true
  refreshPathLine()
  accumulator = 0
  coverage.reset()
  clippings.clear()
  mowMap.reset(UNCUT_HEIGHT)
}

// 起動時の指定(動作確認用): ?auto=1&timescale=16&cam=orbit&ui=0&help=1&seed=7&zones=1&path=1&mowers=3&ride=1
// 最初は誰にも乗らず、出発点のあたりを俯瞰で見る
rig.setFreeFocus(START_X, START_Z)
rig.setMode('top')
if (query.get('auto') === '1') for (const unit of mowers) unit.autoDrive = true
const queryScale = Number(query.get('timescale'))
if (queryScale > 0) sim.timeScale = queryScale
const queryCam = query.get('cam') as CameraMode | null
// ride=N で N 号機に乗った状態で始める。俯瞰以外の視点を指定したときは、指定がなければ 1 号機に乗る
const queryRide = Math.round(Number(query.get('ride')))
if (queryRide >= 1 && queryRide <= mowers.length) rider = mowers[queryRide - 1]
else if (queryCam && queryCam !== 'top' && CAMERA_MODES.includes(queryCam)) rider = mowers[0]
if (queryCam && CAMERA_MODES.includes(queryCam) && (rider || queryCam === 'top')) rig.setMode(queryCam)
else if (rider) rig.setMode('chase')
// 定点の視点の、自動の旋回の段(動作確認用)
const queryOrbit = Number(query.get('orbit'))
if (queryOrbit) rig.stepOrbit(queryOrbit)
// 追従視点の向き(動作確認用)。「回り込む角度,見上げ下げの角度」を度で書く。例: chase=0,-18 で地平線を見る
const queryChase = query.get('chase')?.split(',').map(Number)
if (queryChase && queryChase.length === 2) rig.setChaseAngles(queryChase[0], queryChase[1])
const queryZoom = Number(query.get('zoom'))
if (queryZoom > 0) rig.setZoom(queryZoom)
if (query.get('ui') === '0') document.body.classList.add('minimal-ui')
// 被写界深度を切って始める(動作確認用)
if (query.get('dof') === '0') rig.settings.depthOfField = false
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
  mower: '機体',
  speed: '速度',
  deck: '刈刃',
  area: '刈った面積',
  slope: '勾配',
  altitude: '標高',
  distance: '走行距離',
  elapsed: '経過時間',
  clock: '時刻'
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
    // 視点ごとに初期値が違う(視点を切り替えると初期値に戻るので、保存しない)
    defaultValue: () => Math.log(rig.defaultFocalLength / FOCAL_MIN) / focalRange,
    persist: false
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

// 時間のパネル
const timeFields = byId('time-fields')
const daylight = daylightHours()
syncs.push(
  addCheck(
    timeFields,
    'タイムラプス',
    '一定の間隔で撮った写真をつなげたような見え方にします。時間をまとめて進め、機体や影が 1 コマごとに飛びます。視点はなめらかに動きます。倍速が低いときは 32 倍に上げます(T)',
    () => timeSettings.timelapse,
    setTimelapse,
    undefined,
    // その場の状態なので保存しない(T キーでも切り替える)
    false
  ),
  addSlider(timeFields, {
    label: 'コマ数',
    title: 'タイムラプスで、1 秒あたりに時間を進める回数。少ないほど動きが飛びます',
    min: 4,
    max: 60,
    step: 1,
    get: () => timeSettings.fps,
    set: (v) => {
      timeSettings.fps = v
    },
    format: (v) => `毎秒 ${v.toFixed(0)}`
  }),
  addSlider(timeFields, {
    label: '時刻',
    title: '時刻は倍速に合わせて進み、日が沈むと次の朝へ飛びます。動かすと、太陽がその時刻の位置に来ます',
    min: Math.ceil(daylight.start * 12) / 12,
    max: Math.floor(daylight.end * 12) / 12,
    step: 1 / 12,
    get: () => timeSettings.hour,
    set: (v) => {
      timeSettings.hour = v
      timeSettings.sunFollowsClock = true
    },
    format: formatHour,
    // 時刻は進んでいくので保存しない(起動するといつも朝から)
    persist: false
  }),
  addCheck(
    timeFields,
    '時刻で太陽を動かす',
    '時刻に合わせて太陽が動き、影が伸び縮みします。太陽の高度や方位を手で変えるとオフになります',
    () => timeSettings.sunFollowsClock,
    (v) => {
      timeSettings.sunFollowsClock = v
    }
  )
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
      timeSettings.sunFollowsClock = false
      sunGizmo.touch()
    },
    format: (v) => `${v.toFixed(0)}°`,
    // 「時刻で太陽を動かす」がオンなら時刻から決まるので、オフのときだけ戻す
    persist: () => !timeSettings.sunFollowsClock
  }),
  addSlider(lightFields, {
    label: '太陽の方位',
    min: 0,
    max: 360,
    step: 1,
    get: () => lighting.settings.sunAzimuth,
    set: (v) => {
      lighting.settings.sunAzimuth = v
      timeSettings.sunFollowsClock = false
      sunGizmo.touch()
    },
    format: (v) => `${v.toFixed(0)}°`,
    // 「時刻で太陽を動かす」がオンなら時刻から決まるので、オフのときだけ戻す
    persist: () => !timeSettings.sunFollowsClock
  }),
  addSlider(lightFields, {
    label: '雲',
    title: '雲の量。雲は風で流れ、地面に影を落とします。0 で快晴',
    min: 0,
    max: 1,
    step: 0.05,
    get: () => lighting.settings.cloudCover,
    set: (v) => {
      lighting.settings.cloudCover = v
    },
    format: (v) => `${(v * 100).toFixed(0)}%`
  }),
  addSlider(lightFields, {
    label: '霞',
    title: '空気の中の霞の濃さ。大きいほど空が白っぽく、遠くが霞み、朝夕の太陽が弱く赤くなります',
    min: 0.5,
    max: 12,
    step: 0.5,
    get: () => lighting.settings.haze,
    set: (v) => {
      lighting.settings.haze = v
    },
    format: (v) => v.toFixed(1)
  }),
  addSlider(lightFields, {
    label: 'スカイライト',
    title:
      'スカイライト強度。空からの光(影の中や太陽の当たらない面を照らす光と、雲が受ける空の光)の倍率です。1 が大気の計算どおり。上げると影が明るく青みがかり、下げると影が暗く締まります',
    min: 0,
    max: 8,
    step: 0.1,
    get: () => lighting.settings.skylightIntensity,
    set: (v) => {
      lighting.settings.skylightIntensity = v
    },
    format: (v) => v.toFixed(1)
  })
)

syncs.push(
  addSlider(lightFields, {
    label: '風',
    title: '木の枝と葉を揺らし、雲を流す風の強さ。0 で止まります',
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
  addCheck(
    grassFields,
    '法線マップを表示',
    '動作確認用。刈った地面の法線マップを、機体のまわりを真上から見た画像として左上に出します。画像の右が赤、上が緑、地面に垂直な向きが青で、平らな所は青紫に見えます',
    () => debugSettings.normals,
    (v) => {
      debugSettings.normals = v
      normalPanel.hidden = !v
    },
    undefined,
    // 動作確認用なので保存しない
    false
  ),
  addSlider(grassFields, {
    label: '法線の強調',
    title: '法線マップの傾きを何倍に強調して見せるか。刈った芝の傾きは小さく、1 倍では淡い色になります',
    min: 1,
    max: 10,
    step: 1,
    get: () => normalPreview.gain,
    set: (v) => {
      normalPreview.gain = v
    },
    format: (v) => `${v.toFixed(0)} 倍`
  }),
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
  addPanelToggle(byId('zone-panel'), '区分け', 'Z', () => zoning.show, setZoneShow),

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

const setRouteReadout = addReadout(byId('route-readout'), {
  plot: '刈る区画',
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
      markRoutesDirty()
    },
    format
  })
function setRouteShow(on: boolean): void {
  route.show = on
  syncUi()
}
syncs.push(
  addPanelToggle(byId('route-panel'), '区画と経路', 'G', () => route.show, setRouteShow),

  () => {
    pathLine.visible = route.show
    plotOverlay.visible = route.show
  },
  addSlider(routeFields, {
    label: '台数',
    title: '芝刈り機の台数。変えると全台を出発点に並べ直します(自動運転は止まります。刈った芝はそのまま)',
    min: 1,
    max: MAX_MOWERS,
    step: 1,
    defaultValue: () => DEFAULT_MOWERS,
    get: () => mowers.length,
    set: (v) => {
      setMowerCount(v)
      syncUi()
    },
    format: (v) => `${v.toFixed(0)} 台`
  }),
  addSelect(
    routeFields,
    '刈り方',
    '往復刈りは、まっすぐな列を行き来して縞の模様にします。チェッカーは、往復刈りのあと 90° 回した向きでもう一度刈り、市松の模様にします。どちらも最後に外周を回ります',
    [
      { value: 'stripes', label: '往復刈り(縞)' },
      { value: 'checker', label: 'チェッカー(市松)' }
    ],
    () => route.pattern,
    (v) => {
      route.pattern = v
      markRoutesDirty()
    }
  ),
  addSlider(routeFields, {
    label: '区画の広さ',
    title: '区画 1 つの広さの目安。刈れる範囲を、標高や斜面の向きが似た所どうしで、この広さの区画に分けます',
    min: 2000,
    max: 50000,
    step: 1000,
    get: () => plotting.options.targetArea,
    set: (v) => {
      plotting.options.targetArea = v
      plotting.dirty = true
      markRoutesDirty(true)
    },
    format: (v) => `${(v / 10000).toFixed(1)} ha`
  }),
  addCheck(
    routeFields,
    '順に刈り進める',
    '区画を 1 つ刈り終えたら、続けて次の区画へ進みます。オフにすると、1 つ刈り終えた所で止まります',
    () => plotting.sequence,
    (v) => {
      plotting.sequence = v
    }
  ),
  addCheck(
    routeFields,
    '分担して刈る',
    '自動運転の機体が、同じ区画の往復の列を分け合って刈ります(外周の周回も順番に分けます)。オフにすると、機体ごとに別々の区画を刈ります',
    () => plotting.teamwork,
    (v) => {
      plotting.teamwork = v
      // 受け持ちを決め直す(走っている経路は、今いる所から作り直す)
      for (const unit of mowers) {
        unit.plot = -1
        unit.finishedPlot = -1
      }
      markRoutesDirty(true)
      refreshPlotOverlay()
    }
  ),
  routeSlider('刈る向き', '往復刈りの列の向き。0° で画面の奥行き方向', 'angleDeg', 0, 175, 5, (v) => `${v.toFixed(0)}°`),
  routeSlider('重ねる幅', '隣の列と重ねる幅。刈り残しを防ぐ', 'overlap', 0, 1, 0.05, (v) => `${(v * 100).toFixed(0)} cm`),
  routeSlider('外周の周回', '最後に境界沿いを回る回数。旋回の場所にもなる', 'headlandPasses', 0, 5, 1, (v) => `${v.toFixed(0)} 周`)
)

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
    (mode) => setView(mode)
  )
)

/**
 * 視点を切り替える。誰にも乗っていないときに俯瞰以外を選んだら、
 * 見ている場所にいちばん近い機体に乗る(追従やドローンは、追う機体が要るため)
 */
function setView(mode: CameraMode): void {
  if (!rider && mode !== 'top') boardMower(nearestMower(rig.focusPoint.x, rig.focusPoint.z), mode)
  else rig.setMode(mode)
  syncUi()
}

/** その地点にいちばん近い機体 */
function nearestMower(x: number, z: number): MowerUnit {
  let best = mowers[0]
  let bestDistance = Infinity
  for (const unit of mowers) {
    const d = Math.hypot(unit.state.x - x, unit.state.z - z)
    if (d < bestDistance) {
      bestDistance = d
      best = unit
    }
  }
  return best
}

/**
 * 機体に乗る(ほかの機体に乗っていたら、乗り移る)。誰にも乗っていなかったときは、mode の視点(既定は追従)にする。
 * 乗り移るときは、今の視点のまま
 */
function boardMower(unit: MowerUnit, mode: CameraMode = 'chase'): void {
  const wasFree = rider === null
  rider = unit
  // カメラが追う位置を、今の機体の位置から始める(タイムラプスで、前の機体の位置から滑ってこないように)
  Object.assign(unit.cameraTarget, unit.state)
  if (wasFree) rig.setMode(mode)
  refreshPathLine()
  refreshPlotOverlay()
  syncUi()
}

/** 機体から降りて、その機体のあたりを俯瞰で見る。降りた機体は、自動運転ならそのまま刈り続ける */
function leaveMower(): void {
  if (!rider) return
  rig.setFreeFocus(rider.state.x, rider.state.z)
  rider = null
  rig.setMode('top')
  refreshPathLine()
  refreshPlotOverlay()
  syncUi()
}

/** 次の機体に乗り移る(誰にも乗っていなければ 1 号機に乗る) */
function boardNextMower(step: number): void {
  const index = rider ? (rider.index + step + mowers.length) % mowers.length : 0
  boardMower(mowers[index])
}

const autoButton = byId<HTMLButtonElement>('toggle-auto')
/** 自動運転の対象。乗っている機体、誰にも乗っていなければ全台 */
function autoTargets(): MowerUnit[] {
  return rider ? [rider] : mowers
}
/** 自動運転の対象が、すべて自動運転中か */
function autoDriving(): boolean {
  return autoTargets().every((unit) => unit.autoDrive)
}
function setAutoDrive(on: boolean): void {
  for (const unit of autoTargets()) {
    unit.autoDrive = on
    // まだ走り出していない経路は、今いる所から作り直す
    if (on && (!unit.route.follower || unit.route.follower.segment === 0)) unit.route.dirty = true
  }
  syncUi()
}
syncs.push(() => {
  const on = autoDriving()
  autoButton.setAttribute('aria-pressed', String(on))
  const whom = rider ? rider.name : '全台'
  const label = on ? `自動運転を止める(${whom})` : `自動運転(${whom})`
  autoButton.setAttribute('aria-label', label)
  autoButton.title = `${label}(P)`
})
autoButton.addEventListener('click', () => {
  setAutoDrive(!autoDriving())
  autoButton.blur()
})
const resetButton = byId<HTMLButtonElement>('reset')
resetButton.addEventListener('click', () => {
  resetAll()
  resetButton.blur()
})

const toggleHelp = setupHelp([
  {
    title: '機体',
    items: [
      { keys: ['クリック'], text: '芝刈り機に乗る。乗っている間にほかの機体をクリックすると、乗り移る' },
      { keys: ['Tab'], text: '次の機体に乗り移る' },
      { keys: ['Esc'], text: '降りて、俯瞰で全体を見る(降りた機体は、自動運転ならそのまま刈り続ける)' },
      { keys: ['左ドラッグ'], text: '誰にも乗っていないとき、見ている所を中心に回り込む(見下ろす角度も変わる)' },
      { keys: ['右ドラッグ'], text: '誰にも乗っていないとき、見る場所を地面に沿って動かす' },
      { keys: ['W', 'A', 'S', 'D'], text: '誰にも乗っていないとき、見る場所を動かす(カメラの向きに合わせる。矢印キーも使える)' },
      { keys: ['ホイール'], text: '誰にも乗っていないとき、寄る、引く' }
    ]
  },
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
      { keys: ['W', 'A', 'S', 'D'], text: '定点の視点で、カメラを回す(A / D で左右、W / S で傾き)。運転は矢印キー' },
      { keys: ['Q', 'E'], text: '定点の視点で、自動の旋回。押すたびに速さが 1 段変わる(E が右回り、5 段まで)' },
      { keys: ['左ドラッグ'], text: '機体を中心に回り込む(追従視点では、離して 2 秒で背後に戻る)' },
      { keys: ['ホイール'], text: 'カメラを近づける、離す(画角は変わらない)' }
    ]
  },
  {
    title: 'シミュレーション',
    items: [
      { keys: ['1', '〜', '9'], text: '倍速(1、2、4、8、16、32、64、128、256 倍)' },
      { keys: ['T'], text: 'タイムラプス(コマ落ちした早送り)の入り切り' },
      { keys: ['P'], text: '自動運転の開始と停止(乗っている機体。誰にも乗っていなければ全台)' },
      { keys: ['G'], text: '区画と経路の表示と非表示' },
      { keys: ['[', ']'], text: '乗っている機体の刈る区画を、前、次に切り替える' },
      { keys: ['クリック'], text: '区画を表示しているとき、乗っている機体の刈る区画に選ぶ' },
      { keys: ['R'], text: 'やり直し(芝を元に戻す)' },
      { keys: ['Z'], text: '勾配による区分けの表示と非表示' }
    ]
  },
  {
    title: 'その他',
    items: [
      { keys: ['L', '+', '左ドラッグ'], text: '太陽の向きを変える(左右で方位、上下で高度)' },
      { keys: ['F12'], text: 'スクリーンショット(画面の画素のまま)' },
      { keys: ['Shift', '+', 'F12'], text: 'スクリーンショット(表示倍率 100% の大きさ)' },
      { keys: ['Ctrl', '+', 'F12'], text: '録画を始める、止める' },
      { keys: ['F11'], text: '動画用サイズ(1920×1080)に切り替える、戻す' },
      { keys: [','], text: '設定ウインドウを開く、閉じる' },
      { keys: ['?'], text: 'この一覧を開く、閉じる' }
    ]
  }
])
if (query.get('help') === '1') toggleHelp()

const input = new KeyboardInput(window)
input.onPress('Space', () => {
  if (rider && !rider.autoDrive) rider.state.deckDown = !rider.state.deckDown
})
input.onPress('KeyC', () => {
  setView(CAMERA_MODES[(CAMERA_MODES.indexOf(rig.mode) + 1) % CAMERA_MODES.length])
})
input.onPress('KeyP', () => setAutoDrive(!autoDriving()))
input.onPress('KeyR', resetAll)
input.onPress('KeyG', () => setRouteShow(!route.show))
input.onPress('KeyZ', () => setZoneShow(!zoning.show))
input.onPress('KeyT', () => setTimelapse(!timeSettings.timelapse))
input.onPress('BracketLeft', () => {
  if (rider) selectPlot(rider.plot - 1)
})
input.onPress('BracketRight', () => {
  if (rider) selectPlot(rider.plot + 1)
})
// ダイアログ(操作の一覧、設定)が開いているときは、Tab と Esc をダイアログに任せる(フォーカスの移動、閉じる)
const dialogOpen = (): boolean => document.querySelector('dialog[open]') !== null
input.onPress('Tab', () => {
  if (dialogOpen()) return false
  boardNextMower(1)
})
input.onPress('Escape', () => {
  if (dialogOpen()) return false
  leaveMower()
})

/** 画面の上の点(クライアント座標)の近くに写っている機体。なければ null */
function mowerAtScreen(clientX: number, clientY: number): MowerUnit | null {
  const rect = canvas.getBoundingClientRect()
  const point = new Vector3()
  let best: MowerUnit | null = null
  let bestDistance = Infinity
  for (const unit of mowers) {
    const { x, z } = unit.state
    point.set(x, terrain.heightAt(x, z) + 1, z).project(rig.camera)
    if (point.z > 1) continue
    const sx = rect.left + ((point.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - point.y) / 2) * rect.height
    // 機体の大きさ(約 3 m)が画面で何画素になるかを見て、それより少し広い範囲を当たりにする
    const distance = rig.camera.position.distanceTo(point.set(x, terrain.heightAt(x, z) + 1, z))
    const pixels = (3 / (2 * distance * Math.tan((rig.camera.fov * Math.PI) / 360))) * rect.height
    const d = Math.hypot(clientX - sx, clientY - sy)
    if (d < Math.max(28, pixels * 0.8) && d < bestDistance) {
      bestDistance = d
      best = unit
    }
  }
  return best
}

// クリック: 芝刈り機の上なら、その機体に乗る(乗り移る)。
// 区画を表示している間は、地面をクリックして、乗っている機体の刈る区画を選べる(ドラッグは視点の操作なので除く)
{
  let downX = 0
  let downY = 0
  canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX
    downY = e.clientY
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || input.isDown('KeyL')) return
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return
    const picked = mowerAtScreen(e.clientX, e.clientY)
    if (picked) {
      if (picked !== rider) boardMower(picked)
      return
    }
    if (!route.show || !rider) return
    // 視線を少しずつ進め、地面に当たった所の区画を選ぶ
    const rect = canvas.getBoundingClientRect()
    const ray = new Vector3(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2,
      0.5
    )
      .unproject(rig.camera)
      .sub(rig.camera.position)
      .normalize()
    const point = rig.camera.position.clone()
    for (let travelled = 0; travelled < 3000; travelled += 1) {
      point.add(ray)
      if (point.y > terrain.heightAt(point.x, point.z)) continue
      const id = plotAt(point.x, point.z)
      if (id >= 0 && id !== rider.plot) selectPlot(id)
      return
    }
  })
}
// 定点の視点: Q / E を 1 回押すごとに、自動の旋回の段を変える(E が右回り)
input.onPress('KeyE', () => rig.stepOrbit(1))
input.onPress('KeyQ', () => rig.stepOrbit(-1))

// 上中央の案内。定点の視点では、その視点の操作と、自動の旋回の様子を出す
const viewHint = byId('view-hint')
const viewHintText = viewHint.textContent ?? ''
function updateViewHint(): void {
  let text = viewHintText
  if (!rider) {
    text = '俯瞰: 芝刈り機をクリックで乗る。左ドラッグで回る、右ドラッグか W / A / S / D で動かす、ホイールで寄る、P で全台の自動運転'
  } else if (rig.mode === 'fixed') {
    const level = rig.orbitLevel
    text =
      level === 0
        ? '定点の視点: W / A / S / D でカメラを回す、Q / E で自動の旋回、矢印キーで運転'
        : `旋回中 ${level > 0 ? '右回り' : '左回り'} 速さ ${Math.abs(level)} / ${ORBIT_LEVELS}(Q / E で速さと向き、W / A / S / D で回転と傾き)`
  } else {
    text = `${rider.name}: W / S で前後、A / D で操舵、Space で刈刃、C で視点、Tab で乗り移る、Esc で降りる、? で操作の一覧`
  }
  if (viewHint.textContent !== text) viewHint.textContent = text
}

// 太陽の向きのギズモ。太陽を手で動かしている間だけ出す
const sunGizmo = new SunGizmo(
  document.getElementById('sun-gizmo') as unknown as SVGSVGElement,
  byId('sun-gizmo-label')
)
// 動作確認用: ?gizmo=1 で、ギズモを出したままにする
if (query.get('gizmo') === '1') sunGizmo.held = true

// L を押しながら左ドラッグ: 太陽の向きを変える。左右で方位、上下で高度。
// 空をつかんで回す向きにしてある(右へ引くと、正面の太陽は右へ、手前に落ちる影も右へ動く)。
// 視点のドラッグより先に受け取り、視点は動かさない
{
  const DEG_PER_PIXEL = 0.25
  let sunPointer: number | null = null
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !input.isDown('KeyL')) return
      e.stopImmediatePropagation()
      e.preventDefault()
      sunPointer = e.pointerId
      sunGizmo.held = true
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
    },
    { capture: true }
  )
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerId !== sunPointer) return
      e.stopImmediatePropagation()
      const s = lighting.settings
      timeSettings.sunFollowsClock = false
      s.sunAzimuth = (((s.sunAzimuth - e.movementX * DEG_PER_PIXEL) % 360) + 360) % 360
      s.sunElevation = Math.min(Math.max(s.sunElevation - e.movementY * DEG_PER_PIXEL, 3), 85)
      syncUi()
    },
    { capture: true }
  )
  const endSunDrag = (e: PointerEvent): void => {
    if (e.pointerId !== sunPointer) return
    e.stopImmediatePropagation()
    sunPointer = null
    sunGizmo.held = false
    canvas.style.cursor = ''
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }
  canvas.addEventListener('pointerup', endSunDrag, { capture: true })
  canvas.addEventListener('pointercancel', endSunDrag, { capture: true })
}
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
    },
    {
      title: '録画',
      items: [
        {
          type: 'choice',
          key: 'recordingFps',
          label: '録画のコマ数',
          title:
            'Ctrl+F12 で録画するときの毎秒のコマ数。60 はなめらかですが、描画と書き出しが重なって重くなり、追いつかないとコマが落ちます。F11 で、ウィンドウを録画用の 1920×1080(表示倍率 100% と同じ構図)に切り替え、もう一度押すと戻ります(録画中は切り替えられません)',
          options: [
            { value: 30, label: '30' },
            { value: 60, label: '60' }
          ]
        },
        {
          type: 'check',
          key: 'recordingCursor',
          label: 'マウスポインタを写す',
          title: 'Ctrl+F12 で録画するとき、マウスポインタも動画に写します。既定は外してあり、画面の上では見えたまま、動画には写りません'
        }
      ]
    }
  ],
  applySetting
)
for (const key of Object.keys(settings) as (keyof AppSettings)[]) applySetting(key)
input.onPress('Comma', toggleSettings)

// スクリーンショット(F12、Shift+F12)と録画(Ctrl+F12)の保存の通知。キーはメインプロセスが受け取る
const SAVED_TOAST_MS = 6000
const showSavedToast = ((): ((kind: 'screenshot' | 'recording', filePath: string | null) => void) => {
  const toast = byId('screenshot-toast')
  const open = byId<HTMLButtonElement>('screenshot-toast-open')
  const dialog = byId<HTMLDialogElement>('settings')
  let savedPath: string | null = null
  let timer = 0
  const hide = (): void => {
    window.clearTimeout(timer)
    toast.hidden = true
  }
  const name = { screenshot: 'スクリーンショット', recording: '録画' }
  open.addEventListener('click', () => {
    if (savedPath) void window.lawnApi?.revealScreenshot(savedPath)
    hide()
    open.blur()
  })
  byId('screenshot-toast-close').addEventListener('click', hide)
  dialog.addEventListener('close', () => document.body.append(toast))
  return (kind, filePath) => {
    savedPath = filePath
    byId('screenshot-toast-title').textContent = `${name[kind]}を${filePath ? '保存しました' : '保存できませんでした'}`
    byId('screenshot-toast-file').textContent = filePath ? (filePath.split(/[\\/]/).pop() ?? '') : ''
    byId('screenshot-toast-hint').textContent = filePath ? 'クリックで保存先を開く' : ''
    open.disabled = !filePath
    // 設定ウインドウを開いている間は、その外の要素がクリックを受けないので中へ移す
    ;(dialog.open ? dialog : document.body).append(toast)
    toast.hidden = false
    window.clearTimeout(timer)
    timer = window.setTimeout(hide, SAVED_TOAST_MS)
  }
})()
window.lawnApi?.onScreenshot((filePath) => showSavedToast('screenshot', filePath))
initScreenRecorder({
  fps: () => settings.recordingFps,
  // 起動時の指定 reccursor=0 でも写さない(動作確認用)
  cursor: () => settings.recordingCursor && query.get('reccursor') !== '0',
  onSaved: (filePath) => showSavedToast('recording', filePath)
})
if (query.get('settings') === '1') toggleSettings()
input.onPress('Slash', toggleHelp)
TIME_SCALES.forEach((scale, i) => {
  input.onPress(`Digit${i + 1}`, () => {
    sim.timeScale = scale
    syncUi()
  })
})
// 右の列のパネルの値を、前回の値に戻す(次の起動のために保存もする)。
// 起動時の指定(動作確認用)があるときは、その値で確かめられるよう、戻しも保存もしない(マップの指定だけは例外)
if ([...query.keys()].every((key) => key === 'map')) restorePanelValues()
syncUi()

// ------------------------------------------------ シミュレーション

function stepSimulation(): void {
  // 手で運転するのは、乗っている機体だけ。定点の視点では、W / A / S / D はカメラを回すのに使い、運転は矢印キーで行う
  const manual = rider && !rider.autoDrive ? input.read(rig.mode !== 'fixed') : IDLE_INPUT
  const ctx: StepContext = {
    terrain,
    mowMap,
    coverage,
    cutHeight: sim.cutHeightMm / 1000,
    maxGrassHeight: MAX_GRASS_HEIGHT,
    dt: SIM_DT,
    sweepAngle: (route.options.angleDeg * Math.PI) / 180,
    crossCut: route.pattern === 'checker',
    onCut: (unit, newCells, deck) => {
      // まだ刈っていない所を通った分だけ、刈りカスが出る。長い芝ほど多い
      const length = grassField.lengthFactorAt((deck.lx + deck.rx) / 2, (deck.lz + deck.rz) / 2)
      emitClippings(unit, newCells * coverage.cellSize * coverage.cellSize * length, deck)
    }
  }
  for (const unit of mowers) {
    unit.step(unit === rider ? manual : IDLE_INPUT, ctx, () => finishPlot(unit))
  }
  sim.elapsed += SIM_DT
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
  // 機体ごとの値は、乗っている機体のもの。刈った面積は全台の合計
  const unit = rider
  const driving = mowers.filter((m) => m.autoDrive).length
  setStatus({
    mower: unit ? `${unit.name}${unit.autoDrive ? '(自動)' : ''}` : `なし(自動 ${driving} / ${mowers.length} 台)`,
    speed: unit ? `${(unit.state.speed * 3.6).toFixed(1)} km/h` : '-',
    deck: unit ? (unit.state.deckDown ? '下げ' : '上げ') : '-',
    area: `${coverage.coveredArea.toFixed(0)} m²`,
    slope: unit ? `${((terrain.slopeAt(unit.state.x, unit.state.z, 2) * 180) / Math.PI).toFixed(0)}°` : '-',
    altitude: unit ? `${terrain.heightAt(unit.state.x, unit.state.z).toFixed(1)} m` : '-',
    distance: `${(unit ? unit.distance : mowers.reduce((sum, m) => sum + m.distance, 0)).toFixed(0)} m`,
    elapsed: formatTime(sim.elapsed),
    clock: formatHour(timeSettings.hour)
  })
  setCameraReadout({
    lens: `${s.focalLength.toFixed(0)} mm  F${s.fNumber}`,
    focus: `${focusDistance.toFixed(1)} m`,
    exposure: `1/${Math.round(1 / s.shutterTime)} 秒  ISO ${s.iso}  EV ${ev100(s.fNumber, s.shutterTime, s.iso).toFixed(1)}`
  })
  // 経路は、乗っている機体のもの
  const shown = unit?.route
  setRouteReadout({
    ...(shown ? shown.text : { plot: '-', area: '-', lines: '-', cut: '-', transit: '-', time: '-' }),
    progress: shown?.follower ? `${(shown.follower.progress * 100).toFixed(1)}%` : '-'
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
let windTime = 0
// タイムラプスで、次のコマまでにためておく時間
let shotTimer = 0
let shotPending = 0
const viewDirection = new Vector3()
const scratch = new Vector3()
/**
 * 刈った量に応じて、刈刃から刈りカスを飛ばす。シミュレーションの刻みごとに呼ぶ。
 * 描画のたびにまとめて飛ばすと、倍速が高いときやタイムラプスでは、1 回の描画の間に進んだ道のりの
 * 終わりにだけ粒が固まる。刻みごとにその時の刈刃の位置から飛ばし、刈り跡に沿って均等に並べる。
 */
function emitClippings(
  unit: MowerUnit,
  volume: number,
  deck: { lx: number; lz: number; rx: number; rz: number }
): void {
  if (!settings.clippings) return
  // 倍速が高いときは粒を間引く(見た目の量をおおよそ保ち、重くしない)
  const wanted = (volume * CLIPPINGS_PER_VOLUME) / Math.sqrt(sim.timeScale)
  clippingDemand += wanted
  clippingDebt += wanted * clippingKeep
  const count = Math.floor(clippingDebt)
  if (count === 0) return
  clippingDebt -= count
  const state = unit.state
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

  if (timeSettings.timelapse) {
    // タイムラプス: 画面は毎回描くが、時間は 1 コマぶんためてからまとめて進める。
    // 機体、太陽、雲はコマごとに飛び、その間は止まって見える
    shotTimer += dt
    shotPending += dt * sim.timeScale
    const interval = 1 / timeSettings.fps
    if (shotTimer >= interval) {
      shotTimer %= interval
      accumulator += shotPending
      shotPending = 0
    }
  } else {
    accumulator += dt * sim.timeScale + shotPending
    shotTimer = 0
    shotPending = 0
  }
  let steps = 0
  while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
    stepSimulation()
    accumulator -= SIM_DT
    steps++
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
  // 時刻と雲は、シミュレーションの時間で進める(倍速を上げると、太陽と雲の影も速く動く)
  const simSeconds = steps * SIM_DT
  timeSettings.hour = advanceHour(timeSettings.hour, simSeconds)
  lighting.advanceClouds(simSeconds, windSettings.strength)
  if (timeSettings.sunFollowsClock) {
    const sun = sunAngles(timeSettings.hour)
    lighting.settings.sunElevation = sun.elevation
    lighting.settings.sunAzimuth = sun.azimuth
  }
  mowMap.flush()
  // 粒が多すぎるときは、次の描画から均等に間引く
  clippingTime += dt
  if (steps > 0) {
    clippingKeep = Math.min(1, (CLIPPINGS_PER_SECOND * clippingTime) / Math.max(clippingDemand, 1e-6))
    clippingDemand = 0
    clippingTime = 0
  }
  // 粒は、倍速を上げても速くなりすぎないように進める
  // タイムラプスでは、粒もコマごとに進める
  if (!timeSettings.timelapse) clippings.update(dt * Math.min(sim.timeScale, 3))
  else if (steps > 0) clippings.update(Math.min(simSeconds, 3 / timeSettings.fps))
  if (zoning.dirty) updateZoning()
  // 経路は、自動運転の機体と、区画と経路を表示しているときの乗っている機体の分を作る。重いので 1 フレームに 1 台まで
  checkTeams()
  const needsRoute = mowers.find((m) => m.route.dirty && (m.autoDrive || (route.show && m === rider)))
  if (needsRoute) updateRoute(needsRoute)
  else if (plotting.dirty && route.show) updatePlots()

  for (const unit of mowers) {
    unit.model.sync(unit.state, simSeconds, terrain)
    unit.followCamera(dt, timeSettings.timelapse)
  }
  // 定点の視点では W / A / S / D でカメラを回す。誰にも乗っていない俯瞰では、W / A / S / D と矢印キーで見る場所を動かす
  if (rider && rig.mode === 'fixed') rig.setArmInput(input.axis(['KeyD'], ['KeyA']), input.axis(['KeyW'], ['KeyS']))
  else rig.setArmInput(0, 0)
  if (!rider) {
    rig.setPanInput(input.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']), input.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']))
  } else {
    rig.setPanInput(0, 0)
  }
  rig.update(rider ? rider.cameraTarget : null, dt, terrain)
  updateViewHint()
  const exposure = rig.exposure
  // タイムラプスでは木の揺れもコマごとに進める(1 コマごとに枝葉の形が変わり、ちらちらして見える)
  windTime = (windTime + (timeSettings.timelapse ? simSeconds : dt)) % 4096
  treeModels.update(windTime, windSettings.strength)
  // 後から読み込んだモデルの材質も、影の仕組みに対応させる
  if (frameCount++ % 30 === 0) lighting.prepareMaterials(scene)
  pathLine.tick(dt)
  plotOverlay.tick(dt)
  zoneOverlay.tick(dt)
  const riding = rider?.route.follower
  pathLine.done = rider && riding && (rider.autoDrive || riding.segment > 0) ? riding.progress : 0
  grassBlades.update(rig.camera, bladeSettings.show)
  // 法線マップは、読み出しで描画が少し止まるので、0.2 秒ごとに描き直す。誰にも乗っていないときは、見ている所を中心にする
  if (debugSettings.normals && (normalTimer -= dt) <= 0) {
    normalTimer = 0.2
    const view = rig.camera.getWorldDirection(scratch)
    const at = rider ? rider.state : { x: rig.focusPoint.x, z: rig.focusPoint.z, heading: 0 }
    normalPreview.update(renderer, at.x, at.z, at.heading, view.x, view.z)
  }
  lighting.update(renderer, exposure, rig.camera.position)
  // ギズモは、見ている所(機体のあたり)を中心に、カメラからの距離に比例した大きさで出す
  sunGizmo.update(
    dt,
    rig.camera,
    rig.focusPoint,
    // 画面の高さの半分強に収まる大きさ(画角が狭い視点では、その分だけ小さくする)
    rig.camera.position.distanceTo(rig.focusPoint) * Math.tan((rig.camera.fov * Math.PI) / 360) * 0.55,
    lighting.settings.sunAzimuth,
    lighting.settings.sunElevation
  )

  // ピントは機体に合わせる(定点の視点では、画面の中央に見えている地面)。視線に沿った距離で持つ
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
    // タイムラプスでは、雲の影が通るたびに明るさがちらつかないよう、ゆっくり追わせる
    const rate = timeSettings.timelapse ? 0.7 : 3
    const next = current + (target - current) * (1 - Math.exp(-dt * rate))
    s.shutterTime = Math.min(Math.max(shutterTimeForEv100(next, s.fNumber, s.iso), 1 / 32000), 0.5)
  }
  // 自動で変わる値(露出、時刻、太陽の向き)を、ときどきパネルに映す
  autoSyncTimer += dt
  if (autoSyncTimer > 0.5) {
    autoSyncTimer = 0
    syncUi()
  }
  updateReadouts(dt)
}
requestAnimationFrame(frame)
