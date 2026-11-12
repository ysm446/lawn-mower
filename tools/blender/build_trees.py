# 樹木のモデルを作って glTF (.glb) に書き出す。広葉樹、針葉樹、低木を、それぞれ何通りか作る。
# Blender に同梱の Python で動かす(リポジトリの venv は使わない)。
#
#   blender --background --python tools/blender/build_trees.py
#
# 幹と枝は筒、葉は「小枝 1 本ぶんの葉をまとめた板」で作る。板には UV を付けてあり、
# アプリ側 (src/renderer/src/render/trees.ts) が葉の絵のテクスチャを貼る。寸法は実寸 (m)。
# アプリ側は、木ごとの樹高に合わせて全体を伸び縮みさせる(基準の高さは下の HEIGHTS)。
# 部品の名前:
#   broadleaf_0_bark, broadleaf_0_leaves, conifer_1_bark, shrub_0_leaves, ...
# 中くらいの距離で使う簡略モデル(LOD1)も書き出す。名前は broadleaf_0_lod1_bark のように lod1 を挟む。
# 同じシード値で同じ順に乱数を使い、作る形だけを減らすので、枝ぶりは細かいモデルと揃う:
#   - 細い枝(4 段目から先)の筒は作らない。太い枝も、筒の角の数と節を減らす
#   - 葉の板は、広葉樹と低木は 3 枚に 1 枚、針葉樹は 2 枚に 1 枚だけ作り、その分だけ大きくする(面積を保つ)

import math
import os
import random

import bmesh
import bpy
from mathutils import Vector

# 種類ごとの、基準の高さ (m) と作る数。trees.ts の MODELS と揃える
HEIGHTS = {"broadleaf": 12.0, "conifer": 14.0, "shrub": 1.8}
VARIANTS = {"broadleaf": 3, "conifer": 2, "shrub": 2}

OUTPUT = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "src", "renderer", "src", "assets", "models", "trees.glb",
    )
)


def perpendicular(direction):
    """direction に直交する単位ベクトルを 2 本返す"""
    helper = Vector((0, 0, 1)) if abs(direction.z) < 0.9 else Vector((1, 0, 0))
    a = direction.cross(helper).normalized()
    b = direction.cross(a).normalized()
    return a, b


