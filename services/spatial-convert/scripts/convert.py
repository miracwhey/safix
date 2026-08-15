"""Blender 4.x USDZ → glb converter (V1.5 hotfix: cleanup stage added).

Invoked from postprocess.sh as:

    blender --background --python convert.py -- in.usdz out.glb

Strategy:
* Start with an empty scene so the import is isolated.
* Import USDZ via the bundled USD-Importer.
* V1.5 Hotfix R3-P1: per-mesh cleanup (custom-normals-clear →
  remove_doubles 0.5mm → normals-make-consistent → auto-smooth 30°)
  to fix the "fransige Ränder" the bitwise-exact gltf-transform weld
  can't merge (Float-Drift from USD-import). Ordering is binding —
  see ~/.claude/plans/spatial-research-r3-mesh-pipeline.md §B.
* Export as glTF 2.0 binary (.glb) with embed-textures + no animations
  (RoomPlan output is static geometry).

Failure model: any exception causes Blender to exit non-zero, which the
shell wrapper turns into a 5xx upstream.
"""

import bpy
import math
import sys


def cleanup_meshes() -> int:
    """V1.5 Hotfix R3-P1: post-import per-mesh cleanup.

    Order is binding (see research R3 §B):
        1. customdata_custom_splitnormals_clear — must come BEFORE merge,
           otherwise remove_doubles silently destroys the normal data
           (Blender Issue #1316).
        2. remove_doubles(threshold=0.0005) — merge vertices within 0.5 mm,
           kills the float-drift split-vertices from USD-import that
           gltf-transform's bitwise-exact weld can't catch.
        3. normals_make_consistent(inside=False) — recompute consistent
           outward-facing normals after the merge.
        4. shade_auto_smooth(angle=30°) — smooth surfaces below 30°
           dihedral, sharp above. Keeps wall/floor edges crisp while
           smoothing curved object surfaces. Blender 4.1+ ships this op
           as a node-group modifier and `export_apply=True` bakes it.

    Returns the number of meshes processed for logging.
    """
    mesh_count = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue

        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)

        bpy.ops.mesh.customdata_custom_splitnormals_clear()

        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.remove_doubles(threshold=0.0005)
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode="OBJECT")

        bpy.ops.object.shade_auto_smooth(angle=math.radians(30.0))

        obj.select_set(False)
        mesh_count += 1

    return mesh_count


def main() -> None:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("usage: blender --background --python convert.py -- in.usdz out.glb")
    args = argv[argv.index("--") + 1 :]
    if len(args) < 2:
        raise SystemExit("convert.py needs <input.usdz> <output.glb>")
    src, dst = args[0], args[1]

    # Reset to a clean scene so leftover defaults (camera, light, cube) do
    # not pollute the export.
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.wm.usd_import(filepath=src)

    cleaned = cleanup_meshes()
    print(f"[convert] V1.5 cleanup applied to {cleaned} mesh(es)", file=sys.stderr)

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_image_format="AUTO",
        export_apply=True,
        export_animations=False,
        export_lights=False,
        export_cameras=False,
    )


if __name__ == "__main__":
    main()
