/**
 * Spatial · Canonical · Three · FloorplanCadOverlay (R9 Single-Plan-Fix)
 *
 * 2D-Grundriss im Architekten-Plan-Stil per Mockup 13 V5 State B
 * (Planner-5D / Roomle / Apple-Maps Aesthetik).
 *
 * Render-Stack (Layer-Reihenfolge):
 *   1. ModeBackground       warm-beige Gradient (#FAF7F0 → #EDE6D6)
 *   2. Floor-Quad           weiches beige (#F5F0E6) — nur als sichtbare
 *                           Raum-Innenfläche, kein Pattern (subtle)
 *   3. Walls (2D-Quads)     dunkle ink Rechtecke mit ~5 cm CAD-Strichstärke
 *                           (max(4cm, thickness*0.5)); Mockup zeigt mittlere
 *                           Linien, nicht volle Mauerdicke.
 *   4. Maß-Bubbles          weiße Pille mit border #E2E8F0, font 9px
 *   5. Center Room-Label    "Raum · X,X m²" zentral
 *
 * Verzichtet auf (per Mockup):
 *   - drei `<Grid>` (visueller Lärm)
 *   - Pin-Rendering (Customer-Hub V1 zeigt keine Pins im Floorplan)
 *   - Separate Floor-Polygon-Outline (R9): die Floor-Polygon-Außenkontur und
 *     die Wand-Mittellinien-Quads liegen um ~Wandstärke parallel zueinander
 *     verschoben (RoomPlan liefert Polygon = Aussen, Walls = Mittelachsen).
 *     Vorher rendern wir BEIDE → der User sah "zwei Grundrisse nebeneinander".
 *     Die Wand-Quads sind die kanonische Raumgrenze, die Outline war redundant
 *     und wurde entfernt.
 *
 * Folge-Iteration:
 *   - Türen + Fenster als Wand-Cutouts mit Schwingbogen-Symbol
 *   - Möbel/Sanitäranlagen als white-cards mit brand-blue Border
 *   - North-Arrow oben rechts
 *   - Subtle 50cm-Tile-Pattern im Floor-Quad
 */

import { useMemo, type ReactElement } from 'react'
import { Html, Line } from '@react-three/drei'
import { DoubleSide, Shape } from 'three'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'
import type { Wall, WallOpening } from '../../../../lib/spatial/canonical/types/geometry.ts'

const FLOOR_FILL = '#F5F0E6'
const WALL_FILL = '#1F2937'
const ROOM_LABEL_COLOR = '#64748B'
// R11-D Layer-2 colors (Mockup 13 V5 + Architektur-CAD-Konvention).
const OPENING_DOOR_FILL = '#FAF7F0' // beige, matches floor → "ausgeschnitten"
const OPENING_WINDOW_FILL = '#DBEAFE' // helles blau, light frosted glass
const OPENING_ARC_COLOR = '#1F2937' // hairline arc

interface OpeningOverlay {
  id: string
  shape: Shape
  type: 'door' | 'window' | 'opening'
  /** Schwingbogen-Daten — null für Fenster/Opening. */
  arc?: {
    cx: number
    cz: number
    radius: number
    startAngle: number
    endAngle: number
    clockwise: boolean
  }
}

/**
 * Build the overlay-shape for a single opening (door/window) in floorplan-Z'
 * coordinates (siehe Shape-Y-Negation-Convention). Wir positionieren den
 * Overlay genau ÜBER dem Wall-Quad-Segment dieser Öffnung — die Wand bleibt
 * darunter sichtbar, der Overlay färbt das Segment um (beige = Tür-Cutout,
 * hellblau = Fenster).
 *
 * Schwingbogen (Mockup 13 V5): bei Türen wird zusätzlich ein 90°-Kreis-Arc
 * gezeichnet, dessen Center am Hinge-Punkt sitzt. swing_direction='left'
 * setzt den Hinge an die start-side, 'right' an die end-side. 'sliding' /
 * 'unknown' / fehlend → Hinge default left.
 */
