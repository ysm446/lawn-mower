# 乗用フェアウェイモアのモデルを作って glTF (.glb) に書き出す。
# Blender に同梱の Python で動かす(リポジトリの venv は使わない)。
#
#   blender --background --python tools/blender/build_mower.py
#
# 寸法は実寸 (m)。原点は後輪軸の中央の接地点。
# Blender では -Y が前、+X が左、+Z が上。書き出すと +Z が前、+X が左、+Y が上になる。
# 車輪とリールの位置や幅は、機種の定義 src/renderer/src/sim/mowers/fairway.json から読む。
# アプリの計算(刈る範囲、車輪の跡)も同じファイルを読むので、見た目と計算がずれない。
# 動かす部品には決まった名前をつける(src/renderer/src/render/mowerModel.ts が名前で探す)。
# 番号は、定義ファイルの wheels と reels の並び順。
#   wheel_0, wheel_1, ... : 車輪(X 軸まわりに回す)
#   steer_2, steer_3, ... : 操舵する車輪の向きを変える軸(番号は車輪と同じ)
#   deck                  : 刈刃のまとまり(上げ下げする)
#   reel_0, reel_1, ...   : リール刃(X 軸まわりに回す)
# 運転者の部品は driver の下にまとめる(アプリからは動かさない)。

import json
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

SOURCE = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "renderer", "src")
)
with open(os.path.join(SOURCE, "sim", "mowers", "fairway.json"), encoding="utf-8") as spec_file:
    SPEC = json.load(spec_file)

WHEELS = SPEC["wheels"]
REELS = SPEC["reels"]
WHEELBASE = SPEC["wheelbase"]
DECK_OFFSET = SPEC["deckOffset"]
TRACK = max(w["side"] for w in WHEELS) - min(w["side"] for w in WHEELS)
WHEEL_RADIUS = WHEELS[0]["radius"]
WHEEL_WIDTH = WHEELS[0]["width"]
# リールの刈る幅は隣と少し重なっている。見た目のリールは、その分だけ細く作る
REEL_OVERLAP = 0.1

OUTPUT = os.path.join(SOURCE, "assets", "models", SPEC["model"])


def at(left, forward, up):
    """機体の座標(左、前、上)を Blender の座標にする"""
    return Vector((left, -forward, up))


def make_material(name, color, roughness, metallic=0.0):
    material = bpy.data.materials.new(name)
    try:
        material.use_nodes = True
    except Exception:
        pass
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return material


def finish_object(name, bm, location, material, parent):
    for face in bm.faces:
        face.smooth = True
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    if parent is not None:
        obj.parent = parent
    # 面取りした角だけが丸く、平らな面は平らに見えるようにする
    obj.modifiers.new("normals", "WEIGHTED_NORMAL")
    return obj


def add_box(name, size, location, material, parent=None, bevel=0.03, rotation=None):
    """角を丸めた箱。size は (左右, 前後, 上下)"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vert in bm.verts:
        vert.co = Vector((vert.co.x * size[0], vert.co.y * size[1], vert.co.z * size[2]))
    limit = min(size) * 0.45
    if bevel > 0:
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=min(bevel, limit),
            segments=3,
            profile=0.5,
            affect="EDGES",
        )
    obj = finish_object(name, bm, location, material, parent)
    if rotation is not None:
        obj.rotation_euler = rotation
    return obj


def add_cylinder(name, radius, length, location, material, parent=None, axis="X", bevel=0.0, segments=32):
    """円柱。axis は軸の向き"""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=length
    )
    if bevel > 0:
        rim = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
        bmesh.ops.bevel(
            bm, geom=rim, offset=min(bevel, radius * 0.45, length * 0.45), segments=3, profile=0.5, affect="EDGES"
        )
    if axis == "X":
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.radians(90), 4, "Y"), verts=bm.verts)
    elif axis == "Y":
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.radians(90), 4, "X"), verts=bm.verts)
    return finish_object(name, bm, location, material, parent)


def add_empty(name, location, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    if parent is not None:
        obj.parent = parent
    return obj


def add_sphere(name, radius, location, material, parent=None, scale=(1, 1, 1), segments=20):
    """球。scale は (左右, 前後, 上下) の倍率"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
    for vert in bm.verts:
        vert.co = Vector((vert.co.x * scale[0], vert.co.y * scale[1], vert.co.z * scale[2]))
    return finish_object(name, bm, location, material, parent)


def add_limb(name, start, end, radius, material, parent=None):
    """2 点を結ぶ丸棒(腕や脚)。両端を球で丸める"""
    middle = (start + end) / 2
    direction = end - start
    limb = add_cylinder(name, radius, direction.length, middle, material, parent, "Z", segments=16)
    limb.rotation_euler = Vector((0, 0, 1)).rotation_difference(direction.normalized()).to_euler()
    add_sphere(name + "_a", radius * 1.04, start, material, parent, segments=16)
    add_sphere(name + "_b", radius * 1.04, end, material, parent, segments=16)
    return limb


