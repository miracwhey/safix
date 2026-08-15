/**
 * Spatial Core · Phase 2 · 3-Layer Hybrid Capture
 *
 * Read-only mesh-classification harvester that polls the ARSession owned by
 * `RoomCaptureSession` instead of running a second AR session. Apple permits
 * only one ARSession per process — multicasting `RoomCaptureSession.arSession`
 * via a custom delegate would break RoomPlan's internal state machine, so we
 * sample `arSession.currentFrame.anchors` from a timer instead.
 *
 * Acceptance per Phase 2 plan (~/.claude/plans/spatial-v1-consolidation-plan.md):
 *   - iPhone 12 Mini (no LiDAR)  → no mesh anchors, summary nil, no crash
 *   - iPhone 15 Pro              → ≥25 FPS sustained, RSS <500 MB, mesh summary
 *   - iPad Pro M2 (80m² / 3min)  → ≥20 FPS, RSS <650 MB, thermal-throttle fires
 *
 * Threading: all mutation happens on the private serial queue. `snapshot()`
 * is the only method safe to call from the main thread; it hops onto the
 * queue synchronously to read the latest aggregate. The tick body grabs a
 * `currentFrame` reference into a local before walking `.anchors` so an
 * internal ARSession frame swap can't yank the NSArray out from under the
 * iteration — and the work runs inside `autoreleasepool` so the per-tick
 * copies don't pile up on the utility queue.
 */

import Foundation
import ARKit

/// Apple `ARMeshClassification` raw values are stable since iOS 13.4 and
/// shared between iOS / iPadOS. The enum is consumed only by the iOS-17-
/// gated harvester below; the `@available` guard would be dead code so we
/// omit it for brevity.
enum MeshClassification: Int, CaseIterable {
    case none    = 0
    case wall    = 1
    case floor   = 2
    case ceiling = 3
    case table   = 4
    case seat    = 5
    case window  = 6
    case door    = 7

    /// Stable string key used in the JSON payload (matches `MeshClassification`
    /// in `packages/capacitor-roomplan/src/definitions.ts`).
    var jsonKey: String {
        switch self {
        case .none:    return "none"
        case .wall:    return "wall"
        case .floor:   return "floor"
        case .ceiling: return "ceiling"
        case .table:   return "table"
        case .seat:    return "seat"
        case .window:  return "window"
        case .door:    return "door"
        }
    }

    /// Index into a fixed-size per-tick counter array. Beats a fresh
    /// `[MeshClassification: Int]` allocation per anchor per tick — at
    /// ~50 anchors × 5k faces × 10 Hz that's millions of dict allocs/sec.
    var counterIndex: Int { rawValue }

    static let counterArrayLength = 8
}

@available(iOS 17.0, *)
final class MeshClassificationHarvester {

    // MARK: - Public summary type

    /// Final aggregate emitted to JS once at scan finish. Serialised as the
    /// `meshClassification` field of `RoomScanResult` and persisted to
    /// `mesh_summary.json` in the `project-scans` bucket.
    struct Summary {
        let anchorCount: Int
        let totalFaces: Int
        let classFaces: [MeshClassification: Int]
        /// `wallFaces / totalFaces` clamped to [0, 1]; 0 when `totalFaces == 0`.
        let wallCoverageRatio: Double
        /// True when mesh polling was paused at thermal `.critical` AT ANY
        /// POINT during the scan (not at start — see `start()`). Sticky once
        /// flipped because the data gap during pause is not retroactively
        /// fillable. Quality Engine treats `degraded=true` as "ignore R6 /
        /// R7 weights" to avoid penalising a hot device.
        let degraded: Bool
        /// Worst thermal state observed by the harvester for the duration
        /// of the scan (NOT the state at snapshot time). Honest about how
        /// hot the device got even if it cooled before finish.
        let thermalStateAtSnapshot: String
        let samplesCollected: Int
        /// Anchors observed during the scan that exposed mesh geometry but
        /// no `classification` buffer — surfaces an Apple/RoomPlan config
        /// gap so Quality Engine can tell "we ran R6/R7 and got zero walls"
        /// apart from "the mesh wasn't classified at all".
        let anchorsWithoutClassification: Int
        let durationSec: Double
        /// `samplesCollected / durationSec`. Honest about throttle effect:
        /// drops from ≈10 → ≈2 under thermal `.serious`, 0 when paused.
        /// Zero when `durationSec` is 0 (no divide-by-zero leak).
        let avgPollHz: Double