function buildOpeningOverlay(
  wall: Wall,
  opening: WallOpening,
): OpeningOverlay | null {
  const sx = wall.start_point.x
  const sz = wall.start_point.z
  const ex = wall.end_point.x
  const ez = wall.end_point.z
  const dx = ex - sx
  const dz = ez - sz
  const len = Math.hypot(dx, dz)
  if (len < 0.01) return null
  // Tangent (entlang Wand) + outward-perpendicular (siehe buildWallQuad).
  const tx = dx / len
  const tz = dz / len
  const nx = dz / len
  const nz = -dx / len
  const wallThickness = Math.max(0.04, (wall.thickness_m ?? 0.15) * 0.5)
  const t = wallThickness / 2
  // Start/Ende der Öffnung entlang der Wand-Mittellinie.
  const startU = opening.offset_along_wall_m
  const endU = startU + opening.width_m
  // Clamp damit clamp-on-wall-edge nicht aus der Wand rausläuft (Validator
  // §9.2 garantiert das eigentlich schon, aber defensive: niemals negative
  // oder >len).
  const u0 = Math.max(0, Math.min(len, startU))
  const u1 = Math.max(u0, Math.min(len, endU))
  if (u1 - u0 < 0.01) return null
  const ax = sx + tx * u0
  const az = sz + tz * u0
  const bx = sx + tx * u1
  const bz = sz + tz * u1
  const shape = new Shape()
  // Shape in Floorplan-Y'-Frame (Y-negiert relativ zu World-Z).
  shape.moveTo(ax - nx * t, -(az - nz * t))
  shape.lineTo(bx - nx * t, -(bz - nz * t))
  shape.lineTo(bx + nx * t, -(bz + nz * t))
  shape.lineTo(ax + nx * t, -(az + nz * t))
  shape.closePath()
  const result: OpeningOverlay = {
    id: opening.id,
    shape,
    type: opening.type,
  }
  // Schwingbogen nur bei Tür mit klarer Hinge-Seite.
  if (opening.type === 'door') {
    const hingeAtStart = opening.swing_direction !== 'right'
    const cx = hingeAtStart ? ax : bx
    const cz = hingeAtStart ? az : bz
    const radius = opening.width_m
    // Inward direction = -nx, -nz (zum Raum-Innenraum). Outward = nx, nz.
    // Schwingbogen geht 90° zum Raum-Inneren von der Wand-Tangent.
    // Two.js / three.js Arc-Convention: angle 0=+X-Axis, CCW positiv.
    // Wir berechnen direkt die Start- und End-Winkel basierend auf Hinge-
    // Position + tangent + inward-perpendicular.
    const tangentDir = hingeAtStart ? 1 : -1
    const startAngle = Math.atan2(-(tz * tangentDir), tx * tangentDir)
    // 90° in Richtung Raum-Inneres (inward = -n)
    const inwardX = -nx
    const inwardZ = -nz
    const endAngle = Math.atan2(-inwardZ, inwardX)
    result.arc = {
      cx,
      cz: -cz, // floorplan-Y'-Frame
      radius,
      startAngle,
      endAngle,
      clockwise: false,
    }
  }
  return result
}

/**
 * CAD-Strichstärke der Wände im Floorplan: physische Mauerdicke ist ~15 cm,
 * im 2D-Plan sieht das aber wie ein dicker Balken aus und kollidiert visuell
 * mit der Floor-Polygon-Aussenkante. Wir nehmen die halbe Dicke, mindestens
 * 4 cm — vergleichbar mit Standard-Architektur-Plänen.
 */
function planWallThickness(wall: Wall): number {
  const physical = wall.thickness_m ?? 0.15
  return Math.max(0.04, physical * 0.5)
}

interface WallQuad {
  id: string
  shape: Shape
}

/**
 * Shape-Vertex-Convention (R10 Iter-3 ALIGNMENT-FIX):
 * Die Shape liegt im lokalen XY-Plane (Z=0) und wird per `rotation=[-π/2,0,0]`
 * in den XZ-Plane gekippt. Diese Rotation MIRRORT die Y-Achse: Shape-Vertex
 * (a, b, 0) landet im World-Frame bei (a, 0, -b). World-Z wird also gegenüber
 * Shape-Y negiert.
 *
 * HTML-Labels nutzen direkt `<Html position={[x, 0.02, z]}>` (kein Mirror).
 * Wenn wir den Shape naiv mit `moveTo(p.x, p.z)` bauen, landet er bei (p.x, 0,
 * -p.z) — die Labels bei (p.x, 0.02, p.z). Differenz: Z-Mirror um World-Origin.
 *
 * Bei einem Raum dessen Bounding-Box NICHT symmetrisch um Z=0 liegt
 * (RoomPlan-Capture spawnt regelmässig irgendwo bei +X / +Z) sieht der User
 * die Wand-Quads/Floor-Quad oben-rechts und Maße/Label unten-mitte.
 *
 * Fix: Shape-Vertices mit -p.z bauen. Nach Rotation landen sie bei +p.z, also
 * im selben Frame wie die HTML-Labels.
 */