def add_driver(parent, materials):
    """運転者(麦わら帽子のおじさん)。座席に座り、ハンドルを握る。寸法は座席とハンドルの位置に合わせてある"""
    driver = add_empty("driver", Vector((0, 0, 0)), parent)

    # ---- 胴体(少し後ろにもたれる。腹が出ている)
    add_box("driver_hips", (0.38, 0.3, 0.2), at(0, 0.8, 1.16), materials["pants"], driver, 0.08)
    add_box(
        "driver_torso", (0.42, 0.25, 0.5), at(0, 0.74, 1.48), materials["shirt"], driver, 0.1,
        rotation=(math.radians(-6), 0, 0),
    )
    add_sphere("driver_belly", 0.17, at(0, 0.84, 1.37), materials["shirt"], driver, scale=(1.05, 0.85, 1.0))

    # ---- 頭
    head = at(0, 0.76, 1.9)
    add_cylinder("driver_neck", 0.055, 0.12, at(0, 0.75, 1.76), materials["skin"], driver, "Z", segments=16)
    add_sphere("driver_head", 0.115, head, materials["skin"], driver, scale=(0.95, 1.0, 1.08))
    add_sphere("driver_nose", 0.026, head + at(0, 0.115, -0.015), materials["skin"], driver, segments=12)
    for side in (-1, 1):
        add_sphere(f"driver_ear_{side}", 0.03, head + at(side * 0.108, 0.0, -0.01), materials["skin"], driver, scale=(0.5, 0.8, 1.0), segments=12)
        add_sphere(f"driver_eye_{side}", 0.013, head + at(side * 0.042, 0.103, 0.022), materials["shoe"], driver, segments=10)
        add_box(f"driver_brow_{side}", (0.045, 0.014, 0.012), head + at(side * 0.043, 0.104, 0.05), materials["hair"], driver, 0.004)
    add_box("driver_mustache", (0.085, 0.022, 0.024), head + at(0, 0.108, -0.048), materials["hair"], driver, 0.008)
    # 帽子の下からのぞく髪
    add_sphere("driver_hair", 0.113, head + at(0, -0.035, 0.008), materials["hair"], driver, scale=(1.0, 0.9, 1.0))
    # 首に巻いたタオル
    bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.03, major_segments=20, minor_segments=8)
    towel = bpy.context.active_object
    towel.name = "driver_towel"
    towel.data.materials.append(materials["towel"])
    for polygon in towel.data.polygons:
        polygon.use_smooth = True
    towel.parent = driver
    towel.location = at(0, 0.76, 1.755)
    towel.rotation_euler = (math.radians(-12), 0, 0)
    for side in (-1, 1):
        add_box(
            f"driver_towel_end_{side}", (0.06, 0.025, 0.14), at(side * 0.055, 0.872, 1.675), materials["towel"], driver, 0.01,
            rotation=(math.radians(8), math.radians(side * 14), 0),
        )

    # ---- 麦わら帽子(少し前に傾ける)
    hat = add_empty("driver_hat", head + at(0, 0.0, 0.085), driver)
    hat.rotation_euler = (math.radians(7), 0, 0)
    add_cylinder("hat_brim", 0.235, 0.014, Vector((0, 0, 0)), materials["straw"], hat, "Z", bevel=0.005)
    add_cylinder("hat_crown", 0.122, 0.11, Vector((0, 0, 0.055)), materials["straw"], hat, "Z", bevel=0.03, segments=24)
    add_cylinder("hat_band", 0.126, 0.032, Vector((0, 0, 0.024)), materials["band"], hat, "Z", segments=24)

    # ---- 腕(ハンドルの左右を握る)と脚(床に足を置く)
    for side in (-1, 1):
        shoulder = at(side * 0.245, 0.75, 1.67)
        elbow = at(side * 0.3, 0.98, 1.44)
        hand = at(side * 0.19, 1.28, 1.56)
        add_limb(f"driver_upper_arm_{side}", shoulder, elbow, 0.055, materials["shirt"], driver)
        add_limb(f"driver_forearm_{side}", elbow, hand, 0.045, materials["skin"], driver)
        add_sphere(f"driver_glove_{side}", 0.058, hand, materials["towel"], driver, scale=(0.85, 1.0, 1.0), segments=14)

        hip = at(side * 0.11, 0.86, 1.15)
        knee = at(side * 0.24, 1.24, 1.17)
        ankle = at(side * 0.34, 1.3, 0.78)
        add_limb(f"driver_thigh_{side}", hip, knee, 0.085, materials["pants"], driver)
        add_limb(f"driver_shin_{side}", knee, ankle, 0.065, materials["pants"], driver)
        add_box(f"driver_shoe_{side}", (0.11, 0.27, 0.1), at(side * 0.34, 1.35, 0.71), materials["shoe"], driver, 0.035)
    return driver