        /// Builds the JSON dict serialised back to JS. Keys are stable —
        /// mirror to `MeshClassification` in `definitions.ts`.
        func toJSON() -> [String: Any] {
            var classFacesJson: [String: Int] = [:]
            for cls in MeshClassification.allCases {
                classFacesJson[cls.jsonKey] = classFaces[cls] ?? 0
            }
            // Emit durationSec as Double so callers can recompute throughput
            // without losing sub-second precision on short scans.
            return [
                "anchorCount": anchorCount,
                "totalFaces": totalFaces,
                "classFaces": classFacesJson,
                "wallCoverageRatio": (round(wallCoverageRatio * 10000) / 10000),
                "degraded": degraded,
                "thermalStateAtSnapshot": thermalStateAtSnapshot,
                "samplesCollected": samplesCollected,
                "anchorsWithoutClassification": anchorsWithoutClassification,
                "durationSec": (round(durationSec * 1000) / 1000),
                "avgPollHz": (round(avgPollHz * 100) / 100),
            ]
        }
    }

    // MARK: - State (mutated only on `queue`)

    private weak var session: ARSession?
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "fixup.mesh.harvester", qos: .utility)

    private var samplesCollected: Int = 0
    private var anchorsWithoutClassification: Int = 0
    private var startedAt: Date?
    private var lastSnapshot: [UUID: AnchorSummary] = [:]
    private var thermalObserver: NSObjectProtocol?
    private var currentIntervalSec: TimeInterval = 0.1
    private var paused: Bool = false
    private var degraded: Bool = false
    /// Tracks the highest thermal severity seen during the scan so the
    /// reported state is honest about peak load even when the device
    /// cooled before snapshot time. `.nominal = 0 < .fair < .serious < .critical`.
    private var maxThermalRank: Int = 0

    /// Per-anchor aggregate cached between ticks so the snapshot dict shrinks
    /// when ARKit removes an anchor, instead of holding stale data forever.
    private struct AnchorSummary {
        let totalFaces: Int
        /// Fixed-size counter array indexed by `MeshClassification.counterIndex`.
        /// Stack-friendly (8 ints) vs a per-tick `[MeshClassification: Int]` —
        /// at 10 Hz × ~50 anchors a dict alloc storm dominated the utility
        /// queue under load.
        let classCounters: [Int]
    }

    // MARK: - Lifecycle

    init() {}

    deinit {
        // Belt-and-braces — `stop()` is the documented teardown path but a
        // controller torn down through a non-standard route (parent dealloc
        // mid-animation) must not leave the timer + observer dangling.
        timer?.cancel()
        if let observer = thermalObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// Begin polling the supplied ARSession. Safe to call from main; all
    /// state mutation happens on the private queue. Idempotent — a second
    /// `start()` resets the aggregate.
    ///
    /// Note on initial thermal: the state at start is used to size the
    /// polling cadence but does NOT set `degraded`. `degraded` is reserved
    /// for thermal transitions observed DURING the scan — otherwise a
    /// device that briefly hit `.critical` 30 s before the scan started
    /// would falsely poison R6/R7 for the entire session.
    func start(session: ARSession) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.session = session
            self.samplesCollected = 0
            self.anchorsWithoutClassification = 0
            self.startedAt = Date()
            self.lastSnapshot.removeAll()
            self.paused = false
            self.degraded = false
            let initial = ProcessInfo.processInfo.thermalState
            self.maxThermalRank = Self.thermalRank(initial)
            self.observeThermalLocked()
            self.applyThermalLocked(initial, isInitialRead: true)
            self.startTimerLocked()
        }
    }

    /// Stop polling and release the ARSession reference. Idempotent.
    func stop() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.stopTimerLocked()
            self.stopThermalObserverLocked()
            self.session = nil
        }
    }

    /// Snapshot the latest aggregate. Returns `nil` if no mesh frames were
    /// ever observed (e.g. non-LiDAR device, harvester never started).
    /// Synchronous to keep `didPresent` straight-line readable; the queue
    /// hop is fast because reads only touch a small in-memory dict.
    func snapshot() -> Summary? {
        var result: Summary?
        queue.sync {
            // Even if the snapshot dict is empty, we still surface a summary
            // when at least one frame was inspected — Quality Engine treats
            // "0 faces / N samples" differently from "no harvester run".
            guard self.startedAt != nil, self.samplesCollected > 0 else { return }
            result = self.makeSummaryLocked()
        }
        return result
    }

    // MARK: - Timer (mutate on `queue` only)

    private func startTimerLocked() {
        stopTimerLocked()
        let t = DispatchSource.makeTimerSource(queue: queue)
        // Leeway = 50% of interval — saves battery, mesh aggregation
        // tolerates jitter (Quality Engine reads an average over many ticks).
        t.schedule(
            deadline: .now() + currentIntervalSec,
            repeating: currentIntervalSec,
            leeway: .milliseconds(Int(currentIntervalSec * 1000 * 0.5))
        )
        t.setEventHandler { [weak self] in self?.tickLocked() }
        t.resume()
        timer = t
    }

    private func stopTimerLocked() {
        timer?.cancel()
        timer = nil
    }

    private func tickLocked() {
        guard !paused, let session = session else { return }
        // Capture currentFrame into a local before walking `.anchors`. ARKit
        // can swap the session's internal frame between the property read
        // and the array access — without the local, the NSArray we iterate
        // could be backed by a buffer ARKit recycles mid-loop. The synchronous
        // bytes copy further down is the other half of the race-safety story.
        guard let frame = session.currentFrame else { return }
        autoreleasepool {
            var meshAnchors: [ARMeshAnchor] = []
            meshAnchors.reserveCapacity(frame.anchors.count)
            for anchor in frame.anchors {
                if let mesh = anchor as? ARMeshAnchor {
                    meshAnchors.append(mesh)
                }
            }
            if meshAnchors.isEmpty {
                // Count the empty sample so the avgPollHz field stays honest
                // (we polled, mesh just had nothing yet).
                samplesCollected += 1
                return
            }
            var snapshot: [UUID: AnchorSummary] = [:]
            var noClassThisTick = 0
            for anchor in meshAnchors {
                let agg = aggregate(anchor: anchor, noClassCounter: &noClassThisTick)
                snapshot[anchor.identifier] = agg
            }
            lastSnapshot = snapshot
            // `anchorsWithoutClassification` is a rolling per-tick max, not
            // a sum — counting per tick would overcount because the same
            // anchor would be flagged on every poll. Surface the worst tick
            // so the consumer sees "at one point we saw N anchors lacking
            // classification" without inflating with poll frequency.
            if noClassThisTick > anchorsWithoutClassification {
                anchorsWithoutClassification = noClassThisTick
            }
            samplesCollected += 1
        }
    }

    private func aggregate(
        anchor: ARMeshAnchor,
        noClassCounter: inout Int,
    ) -> AnchorSummary {
        let geometry = anchor.geometry
        let faceCount = geometry.faces.count
        guard faceCount > 0, let classification = geometry.classification else {
            if faceCount > 0 {
                noClassCounter += 1
            }
            return AnchorSummary(
                totalFaces: faceCount,
                classCounters: Array(repeating: 0, count: MeshClassification.counterArrayLength),
            )
        }
        // Synchronous copy of the classification buffer — ARKit can recycle
        // the underlying MTLBuffer on the next frame; iterating the live
        // pointer is UB. Same race-safety pattern as the D-spike harvester.
        let snapshot = Data(
            bytes: classification.buffer.contents(),
            count: faceCount
        )
        var counters = Array(repeating: 0, count: MeshClassification.counterArrayLength)
        for byte in snapshot {
            let idx = Int(byte)
            if idx >= 0 && idx < counters.count {
                counters[idx] += 1
            } else {
                counters[MeshClassification.none.counterIndex] += 1
            }
        }
        return AnchorSummary(totalFaces: faceCount, classCounters: counters)
    }

    private func makeSummaryLocked() -> Summary {
        var anchorCount = 0
        var totalFaces = 0
        var combinedCounters = Array(repeating: 0, count: MeshClassification.counterArrayLength)
        for (_, s) in lastSnapshot {
            anchorCount += 1
            totalFaces += s.totalFaces
            for i in 0..<combinedCounters.count {
                combinedCounters[i] += s.classCounters[i]
            }
        }
        var classFaces: [MeshClassification: Int] = [:]
        for cls in MeshClassification.allCases {
            classFaces[cls] = combinedCounters[cls.counterIndex]
        }
        let wallFaces = classFaces[.wall, default: 0]
        let ratio = totalFaces == 0 ? 0 : Double(wallFaces) / Double(totalFaces)
        let clampedRatio = max(0.0, min(1.0, ratio))
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        // Guard against divide-by-zero / NaN propagation on instant-finish
        // (start → snapshot within sub-tick). Consumers should never see
        // Infinity or NaN here even though JSON.stringify would map them
        // to null silently.
        let avgHz: Double = duration > 0 ? Double(samplesCollected) / duration : 0
        return Summary(
            anchorCount: anchorCount,
            totalFaces: totalFaces,
            classFaces: classFaces,
            wallCoverageRatio: clampedRatio,
            degraded: degraded,
            thermalStateAtSnapshot: Self.thermalLabel(Self.thermalStateFromRank(maxThermalRank)),
            samplesCollected: samplesCollected,
            anchorsWithoutClassification: anchorsWithoutClassification,
            durationSec: duration,
            avgPollHz: avgHz
        )
    }

    // MARK: - Thermal throttle

    private func observeThermalLocked() {
        guard thermalObserver == nil else { return }
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            let state = ProcessInfo.processInfo.thermalState
            // Transition notifications NEVER carry isInitialRead=true; they
            // are real in-scan thermal changes that may need to flip
            // `degraded` if they include `.critical`.
            self?.queue.async { self?.applyThermalLocked(state, isInitialRead: false) }
        }
    }

    private func stopThermalObserverLocked() {
        if let observer = thermalObserver {
            NotificationCenter.default.removeObserver(observer)
            thermalObserver = nil
        }
    }

    /// Maps thermal state to polling cadence. `degraded` flips to true only
    /// when `.critical` is observed AS A TRANSITION during the scan — never
    /// from the initial read at `start()`. Once `.critical` triggers it, it
    /// stays true for the remainder of the scan even if the device cools
    /// (Quality Engine needs to know the mesh data is incomplete; the gap
    /// left during pause is not retroactively fillable from RoomPlan's own
    /// state).
    private func applyThermalLocked(_ state: ProcessInfo.ThermalState, isInitialRead: Bool) {
        let previous = currentIntervalSec
        switch state {
        case .nominal, .fair:
            currentIntervalSec = 0.1  // 10 Hz
            paused = false
        case .serious:
            currentIntervalSec = 0.5  // 2 Hz
            paused = false
        case .critical:
            currentIntervalSec = 0.5  // keep timer alive to react to recovery
            paused = true
            if !isInitialRead {
                degraded = true
            }
        @unknown default:
            currentIntervalSec = 0.1
            paused = false
        }
        let rank = Self.thermalRank(state)
        if rank > maxThermalRank {
            maxThermalRank = rank
        }
        if timer != nil && previous != currentIntervalSec {
            startTimerLocked()
        }
    }

    private static func thermalLabel(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal:  return "nominal"
        case .fair:     return "fair"
        case .serious:  return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }

    private static func thermalRank(_ state: ProcessInfo.ThermalState) -> Int {
        switch state {
        case .nominal:  return 0
        case .fair:     return 1
        case .serious:  return 2
        case .critical: return 3
        @unknown default: return 0
        }
    }

    private static func thermalStateFromRank(_ rank: Int) -> ProcessInfo.ThermalState {
        switch rank {
        case 0: return .nominal
        case 1: return .fair
        case 2: return .serious
        case 3: return .critical
        default: return .nominal
        }
    }
}