function buildWallQuad(wall: Wall): WallQuad | null {
  const sx = wall.start_point.x
  const sz = wall.start_point.z
  const ex = wall.end_point.x
  const ez = wall.end_point.z
  const dx = ex - sx
  const dz = ez - sz
  const len = Math.hypot(dx, dz)
  if (len < 0.01) return null
  // Outward-perpendicular (right-hand) = (dz, -dx) / len
  const nx = dz / len
  const nz = -dx / len
  const t = planWallThickness(wall) / 2
  const shape = new Shape()
  // World-Z negiert in den Shape's Y-axis (siehe Convention oben).
  shape.moveTo(sx - nx * t, -(sz - nz * t))
  shape.lineTo(ex - nx * t, -(ez - nz * t))
  shape.lineTo(ex + nx * t, -(ez + nz * t))
  shape.lineTo(sx + nx * t, -(sz + nz * t))
  shape.closePath()
  return { id: wall.id, shape }
}

/** Shoelace: signed polygon area; abs() für positiv. */
function polygonArea(points: { x: number; z: number }[]): number {
  let s = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    s += a.x * b.z - b.x * a.z
  }
  return Math.abs(s) / 2
}

/**
 * Discretize Arc in N=24 line-segments für drei `<Line>` rendering.
 * Center in floorplan-coords (cx, cz wo cz schon Y-negiert ist).
 * Returnt 3D-points-Array [x, y, z] für Line points-Prop.
 */
function discretizeArc(arc: {
  cx: number
  cz: number
  radius: number
  startAngle: number
  endAngle: number
}, yLevel: number): [number, number, number][] {
  const SEGMENTS = 24
  const pts: [number, number, number][] = []
  // Korridor angle-difference auf [-2π, 2π] normalisieren; wir nehmen den
  // kurzen Bogen (90° für Türen).
  let delta = arc.endAngle - arc.startAngle
  // Normaliere auf [-π, π].
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  for (let i = 0; i <= SEGMENTS; i += 1) {
    const angle = arc.startAngle + (delta * i) / SEGMENTS
    const px = arc.cx + arc.radius * Math.cos(angle)
    const pz = arc.cz + arc.radius * Math.sin(angle)
    pts.push([px, yLevel, pz])
  }
  return pts
}

/** Polygon centroid (für Center-Room-Label). */
function polygonCentroid(points: { x: number; z: number }[]): { x: number; z: number } {
  let cx = 0
  let cz = 0
  for (const p of points) {
    cx += p.x
    cz += p.z
  }
  return { x: cx / points.length, z: cz / points.length }
}

/**
 * Wall-Mittellinien-Polygon (R10 Alignment-Fix): Floor-Quad und Center-Label
 * werden aus DIESEM Polygon gebaut, nicht aus `floor.polygon`. Grund: RoomPlan
 * liefert `floor.polygon` als äußere Raumkontur (inkl. Wand-Dicke), die Walls
 * dagegen als Mittelachsen. Die beiden divergieren um ~Wandstärke parallel und
 * machten Maße/Label visuell "neben den Wänden" sitzen. Wir nehmen die
 * konsekutiven Wall-Start-Points als Polygon — RoomPlan-Konvention liefert
 * Walls als geschlossene Schleife in CCW-Reihenfolge.
 */
function wallCenterlinePolygon(
  walls: ReadonlyArray<Wall>,
): { x: number; z: number }[] {
  return walls
    .filter((w) => {
      const dx = w.end_point.x - w.start_point.x
      const dz = w.end_point.z - w.start_point.z
      return Math.hypot(dx, dz) >= 0.01
    })
    .map((w) => ({ x: w.start_point.x, z: w.start_point.z }))
}