def add_wheel(name, parent, materials, radius=WHEEL_RADIUS, width=WHEEL_WIDTH):
    """車輪。原点は車輪の中心。親の位置に置く"""
    tire = add_cylinder(name, radius, width, Vector((0, 0, 0)), materials["rubber"], parent, "X", bevel=0.07)
    add_cylinder(name + "_rim", radius * 0.58, width + 0.02, Vector((0, 0, 0)), materials["rim"], tire, "X", bevel=0.02)
    add_cylinder(name + "_hub", radius * 0.2, width + 0.06, Vector((0, 0, 0)), materials["dark"], tire, "X", bevel=0.015)
    # 回っているのが分かるように、ホイールにボルトを並べる
    for i in range(5):
        angle = math.radians(72 * i)
        for side in (-1, 1):
            add_cylinder(
                f"{name}_bolt_{i}_{side}",
                0.022,
                0.02,
                Vector((side * (width / 2 + 0.012), math.cos(angle) * radius * 0.38, math.sin(angle) * radius * 0.38)),
                materials["metal"],
                tire,
                "X",
            )
    return tire


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)

    materials = {
        "body": make_material("body", (0.62, 0.035, 0.03), 0.32),
        "dark": make_material("dark", (0.03, 0.032, 0.035), 0.6),
        "rubber": make_material("rubber", (0.018, 0.018, 0.02), 0.9),
        "rim": make_material("rim", (0.85, 0.62, 0.06), 0.4),
        "metal": make_material("metal", (0.55, 0.57, 0.6), 0.3, 1.0),
        "seat": make_material("seat", (0.05, 0.05, 0.055), 0.75),
        "lamp": make_material("lamp", (0.9, 0.88, 0.8), 0.15),
        "skin": make_material("skin", (0.68, 0.42, 0.29), 0.65),
        "shirt": make_material("shirt", (0.17, 0.29, 0.45), 0.8),
        "pants": make_material("pants", (0.2, 0.17, 0.11), 0.85),
        "shoe": make_material("shoe", (0.04, 0.035, 0.03), 0.7),
        "hair": make_material("hair", (0.27, 0.27, 0.27), 0.8),
        "straw": make_material("straw", (0.62, 0.43, 0.15), 0.85),
        "band": make_material("band", (0.1, 0.05, 0.03), 0.7),
        "towel": make_material("towel", (0.72, 0.72, 0.69), 0.9),
    }

    root = add_empty("mower", Vector((0, 0, 0)))

    # ---- 車体
    add_box("frame", (0.86, 2.15, 0.2), at(0, 0.72, 0.5), materials["dark"], root, 0.04)
    add_box("hood", (1.02, 1.0, 0.52), at(0, -0.02, 0.9), materials["body"], root, 0.1)
    add_box("hood_top", (0.7, 0.62, 0.08), at(0, -0.06, 1.17), materials["dark"], root, 0.03)
    add_box("grille", (0.8, 0.05, 0.3), at(0, -0.53, 0.88), materials["dark"], root, 0.02)
    add_box("floor", (1.0, 0.95, 0.08), at(0, 1.05, 0.62), materials["dark"], root, 0.03)
    add_box("cowl", (0.5, 0.3, 0.6), at(0, 1.5, 0.9), materials["body"], root, 0.08)
    add_box("nose", (0.74, 0.34, 0.26), at(0, 1.72, 0.62), materials["body"], root, 0.08)
    for side in (-1, 1):
        add_box(f"fender_r_{side}", (0.38, 0.86, 0.1), at(side * TRACK / 2, 0.0, 0.72), materials["body"], root, 0.04)
        add_box(f"fender_f_{side}", (0.36, 0.8, 0.08), at(side * TRACK / 2, WHEELBASE, 0.72), materials["body"], root, 0.035)
        add_box(f"lamp_{side}", (0.14, 0.05, 0.1), at(side * 0.24, 1.9, 0.66), materials["lamp"], root, 0.02)

    # ---- 座席とハンドル
    add_box("seat_base", (0.54, 0.52, 0.14), at(0, 0.82, 1.0), materials["seat"], root, 0.06)
    add_box("seat_back", (0.54, 0.14, 0.52), at(0, 0.56, 1.3), materials["seat"], root, 0.06, rotation=(math.radians(-10), 0, 0))
    for side in (-1, 1):
        add_box(f"armrest_{side}", (0.07, 0.36, 0.05), at(side * 0.33, 0.78, 1.22), materials["dark"], root, 0.02)
    column = add_cylinder("column", 0.03, 0.5, at(0, 1.42, 1.33), materials["dark"], root, "Z")
    column.rotation_euler = (math.radians(-28), 0, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.19, minor_radius=0.022, major_segments=32, minor_segments=10)
    steering = bpy.context.active_object
    steering.name = "steering_wheel"
    steering.data.materials.append(materials["dark"])
    for polygon in steering.data.polygons:
        polygon.use_smooth = True
    steering.parent = root
    steering.location = at(0, 1.3, 1.56)
    steering.rotation_euler = (math.radians(-28), 0, 0)
    spoke = add_box("steering_spoke", (0.36, 0.035, 0.02), Vector((0, 0, 0)), materials["dark"], steering, 0.008)
    spoke.location = Vector((0, 0, 0))

    # ---- 運転者
    add_driver(root, materials)

    # ---- 転倒時に運転者を守る枠
    for side in (-1, 1):
        add_cylinder(f"rops_post_{side}", 0.035, 1.25, at(side * 0.42, 0.34, 1.42), materials["dark"], root, "Z", bevel=0.01)
    add_cylinder("rops_top", 0.035, 0.91, at(0, 0.34, 2.04), materials["dark"], root, "X", bevel=0.01)

    # ---- 車輪
    for i, wheel in enumerate(WHEELS):
        prefix = "steer" if wheel["steered"] else "axle"
        pivot = add_empty(f"{prefix}_{i}", at(wheel["side"], wheel["ahead"], wheel["radius"]), root)
        add_wheel(f"wheel_{i}", pivot, materials, wheel["radius"], wheel["width"])
    add_cylinder("axle_rear", 0.045, TRACK - WHEEL_WIDTH, at(0, 0, WHEEL_RADIUS), materials["dark"], root, "X")
    add_cylinder("axle_front", 0.04, TRACK - WHEEL_WIDTH, at(0, WHEELBASE, WHEEL_RADIUS), materials["dark"], root, "X")

    # ---- 刈刃(リールの位置と幅は定義ファイルによる)
    deck = add_empty("deck", at(0, DECK_OFFSET, 0), root)
    beam = max(r["side"] for r in REELS) - min(r["side"] for r in REELS) + 0.16
    add_box("deck_beam", (beam, 0.09, 0.09), at(0, -0.02, 0.5), materials["dark"], deck, 0.02)
    add_box("deck_arm", (0.14, 0.78, 0.1), at(0, -0.36, 0.5), materials["dark"], deck, 0.03)
    for i, reel_spec in enumerate(REELS):
        unit_width = reel_spec["width"] - REEL_OVERLAP
        left = reel_spec["side"]
        forward = reel_spec["ahead"] - DECK_OFFSET
        unit = add_empty(f"unit_{i}", at(left, forward, 0), deck)
        add_box(f"unit_cover_{i}", (unit_width, 0.36, 0.1), at(0, -0.06, 0.3), materials["body"], unit, 0.035)
        add_box(f"unit_back_{i}", (unit_width, 0.06, 0.2), at(0, -0.24, 0.2), materials["body"], unit, 0.02)
        for side in (-1, 1):
            add_box(f"unit_side_{i}_{side}", (0.04, 0.46, 0.24), at(side * (unit_width / 2 - 0.02), 0, 0.17), materials["dark"], unit, 0.015)
        add_cylinder(f"unit_roller_f_{i}", 0.045, unit_width - 0.1, at(0, 0.21, 0.045), materials["metal"], unit, "X")
        add_cylinder(f"unit_roller_r_{i}", 0.04, unit_width - 0.1, at(0, -0.2, 0.04), materials["metal"], unit, "X")
        add_box(f"unit_link_{i}", (0.06, abs(forward) + 0.3, 0.06), at(0, -forward / 2 - 0.1, 0.42), materials["dark"], unit, 0.02)
        # リール刃: 軸のまわりに、ねじれた刃を並べる
        reel = add_cylinder(f"reel_{i}", 0.02, unit_width - 0.1, at(0, 0.04, 0.13), materials["metal"], unit, "X")
        blades = 7
        for b in range(blades):
            angle = math.radians(360 / blades * b)
            blade = add_box(
                f"reel_blade_{i}_{b}",
                (unit_width - 0.12, 0.012, 0.075),
                Vector((0, 0, 0)),
                materials["metal"],
                reel,
                0.0,
            )
            blade.rotation_euler = (angle, 0, 0)
            blade.location = Vector((0, -math.sin(angle) * 0.055, math.cos(angle) * 0.055))

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUTPUT,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
    )
    print("書き出し:", OUTPUT)


build()
