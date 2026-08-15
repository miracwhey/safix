import Foundation
import ARKit
import UIKit

/// Captures device + sensor facts that are useful for forensics + Quality
/// Engine input. Cheap to construct (~1ms) — invoked once per scan, before
/// the RoomCaptureSession starts.
///
/// Mirrors `ScanDeviceMeta` in `src/lib/spatial/types.ts`. Adding a field
/// here requires no migration (`scans.device_meta` is a free-form jsonb).
enum DeviceMetaCollector {

    /// Builds a JSON-friendly dictionary with the 7 fields the TS domain
    /// already knows about. Missing fields are omitted (jsonb-friendly).
    static func snapshot() -> [String: Any] {
        var out: [String: Any] = [:]
        out["deviceModel"] = UIDevice.current.modelIdentifier
        out["osVersion"] = UIDevice.current.systemVersion
        if let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            out["appVersion"] = appVersion
        }
        out["hasLidar"] = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        out["arkitVersion"] = arkitVersion()
        out["thermalState"] = thermalStateLabel(ProcessInfo.processInfo.thermalState)
        // fpsSample is plugin-supplied at scan-end; collected from CADisplayLink
        // during capture. Not part of the cheap pre-scan snapshot.
        return out
    }

    private static func arkitVersion() -> String {
        // ARKit does not expose a numeric version; use the iOS minor version
        // as a proxy (ARKit's feature releases track iOS major.minor 1:1).
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "ARKit/\(v.majorVersion).\(v.minorVersion)"
    }

    private static func thermalStateLabel(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal:  return "nominal"
        case .fair:     return "fair"
        case .serious:  return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }
}

private extension UIDevice {
    /// Returns the hardware identifier (e.g. "iPhone15,3" for iPhone 14 Pro Max)
    /// which is far more useful for forensics than the marketing name. Apple's
    /// `name` returns a user-customisable string on iOS 16+ so it cannot be
    /// trusted for telemetry.
    var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { acc, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            acc.append(Character(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? model : identifier
    }
}