export function FloorplanCadOverlay(): ReactElement | null {
  const resolved = useCanonicalSceneStore((s) => s.resolved)

  const wallPolygon = useMemo<{ x: number; z: number }[] | null>(() => {
    if (!resolved) return null
    const pts = wallCenterlinePolygon(resolved.walls)
    if (pts.length < 3) return null
    return pts
  }, [resolved])

  const floorShape = useMemo<Shape | null>(() => {
    // Fallback: Wall-Polygon wenn vorhanden (kongruent mit Layer 3), sonst
    // floor.polygon — letzteres nur als Notfall wenn Walls degeneriert sind.
    const poly = wallPolygon
      ?? (resolved && resolved.floor.polygon.length >= 3
        ? resolved.floor.polygon.map((p) => ({ x: p.x, z: p.z }))
        : null)
    if (!poly) return null
    const shape = new Shape()
    // World-Z negiert (siehe buildWallQuad-Convention) damit Floor + Walls +
    // HTML-Labels alle im selben Welt-Frame liegen.
    poly.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, -p.z)
      else shape.lineTo(p.x, -p.z)
    })
    shape.closePath()
    return shape
  }, [resolved, wallPolygon])

  const wallQuads = useMemo<WallQuad[]>(() => {
    if (!resolved) return []
    return resolved.walls
      .map((w) => buildWallQuad(w))
      .filter((q): q is WallQuad => q !== null)
  }, [resolved])

  // R11-D: Openings (Türen + Fenster) als Overlay auf Wand-Quads. Wand
  // bleibt darunter sichtbar — der Overlay übermalt das Wand-Segment im
  // jeweiligen Element-Look (beige=Tür-Cutout, hellblau=Fenster). Bei
  // Türen kommt zusätzlich ein Schwingbogen.
  const openingOverlays = useMemo<OpeningOverlay[]>(() => {
    if (!resolved) return []
    const overlays: OpeningOverlay[] = []
    for (const wall of resolved.walls) {
      for (const opening of wall.openings ?? []) {
        const ov = buildOpeningOverlay(wall, opening)
        if (ov) overlays.push(ov)
      }
    }
    return overlays
  }, [resolved])

  // R11-D: North-Arrow-Daten (oben rechts vom Raum, im AABB-extent + Margin).
  // Wir rendern den Arrow als HTML-Overlay damit Pixel-Sharpness erhalten
  // bleibt. AABB wird hier nur als Hint für Positioning berechnet — aber
  // weil wir absolute screen-Positionierung im HUD wollen, machen wir den
  // Arrow als CSS-Overlay aus dem Hub-Surrounding-DOM, nicht hier.

  const roomMeta = useMemo<{
    label: string
    centroid: { x: number; z: number }
  } | null>(() => {
    const poly = wallPolygon
      ?? (resolved && resolved.floor.polygon.length >= 3
        ? resolved.floor.polygon.map((p) => ({ x: p.x, z: p.z }))
        : null)
    if (!poly) return null
    const area = polygonArea(poly)
    const centroid = polygonCentroid(poly)
    return {
      label: `Raum · ${area.toFixed(1).replace('.', ',')} m²`,
      centroid,
    }
  }, [resolved, wallPolygon])

  if (!resolved) return null

  return (
    <group name="floorplan-cad-overlay">
      {/* Layer 2 · Floor-Quad: warmer als Background, klar abgegrenzt */}
      {floorShape && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.005, 0]}
          renderOrder={1}
        >
          <shapeGeometry args={[floorShape]} />
          <meshBasicMaterial color={FLOOR_FILL} toneMapped={false} side={DoubleSide} />
        </mesh>
      )}

      {/* Layer 2b · Floor-Outline ENTFERNT (R9): die Outline auf
          floor.polygon und die Wand-Quads auf wall.start/end_point liegen um
          ~Wandstärke parallel versetzt zueinander → "zwei Grundrisse"-
          Effekt. Die Wand-Quads sind die kanonische Raumgrenze. */}

      {/* Layer 3 · Walls als 2D-Quads mit CAD-Strichstärke — Hauptelement */}
      {wallQuads.map((q) => (
        <mesh
          key={q.id}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.012, 0]}
          renderOrder={3}
        >
          <shapeGeometry args={[q.shape]} />
          <meshBasicMaterial color={WALL_FILL} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}

      {/* Layer 3.5 · Openings (R11-D): Türen + Fenster als Overlay auf den
          Wand-Quads. Beige für Tür (matches Floor), hellblau für Fenster.
          Schwingbogen-Linie nur bei Türen. */}
      {openingOverlays.map((ov) => (
        <group key={`opening-${ov.id}`}>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.014, 0]}
            renderOrder={4}
          >
            <shapeGeometry args={[ov.shape]} />
            <meshBasicMaterial
              color={ov.type === 'window' ? OPENING_WINDOW_FILL : OPENING_DOOR_FILL}
              toneMapped={false}
              side={DoubleSide}
            />
          </mesh>
          {/* Schwingbogen (nur Tür). drei `<Line>` ist hair-line — keine
              Mesh-Tessellation nötig. */}
          {ov.arc && (
            <Line
              points={discretizeArc(ov.arc, 0.016)}
              color={OPENING_ARC_COLOR}
              lineWidth={1.2}
              transparent
              opacity={0.6}
              depthTest={false}
            />
          )}
        </group>
      ))}

      {/* Layer 4 · Maß-Bubbles INNEN am Raum-Innenraum (R10 Fix-Up): vorher
          perpendicular nach aussen — sass aber genau dort wo der alte Floor-
          Polygon-Outline-Effekt war (RoomPlan-Polygon = Aussenrand inkl.
          Wanddicke, ~7.5 cm aussen der Wall-Mittelachse). Maße landeten damit
          optisch "neben" dem neuen Wand-Layer. Fix: Offset zum Raum-Centroid
          hin, sodass die Maße im Innenraum sitzen — robust gegen CCW/CW-
          Wand-Reihenfolge weil der Centroid immer innen ist. */}
      {roomMeta && resolved.walls.map((wall) => {
        const sx = wall.start_point.x
        const sz = wall.start_point.z
        const ex = wall.end_point.x
        const ez = wall.end_point.z
        const dx = ex - sx
        const dz = ez - sz
        const len = Math.hypot(dx, dz)
        if (len < 0.2) return null
        const mx = (sx + ex) / 2
        const mz = (sz + ez) / 2
        const toCentroidX = roomMeta.centroid.x - mx
        const toCentroidZ = roomMeta.centroid.z - mz
        const toCentroidLen = Math.hypot(toCentroidX, toCentroidZ)
        if (toCentroidLen < 0.01) return null
        const inwardX = toCentroidX / toCentroidLen
        const inwardZ = toCentroidZ / toCentroidLen
        // 6 cm vom Wand-Innenrand hineinrücken — Pille verdeckt die Wand
        // nicht und liegt im Raum-Innenraum direkt am Wall-Layer.
        const labelOffset = planWallThickness(wall) / 2 + 0.06
        return (
          <Html
            key={`label-${wall.id}`}
            position={[
              mx + inwardX * labelOffset,
              0.02,
              mz + inwardZ * labelOffset,
            ]}
            center
            distanceFactor={1}
            style={{
              pointerEvents: 'none',
              userSelect: 'none',
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '0.01em',
              color: '#1F2937',
              background: 'rgba(255,255,255,0.94)',
              padding: '2px 7px',
              borderRadius: '4px',
              border: '0.8px solid #E2E8F0',
              boxShadow: '0 1px 2px rgba(15,23,42,0.08)',
              whiteSpace: 'nowrap',
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            }}
          >
            {len.toFixed(2).replace('.', ',')} m
          </Html>
        )
      })}

      {/* Layer 5 · Center Room-Label */}
      {roomMeta && (
        <Html
          position={[roomMeta.centroid.x, 0.02, roomMeta.centroid.z]}
          center
          distanceFactor={1}
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: ROOM_LABEL_COLOR,
            whiteSpace: 'nowrap',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            textShadow: '0 1px 2px rgba(255,255,255,0.7)',
          }}
        >
          {roomMeta.label}
        </Html>
      )}

      {/* Layer 6 · North-Arrow (R11-D): kompass-Indikator oben-rechts vom
          Raum. Position relativ zum Wall-Polygon-AABB; im floorplan-Y'-Frame.
          Norden = -Z im World → +Z in floorplan-frame. Pfeil zeigt nach UP
          (CSS-Up = -Z in floorplan). */}
      {wallPolygon && (() => {
        let maxX = -Infinity
        let minZ = Infinity
        for (const p of wallPolygon) {
          if (p.x > maxX) maxX = p.x
          if (p.z < minZ) minZ = p.z
        }
        // Position: rechts oben außerhalb des Raums (0.6m Margin).
        return (
          <Html
            position={[maxX + 0.6, 0.02, -(minZ - 0.6)]}
            center
            distanceFactor={1}
            style={{
              pointerEvents: 'none',
              userSelect: 'none',
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
              }}
            >
              <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
                <circle
                  cx="12"
                  cy="12"
                  r="11"
                  fill="rgba(255,255,255,0.85)"
                  stroke="#1F2937"
                  strokeWidth="0.7"
                />
                {/* Arrow nach oben (North) */}
                <path
                  d="M12 4 L15 13 L12 11 L9 13 Z"
                  fill="#1F2937"
                />
              </svg>
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  color: '#1F2937',
                  letterSpacing: '0.05em',
                }}
              >
                N
              </span>
            </div>
          </Html>
        )
      })()}
    </group>
  )
}

export default FloorplanCadOverlay