class TreeBuilder:
    def __init__(self, seed, lod=0):
        self.rng = random.Random(seed)
        self.lod = lod
        self.bark = bmesh.new()
        self.leaves = bmesh.new()
        self.uv = self.leaves.loops.layers.uv.verify()
        # LOD1 で葉の板を間引くための数え上げ
        self.card_count = 0

    def keep_card(self, every):
        """LOD1 では every 枚に 1 枚だけ作る。作るなら大きさの倍率を返し、作らないなら 0"""
        self.card_count += 1
        if self.lod == 0:
            return 1.0
        return math.sqrt(every) if self.card_count % every == 0 else 0.0

    def simple_tube(self, points, radius_start, radius_end, sides):
        """LOD1 の筒。節を半分に減らす(両端は残す)"""
        if self.lod == 0:
            self.tube(points, radius_start, radius_end, sides)
            return
        kept = points[::2] if (len(points) - 1) % 2 == 0 else points[::2] + [points[-1]]
        self.tube(kept, radius_start, radius_end, sides)

    # ---- 部品

    def ring(self, center, direction, radius, sides):
        a, b = perpendicular(direction)
        return [
            self.bark.verts.new(
                center + (a * math.cos(2 * math.pi * i / sides) + b * math.sin(2 * math.pi * i / sides)) * radius
            )
            for i in range(sides)
        ]

    def tube(self, points, radius_start, radius_end, sides):
        """点の並びに沿った筒"""
        previous = None
        for i, point in enumerate(points):
            ahead = points[min(i + 1, len(points) - 1)] - points[max(i - 1, 0)]
            t = i / (len(points) - 1)
            current = self.ring(point, ahead.normalized(), radius_start + (radius_end - radius_start) * t, sides)
            if previous:
                for k in range(sides):
                    j = (k + 1) % sides
                    self.bark.faces.new((previous[k], previous[j], current[j], current[k]))
            previous = current

    def card(self, center, along, normal, length, width):
        """葉の板。along が小枝の向き(UV の縦)、normal が面の向き"""
        along = (along - normal * along.dot(normal)).normalized()
        side = normal.cross(along).normalized()
        corners = [
            (center - along * length / 2 - side * width / 2, (0, 0)),
            (center - along * length / 2 + side * width / 2, (1, 0)),
            (center + along * length / 2 + side * width / 2, (1, 1)),
            (center + along * length / 2 - side * width / 2, (0, 1)),
        ]
        face = self.leaves.faces.new([self.leaves.verts.new(p) for p, _ in corners])
        for loop, (_, uv) in zip(face.loops, corners):
            loop[self.uv].uv = uv

    # ---- 広葉樹と低木

    def branch(self, start, direction, length, radius, depth, style):
        """枝を 1 本伸ばし、先と途中から次の枝を出す"""
        rng = self.rng
        sides = 8 if depth == 0 else 6 if depth == 1 else 4 if depth < 4 else 3
        segments = 5 if depth == 0 else 4 if depth < 3 else 2
        point = start.copy()
        heading = direction.normalized()
        points = [point.copy()]
        for _ in range(segments):
            # 少しずつ曲がりながら伸びる。細い枝ほど大きく曲がり、上へ向かおうとする
            wobble = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.5, 1)))
            heading = (heading + wobble * (0.1 + 0.07 * depth) + Vector((0, 0, 0.05 * depth))).normalized()
            point = point + heading * (length / segments)
            points.append(point.copy())
        if self.lod == 0:
            self.tube(points, radius, radius * 0.55, sides)
        elif depth <= 2:
            self.simple_tube(points, radius, radius * 0.55, 5 if depth == 0 else 4 if depth == 1 else 3)
        if depth >= 2:
            self.leaf_cards(points, heading, depth, style)
        if depth >= 4:
            return
        children = [(1.0, rng.randint(2, 3))]
        if depth <= 2:
            children.append((rng.uniform(0.45, 0.7), rng.randint(1, 2)))
            children.append((rng.uniform(0.7, 0.9), 1))
        for share, count in children:
            base = points[min(len(points) - 1, max(1, round(share * segments)))]
            turn = rng.uniform(0, 2 * math.pi)
            for c in range(count):
                a, b = perpendicular(heading)
                around = turn + 2 * math.pi * c / count + rng.uniform(-0.5, 0.5)
                spread = math.radians(rng.uniform(28, 58) if depth > 0 else rng.uniform(35, 65))
                child = heading * math.cos(spread) + (a * math.cos(around) + b * math.sin(around)) * math.sin(spread)
                self.branch(
                    base,
                    child,
                    length * rng.uniform(0.58, 0.78),
                    radius * (0.55 if share == 1.0 else 0.42) * rng.uniform(0.9, 1.1),
                    depth + 1,
                    style,
                )

    def leaf_cards(self, points, heading, depth, style):
        rng = self.rng
        count = style["cards"][depth - 2]
        lo, hi = style["card_size"]
        for _ in range(count):
            base = points[rng.randint(1, len(points) - 1)]
            length = rng.uniform(lo, hi)
            # 板は枝から外へ伸び、面はだいたい上を向きながら、ばらばらに傾く
            out = (heading + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 0.6))) * 0.9).normalized()
            normal = (Vector((0, 0, 1)) + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.2, 0.4))) * 0.8).normalized()
            grow = self.keep_card(3)
            if grow > 0:
                self.card(base + out * length * 0.45 * grow, out, normal, length * grow, length * 0.72 * grow)

    def build_broadleaf(self, height):
        rng = self.rng
        style = {"cards": (1, 3, 5), "card_size": (0.95, 1.4)}
        trunk = height * rng.uniform(0.3, 0.4)
        lean = Vector((rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), 1))
        self.branch(Vector((0, 0, -0.4)), lean, trunk + 0.4, height * 0.024, 0, style)

    def build_shrub(self, height):
        rng = self.rng
        style = {"cards": (2, 3, 4), "card_size": (0.4, 0.62)}
        for _ in range(rng.randint(4, 6)):
            angle = rng.uniform(0, 2 * math.pi)
            direction = Vector((math.cos(angle) * 0.55, math.sin(angle) * 0.55, 1))
            start = Vector((math.cos(angle) * 0.12, math.sin(angle) * 0.12, -0.1))
            # 根元から何本も立ち上がる。枝分かれは 2 段だけ
            self.branch(start, direction, height * rng.uniform(0.45, 0.6), 0.035, 2, style)

    # ---- 針葉樹

    def build_conifer(self, height):
        rng = self.rng
        top = height * rng.uniform(0.95, 1.05)
        trunk = [Vector((0, 0, -0.4 + (top + 0.4) * i / 10)) for i in range(11)]
        if self.lod == 0:
            self.tube(trunk, height * 0.02, height * 0.004, 7)
        else:
            self.simple_tube(trunk, height * 0.02, height * 0.004, 4)
        z = height * rng.uniform(0.16, 0.22)
        turn = rng.uniform(0, 2 * math.pi)
        while z < top * 0.97:
            t = (z - height * 0.18) / (top - height * 0.18)
            # 下の枝ほど長い(円錐の形)。枝は少し垂れてから、先で持ち上がる
            reach = max(1 - t, 0.03) ** 0.85 * height * 0.27 + 0.3
            count = rng.randint(5, 7)
            turn += rng.uniform(0.3, 0.9)
            for k in range(count):
                angle = turn + 2 * math.pi * k / count + rng.uniform(-0.2, 0.2)
                out = Vector((math.cos(angle), math.sin(angle), 0))
                length = reach * rng.uniform(0.8, 1.1)
                droop = rng.uniform(0.12, 0.3) * (1 - t)
                points = [
                    Vector((0, 0, z)) + out * length * s + Vector((0, 0, -droop * length * math.sin(s * math.pi) + 0.08 * length * s * s))
                    for s in (0, 0.35, 0.7, 1.0)
                ]
                # LOD1 では枝の筒を作らない(葉の板に隠れる)
                if self.lod == 0:
                    self.tube(points, 0.035 * (1 - t) + 0.008, 0.006, 3)
                # 葉の板を、枝に沿って重ねながら並べる
                cards = max(1, round(length / 0.55))
                for c in range(cards):
                    s = (c + 0.7) / cards
                    index = min(int(s * 3), 2)
                    f = s * 3 - index
                    center = points[index] + (points[index + 1] - points[index]) * f
                    size = rng.uniform(0.85, 1.15) * (0.75 + 0.5 * (1 - t))
                    normal = (Vector((0, 0, 1)) + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 0.35 - out * 0.15).normalized()
                    grow = self.keep_card(2)
                    if grow > 0:
                        self.card(center, out, normal, size * grow, size * 0.62 * grow)
            z += rng.uniform(0.4, 0.6) * (0.6 + 0.6 * (1 - t))

    # ---- 仕上げ

    def finish(self, name, material_bark, material_leaves):
        objects = []
        for suffix, bm, material, smooth in (
            ("bark", self.bark, material_bark, True),
            ("leaves", self.leaves, material_leaves, False),
        ):
            for face in bm.faces:
                face.smooth = smooth
            mesh = bpy.data.meshes.new(f"{name}_{suffix}")
            bm.to_mesh(mesh)
            bm.free()
            mesh.materials.append(material)
            obj = bpy.data.objects.new(f"{name}_{suffix}", mesh)
            bpy.context.scene.collection.objects.link(obj)
            objects.append(obj)
        return objects


def make_material(name, color, roughness):
    material = bpy.data.materials.new(name)
    try:
        material.use_nodes = True
    except Exception:
        pass
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bark = make_material("bark", (0.09, 0.065, 0.045), 0.95)
    leaves = make_material("leaves", (0.07, 0.16, 0.035), 0.6)
    seed = 101
    for kind, count in VARIANTS.items():
        for v in range(count):
            seed += 37
            # 細かいモデルと、同じシード値の簡略モデル(LOD1)
            for lod, name in ((0, f"{kind}_{v}"), (1, f"{kind}_{v}_lod1")):
                builder = TreeBuilder(seed, lod)
                getattr(builder, f"build_{kind}")(HEIGHTS[kind])
                for obj in builder.finish(name, bark, leaves):
                    print(obj.name, "面:", len(obj.data.polygons))
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUTPUT,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
    )
    print("書き出し:", OUTPUT)


build()
