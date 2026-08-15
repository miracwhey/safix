// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Central registry of snake_case JSON keys emitted by `CanonicalConverter`.
// Defined as a Swift enum-with-static-string-constants so a typo turns into a
// compile error instead of a silent schema-drift bug.
//
// The TS-side wire shape (`src/lib/spatial/canonical/schema/parametric-json-
// schema.ts`) is already snake_case; this file is the Swift-side mirror so
// that JSON produced by the iOS path round-trips byte-for-byte with the TS
// bridge output.
//

import Foundation

internal enum CanonicalKey {
    // ── Document envelope (parametric.json) ──────────────────────────────
    static let schemaVersion       = "schema_version"
    static let generatedAt         = "generated_at"
    static let source              = "source"
    static let coordinateSystem    = "coordinate_system"
    static let unit                = "unit"
    static let project             = "project"
    static let sceneGraph          = "scene_graph"
    static let walkableAreas       = "walkable_areas"
    static let collisionVolumes    = "collision_volumes"
    static let connectivityGraph   = "connectivity_graph"
    static let validationReport    = "validation_report"
    static let variants            = "variants"
    static let overrides           = "overrides"
    static let metadata            = "metadata"

    // ── Project ──────────────────────────────────────────────────────────
    static let id                  = "id"
    static let typeKey             = "type"
    static let name                = "name"
    static let parentId            = "parent_id"
    static let childrenIds         = "children_ids"
    static let transform           = "transform"
    static let position            = "position"
    static let rotation            = "rotation"
    static let scale               = "scale"
    static let sourceKey           = "source"
    static let confidence          = "confidence"
    static let roomplanUuid        = "roomplan_uuid"
    static let variantId           = "variant_id"
    static let createdAt           = "created_at"
    static let updatedAt           = "updated_at"
    static let editedByUserId      = "edited_by_user_id"
    static let fixupProjectId      = "fixup_project_id"
    static let fixupJobId          = "fixup_job_id"
    static let defaultUnit         = "default_unit"
    static let buildings           = "buildings"
    static let variantIds          = "variant_ids"

    // ── Building ─────────────────────────────────────────────────────────
    static let rooms               = "rooms"
    static let connectivityGraphRef = "connectivity_graph_ref"

    // ── Room ─────────────────────────────────────────────────────────────
    static let category            = "category"
    static let walls               = "walls"
    static let floor               = "floor"
    static let ceiling             = "ceiling"
    static let freeObjects         = "free_objects"
    static let pins                = "pins"
    static let photos              = "photos"
    static let notes               = "notes"
    static let boundsMin           = "bounds_min"
    static let boundsMax           = "bounds_max"
    static let computedAreaM2      = "computed_area_m2"
    static let computedVolumeM3    = "computed_volume_m3"

    // ── Wall ─────────────────────────────────────────────────────────────
    static let startPoint          = "start_point"
    static let endPoint            = "end_point"
    static let heightM             = "height_m"
    static let thicknessM          = "thickness_m"
    static let baseHeightM         = "base_height_m"
    static let polygonOverride     = "polygon_override"
    static let openings            = "openings"
    static let wallMounted         = "wall_mounted"
    static let isExteriorWall      = "is_exterior_wall"
    static let walkableBlocker     = "walkable_blocker"
    static let materialId          = "material_id"
    static let lengthM             = "length_m"
    static let normal              = "normal"

    // ── Floor / ceiling ──────────────────────────────────────────────────
    static let polygon             = "polygon"
    static let walkableSurface     = "walkable_surface"
    static let floorMounted        = "floor_mounted"
    static let ceilingMounted      = "ceiling_mounted"

    // ── WallOpening ──────────────────────────────────────────────────────
    static let hostWallId          = "host_wall_id"
    static let offsetAlongWallM    = "offset_along_wall_m"
    static let offsetFromFloorM    = "offset_from_floor_m"
    static let widthM              = "width_m"
    static let swingDirection      = "swing_direction"
    static let isWalkablePortal    = "is_walkable_portal"
    static let connectsRoomIds     = "connects_room_ids"
    static let sillHeightM         = "sill_height_m"
    static let hostWallConfidence  = "host_wall_confidence"

    // ── SpatialObject ────────────────────────────────────────────────────
    static let assetId             = "asset_id"
    static let dimensions          = "dimensions"
    static let depthM              = "depth_m"
    static let host                = "host"
    static let hostId              = "host_id"
    static let heightFromFloorM    = "height_from_floor_m"
    static let depthFromWallM      = "depth_from_wall_m"
    static let rotationAroundYDeg  = "rotation_around_y_deg"
    static let renovationIntent    = "renovation_intent"

    // ── Vector3 / Quaternion ─────────────────────────────────────────────
    static let xKey                = "x"
    static let yKey                = "y"
    static let zKey                = "z"
    static let wKey                = "w"

    // ── Variant entries ──────────────────────────────────────────────────
    static let displayName         = "display_name"
    static let isDefault           = "is_default"

    // ── Connectivity-graph node ──────────────────────────────────────────
    static let cgNodes             = "nodes"
    static let cgEdges             = "edges"
    static let cgRoomId            = "room_id"

    // ── Document metadata ────────────────────────────────────────────────
    static let metaSourceScanId    = "source_scan_id"
    static let metaWarnings        = "warnings"
    static let metaIosNative       = "ios_native_converter"
    /// Lookup from RoomPlan surface external id → canonical node id used to
    /// resolve annotations anchored to walls collapsed by the wall-doubling
    /// detector (H28). Dropped surfaces map to their survivor's id; surviving
    /// surfaces map to themselves. Mirrors `bridgeDefaults.surfaceExternalId
    /// ToNodeId` exposed by the TS bridge.
    static let metaSurfaceExternalIdToNodeId = "surface_external_id_to_node_id"
}
