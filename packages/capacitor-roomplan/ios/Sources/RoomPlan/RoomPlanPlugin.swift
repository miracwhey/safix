import Foundation
import Capacitor
import ARKit
import AVFoundation
// Day 9 B15: RoomPlan import needed for the `as? CapturedRoom` cast inside
// the iOS-17-gated `getCanonicalScene` method. The `lastCapturedRoom`
// stored property itself remains `AnyObject?` so the property declaration
// doesn't require an iOS-17 type — only the runtime cast does.
import RoomPlan

@objc(RoomPlanPlugin)
public class RoomPlanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomPlanPlugin"
    public let jsName = "RoomPlan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        // Day 9 B15: iOS-native canonical converter. JS-side definitions in
        // `packages/capacitor-roomplan/src/definitions.ts` are a Day-9
        // follow-up (see TODO on `getCanonicalScene` below).
        CAPPluginMethod(name: "getCanonicalScene", returnType: CAPPluginReturnPromise),
    ]

    private var telemetryObserver: NSObjectProtocol?

    // Day 9 B15: cache the most-recently-completed `CapturedRoom` so the
    // canonical converter can run against it without forcing the user to
    // re-scan. Stored as `AnyObject?` (audit feedback
    // `feedback_swift_ios17_stored_property_anyobject`): typing the property
    // directly as `CapturedRoom?` would require an `@available(iOS 17.0, *)`
    // gate on the property declaration itself, which Swift does not allow for
    // stored properties — `AnyObject?` keeps the property loadable on iOS 16
    // and we cast at the call-site behind an `if #available` guard.
    private var lastCapturedRoom: AnyObject?

    override public func load() {
        // Phase 1: forward native scan lifecycle events to JS as
        // `roomScanTelemetry` listener notifications. Lets the web side
        // emit Sentry breadcrumbs + console.log entries for every state
        // transition (scan_started → walls_changed → finish_revealed →
        // finish_tapped → should_present → did_present → dismiss_reason).
        telemetryObserver = NotificationCenter.default.addObserver(
            forName: Telemetry.notificationName,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self, let payload = note.userInfo as? [String: Any] else { return }
            // Sanitize: only forward JSON-safe scalars to JS.
            let safe = payload.mapValues { value -> Any in
                switch value {
                case let v as String:   return v
                case let v as Int:      return v
                case let v as Double:   return v
                case let v as Bool:     return v
                default:                return String(describing: value)
                }
            }
            self.notifyListeners("roomScanTelemetry", data: safe)
        }
    }

    deinit {
        if let observer = telemetryObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @objc func checkAvailability(_ call: CAPPluginCall) {
        let available = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        call.resolve(["available": available])
    }

    @objc func startScan(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else {
            call.reject("ROOMPLAN_V2_UNAVAILABLE", "LiDAR scanner not available on this device")
            return
        }

        // Phase 1: surface camera-permission denial as a distinct error so JS
        // can show a Settings-Deep-Link toast instead of a generic SCAN_FAILED.
        // RoomCaptureSession would otherwise either silently fail to start or
        // produce a confusing ARKit error.
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            call.reject("CAMERA_PERMISSION_DENIED", "Kamera-Zugriff verweigert. Bitte in den iOS-Einstellungen aktivieren.")
            return
        case .notDetermined, .authorized:
            break  // .notDetermined → iOS will show the system prompt
        @unknown default:
            break
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let presentingVC = self.bridge?.viewController else {
                call.reject("NO_VIEW_CONTROLLER", "Could not find presenting view controller")
                return
            }

            let scanVC = RoomScanViewController()
            scanVC.modalPresentationStyle = .fullScreen
            // Day 9 B15: cache the finished CapturedRoom so a subsequent
            // `getCanonicalScene` call can run the iOS-native converter
            // against it without forcing a re-scan.
            scanVC.onCapturedRoom = { [weak self] room in
                self?.lastCapturedRoom = room
            }
            // Phase 1: idempotency — Apple can fire shouldPresent + didPresent
            // with errors back-to-back and our watchdog can race natural
            // completion. The VC's fireComplete() is single-shot, but guard
            // here too so a hypothetical re-entry can't double-resolve the
            // call (Capacitor logs warnings and JS sees only the first).
            var didReply = false
            scanVC.onComplete = { result in
                guard !didReply else { return }
                didReply = true
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .failure(let error):
                    let code = Self.errorCode(for: error)
                    call.reject(code, error.localizedDescription)
                }
            }
            presentingVC.present(scanVC, animated: true)
        }
    }

    // Day 9 B15: iOS-native canonical converter entrypoint. Runs
    // `CanonicalConverter` against the most-recently-cached `CapturedRoom`
    // and resolves the call with a `[String: Any]` matching the canonical
    // `parametric.json` wire shape. Lets the iOS layer skip the round-trip
    // through Block-A's persistence + the TS bridge for fresh scans.
    //
    // JS-side definitions live in `packages/capacitor-roomplan/src/
    // definitions.ts` (GetCanonicalSceneArgs / GetCanonicalSceneResult /
    // GetCanonicalSceneErrorCode) and `src/web.ts` (web stub that throws
    // `unavailable`).
    //
    // Reject codes:
    //   - `CANONICAL_CONVERT_NO_SCAN`  : no cached `CapturedRoom`
    //     (`startScan` has not completed since plugin load).
    //   - `CANONICAL_CONVERT_FAILED`   : converter threw.
    //   - `ROOMPLAN_V2_UNAVAILABLE`          : iOS < 17 (RoomPlan-typed inputs
    //     require iOS 17 — guard documented on `lastCapturedRoom`).
    @objc func getCanonicalScene(_ call: CAPPluginCall) {
        guard let scanId = call.getString("scanId"), !scanId.isEmpty else {
            call.reject("CANONICAL_CONVERT_FAILED", "Missing required arg: scanId")
            return
        }
        let jobId = call.getString("jobId")
        let projectId = call.getString("projectId")

        guard #available(iOS 17.0, *) else {
            call.reject(
                "ROOMPLAN_V2_UNAVAILABLE",
                "Canonical converter requires iOS 17.0 or newer"
            )
            return
        }
        guard let cached = lastCapturedRoom,
              let capturedRoom = cached as? CapturedRoom else {
            call.reject(
                "CANONICAL_CONVERT_NO_SCAN",
                "No cached CapturedRoom — call startScan first"
            )
            return
        }

        do {
            let converter = CanonicalConverter()
            let document = try converter.convert(
                capturedRoom: capturedRoom,
                scanId: scanId,
                jobId: jobId,
                projectId: projectId
            )
            call.resolve(["document": document])
        } catch {
            call.reject(
                "CANONICAL_CONVERT_FAILED",
                "Canonical converter failed: \(error.localizedDescription)"
            )
        }
    }

    /// Maps RoomScanError cases (and a few Apple ARKit errors) to stable JS-
    /// facing codes. Web side branches on these to decide toast severity vs
    /// silent state-reset vs retry-prompt.
    private static func errorCode(for error: Error) -> String {
        if let scanError = error as? RoomScanError {
            switch scanError {
            case .cancelled:                  return "SCAN_CANCELLED"
            case .backgroundedDuringCapture:  return "SCAN_BACKGROUNDED"
            case .processingTimeout:          return "SCAN_PROCESSING_TIMEOUT"
            case .insufficientData:           return "SCAN_INSUFFICIENT_DATA"
            }
        }
        return "SCAN_FAILED"
    }
}
