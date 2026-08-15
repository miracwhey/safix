import UIKit
import RoomPlan
import simd

final class RoomScanViewController: UIViewController {

    var onComplete: ((Result<[String: Any], Error>) -> Void)?

    // Day 9 B15: hand the finished `CapturedRoom` back to the plugin so the
    // iOS-native canonical converter can run against it later via
    // `getCanonicalScene` without re-scanning. Typed as `AnyObject?` for the
    // same iOS-17-stored-property reason documented on the plugin's
    // `lastCapturedRoom` field — Swift can't `@available` a stored property
    // type. The plugin casts back behind an `if #available(iOS 17.0, *)`
    // guard at the call site.
    var onCapturedRoom: ((AnyObject) -> Void)?

    private var captureView: RoomCaptureView!
    private var cancelButton: UIButton!
    private var overlayCard: UIVisualEffectView!

    // Overlay sub-views
    private var activityIndicator: UIActivityIndicatorView!
    private var instructionLabel: UILabel!
    private var surfaceLabel: UILabel!
    private var separatorView: UIView!
    private var finishButton: UIButton!
    private var hintLabel: UILabel!

    // Wall count only ever increases — prevents bar jumping when LiDAR
    // re-evaluates and temporarily removes walls mid-scan.
    private var maxWallsSeen = 0
    private var finishVisible = false

    // Guards viewWillDisappear from stopping the session when Apple's
    // review screen slides in on top (which also fires that lifecycle).
    private var isProcessing = false

    // Phase 1: 90s safety net so the user always gets a Fertig button even
    // when RoomPlan never reaches the strict walls>=3 reveal threshold (e.g.
    // open lofts, hallways, low-texture/poorly-lit rooms). Fires once per
    // session and force-reveals the finish UI with a warning hint.
    private var finishForceRevealTimer: Timer?
    // Phase 1: 30s watchdog so a hung Apple processing window can't trap the
    // user on a frozen "Wird verarbeitet…" screen. Started in finishTapped,
    // cancelled in didPresent. On expiry: dismiss + processingTimeout error.
    private var processingTimeoutTimer: Timer?
    // Phase 1: idempotency guard — Apple can fire shouldPresent + didPresent
    // both with errors, or our own watchdog can race the natural completion.
    // Single-shot onComplete protects the JS-side from "Promise resolved twice".
    private var didCompleteOnce = false

    // ── Block B.1 telemetry ─────────────────────────────────────────────────
    // Captured once at viewDidAppear and folded into the payload so callers
    // can persist scan.device_meta + audit forensics in the Spatial domain.
    private var deviceMeta: [String: Any] = [:]
    // CADisplayLink samples render FPS over a rolling window. Used for the
    // fpsSample field in ScanDeviceMeta — Quality Engine input + UX gates.
    private var displayLink: CADisplayLink?
    private var fpsFrameCount: Int = 0
    private var fpsWindowStart: CFTimeInterval = 0
    private var fpsRollingAvg: Double = 0
    private var captureStartedAt: Date?

    // ── Phase 2: 3-Layer Hybrid mesh harvester ──────────────────────────────
    // Typed as AnyObject so we can hold the iOS 17+ MeshClassificationHarvester
    // without breaking the iOS 16 deployment target. Re-cast inside the
    // `if #available(iOS 17.0, *)` branches that actually use it. Same
    // workaround as Block E1 (see [[feedback_swift_ios17_stored_property_anyobject]]).
    private var meshHarvester: AnyObject?
    // Throttle for the "mesh memory warning" telemetry — fires at most once
    // every 5 s when phys_footprint crosses 700 MB. Quality Engine uses
    // `degraded=true` to gate R6/R7 weights, the warning telemetry surfaces
    // the same condition to Sentry breadcrumbs for forensics.
    private var lastMemoryWarnAt: CFTimeInterval = 0

    /// Feature flag: hybrid mesh capture default ON, gated by iOS 17+ at
    /// runtime. Set to OFF via either of:
    ///   * `defaults write … SPATIAL_HYBRID_MESH_ENABLED -bool NO`
    ///   * `defaults write … SPATIAL_HYBRID_MESH_ENABLED -int 0`
    /// as a hotfix lever if Crash-Reports surface a mesh-poll-related issue.
    private static var hybridMeshEnabled: Bool {
        let defaults = UserDefaults.standard
        // `object(forKey:) as? Bool` only matches values written via `-bool`;
        // an ops engineer using `-int 0` would silently fall back to default
        // ON, defeating the hotfix lever. Use the explicit presence check +
        // `bool(forKey:)` which honours both encodings via NSNumber bridging.
        guard defaults.object(forKey: "SPATIAL_HYBRID_MESH_ENABLED") != nil else {
            return true
        }
        return defaults.bool(forKey: "SPATIAL_HYBRID_MESH_ENABLED")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)

        setupCancelButton()
        setupGuidanceOverlay()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        activityIndicator.startAnimating()
        // Block B.1: snapshot device facts once before the heavy session starts.
        deviceMeta = DeviceMetaCollector.snapshot()
        captureStartedAt = Date()
        startFpsSampler()
        // Post-review P0-2: stop the session cleanly when the user backgrounds
        // the app mid-scan. Without this, ARSession loses tracking on resume,
        // RoomCaptureView often crashes, and the in-progress capture is silently
        // corrupted. Treat backgrounding as an explicit cancel so the JS layer
        // surfaces a clear error instead of a half-broken USDZ later.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        let config = RoomCaptureSession.Configuration()
        captureView.captureSession.run(configuration: config)
        // Phase 2: tap RoomCaptureSession's ARSession with a read-only mesh
        // harvester. Polls `arSession.currentFrame.anchors` instead of
        // installing a delegate, which would break RoomPlan's internal state
        // machine (Apple permits only one ARSession per process and only one
        // delegate). Gated by iOS 17+ + feature flag; missing on older OS
        // surfaces as `meshClassification: undefined` in the result payload.
        if #available(iOS 17.0, *), Self.hybridMeshEnabled {
            let harvester = MeshClassificationHarvester()
            harvester.start(session: captureView.captureSession.arSession)
            meshHarvester = harvester
            Telemetry.log("mesh_harvester_started")
        }
        // Phase 1: even if RoomPlan never crosses the strict walls>=3 reveal
        // gate, the user gets a Fertig affordance after 90s with a warning
        // hint. Without this safety net, hallways / open lofts trap the user
        // in an endless "Scan läuft…" with no exit other than Cancel.
        startFinishForceRevealTimer()
        Telemetry.log("scan_started")
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if !isProcessing {
            captureView.captureSession.stop()
        }
        NotificationCenter.default.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
        stopFpsSampler()
        // Phase 2: stop mesh polling. Safe to call from any thread — internal
        // queue hop. We tear down BEFORE the rest so any concurrent tick has
        // a clean target.
        if #available(iOS 17.0, *), let harvester = meshHarvester as? MeshClassificationHarvester {
            harvester.stop()
        }
        meshHarvester = nil
        finishForceRevealTimer?.invalidate()
        finishForceRevealTimer = nil
        processingTimeoutTimer?.invalidate()
        processingTimeoutTimer = nil
    }

    @objc private func handleAppWillResignActive() {
        // Reentrancy guard — viewWillDisappear may also fire from the
        // dismissal animation triggered below; isProcessing prevents the
        // double stop(). Phase 1 fix: set the flag BEFORE the stop() call
        // and keep it true so the lifecycle callback's own stop() short-
        // circuits — the previous `= false` left a race window where the
        // dismissal-triggered viewWillDisappear stopped the session twice.
        guard !isProcessing else { return }
        isProcessing = true
        Telemetry.log("dismiss_reason", ["cause": "backgrounded"])
        captureView.captureSession.stop()
        // Phase 1 hotfix (post-review B1): fire JS-promise BEFORE the dismiss
        // animation. If iOS kills the suspended app while the animation runs,
        // the completion block never executes — the previous code left the
        // useStartRoomScan hook's `busy` flag stuck true with no way to
        // recover short of an app relaunch. `fireComplete` is single-shot,
        // so a successful dismiss completion firing it again is a safe noop.
        fireComplete(.failure(RoomScanError.backgroundedDuringCapture))
        dismiss(animated: true, completion: nil)
    }

    // MARK: - Block B.1 FPS sampler

    private func startFpsSampler() {
        fpsFrameCount = 0
        fpsWindowStart = CACurrentMediaTime()
        fpsRollingAvg = 0
        let link = CADisplayLink(target: self, selector: #selector(handleDisplayTick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopFpsSampler() {
        // Invalidate releases the target retain. Clearing the optional
        // afterwards drops the local strong reference so the link can be
        // collected before deinit. The selector is `@objc` and the target
        // is `self` weak via CADisplayLink's standard contract (CADisplayLink
        // does not retain the target on the .common run loop mode).
        displayLink?.invalidate()
        displayLink = nil
    }

    deinit {
        // Belt-and-braces — `viewWillDisappear` already calls stopFpsSampler,
        // but if the controller is torn down through a non-standard path
        // (e.g. parent VC dealloc mid-animation) the display link must not
        // outlive `self`.
        displayLink?.invalidate()
    }

    @objc private func handleDisplayTick() {
        fpsFrameCount += 1
        let now = CACurrentMediaTime()
        let dt = now - fpsWindowStart
        // Recompute the rolling average every ~1s so we end up with a stable
        // recent-FPS estimate even on long scans. EMA with alpha=0.4 gives
        // ~3s effective memory at 1Hz updates.
        if dt >= 1.0 {
            let sample = Double(fpsFrameCount) / dt
            fpsRollingAvg = fpsRollingAvg == 0 ? sample : (0.4 * sample + 0.6 * fpsRollingAvg)
            fpsFrameCount = 0
            fpsWindowStart = now
        }
        // Phase 2: emit a single mesh_memory_warning event per 5s window when
        // phys_footprint crosses 700 MB on hybrid-mesh devices. The Quality
        // Engine already gates R6/R7 via `degraded=true` on thermal critical;
        // this is forensic-only (Sentry breadcrumb + Xcode console). Throttle
        // is intentional — per-tick logs would flood at >60 Hz.
        if now - lastMemoryWarnAt > 5.0,
           let mem = Self.currentPhysFootprintBytes() {
            let mb = Int(mem / (1024 * 1024))
            if mb > 700 {
                lastMemoryWarnAt = now
                Telemetry.log("mesh_memory_warning", ["mb": mb])
            }
        }
    }

    /// `task_vm_info.phys_footprint` — same measure iOS uses to enforce the
    /// per-process memory limit. Falls back to nil on `task_info` failure
    /// (extremely rare); we treat that as "no signal" rather than guessing.
    ///
    /// Count constant: Apple defines `TASK_VM_INFO_COUNT` as
    /// `sizeof(task_vm_info_data_t) / sizeof(natural_t)`. The Swift mirror
    /// uses `.stride` because struct alignment may differ from byte size;
    /// using `.size / sizeof(integer_t)` (the original) under-counted by
    /// ~4 fields on arm64 and made `phys_footprint` return 0 / garbage on
    /// some iOS minor versions — the 700 MB gate then never tripped.
    private static func currentPhysFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.stride / MemoryLayout<natural_t>.stride
        )
        let result: kern_return_t = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : nil
    }

    /// Returns the latest deviceMeta dictionary, refreshing the volatile
    /// fields (FPS sample, post-scan thermal state, duration) at finish time.
    private func deviceMetaFinalSnapshot() -> [String: Any] {
        var snap = deviceMeta
        if fpsRollingAvg > 0 {
            snap["fpsSample"] = Double(round(fpsRollingAvg * 10) / 10)
        }
        // Re-read thermalState at the end of the scan — the user may have
        // pushed the device into `.fair` / `.serious` during a long capture.
        snap["thermalState"] = thermalLabel(ProcessInfo.processInfo.thermalState)
        if let started = captureStartedAt {
            snap["durationSec"] = Int(Date().timeIntervalSince(started))
        }
        return snap
    }

    private func thermalLabel(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal:  return "nominal"
        case .fair:     return "fair"
        case .serious:  return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }

    // MARK: - Actions

    @objc private func cancelTapped() {
        isProcessing = false
        Telemetry.log("dismiss_reason", ["cause": "cancelled"])
        captureView.captureSession.stop()
        // Phase 1 hotfix (post-review B1): fire-before-dismiss so the JS
        // promise resolves even if the dismiss animation is interrupted
        // (user backgrounds + iOS kills the app, or parent VC dealloc).
        fireComplete(.failure(RoomScanError.cancelled))
        dismiss(animated: true, completion: nil)
    }

    @objc private func finishTapped() {
        // Phase 1: set isProcessing BEFORE stop() so the inevitable
        // viewWillDisappear / lifecycle callbacks short-circuit instead of
        // doubling the session.stop() and crashing RoomCaptureView with
        // EXC_BAD_INSTRUCTION on the doubled state-machine transition.
        isProcessing = true
        finishButton.isEnabled = false
        cancelButton.isEnabled = false
        finishButton.setTitle("Wird verarbeitet…", for: .normal)
        Telemetry.log("finish_tapped", [
            "wallsSeen": maxWallsSeen,
            "elapsedSec": Int(Date().timeIntervalSince(captureStartedAt ?? Date()))
        ])
        captureView.captureSession.stop()
        startProcessingTimeoutTimer()
    }

    // MARK: - Phase 1 timers + telemetry

    private func startFinishForceRevealTimer() {
        finishForceRevealTimer?.invalidate()
        // 90s window — long enough that a real scan in progress won't get
        // the "Scan unvollständig" warning, short enough that a stuck user
        // in a hallway / open loft gets a way out.
        finishForceRevealTimer = Timer.scheduledTimer(withTimeInterval: 90.0, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                self?.forceRevealFinishWithWarning()
            }
        }
    }

    private func forceRevealFinishWithWarning() {
        guard !finishVisible else { return }
        Telemetry.log("finish_force_revealed", ["wallsSeen": maxWallsSeen])
        finishVisible = true
        finishButton.setTitle(maxWallsSeen >= 2 ? "Fertig" : "Trotzdem fertigstellen", for: .normal)
        finishButton.setTitleColor(UIColor.systemOrange, for: .normal)
        hintLabel.text = maxWallsSeen >= 2
            ? "Tippe «Fertig» wenn der Raum vollständig ist"
            : "Scan unvollständig — speichern und Maße manuell ergänzen?"
        hintLabel.textColor = UIColor.systemOrange.withAlphaComponent(0.85)
        UIView.animate(withDuration: 0.35) {
            self.separatorView.isHidden = false
            self.finishButton.isHidden = false
            self.hintLabel.isHidden = false
        }
    }

    private func startProcessingTimeoutTimer() {
        processingTimeoutTimer?.invalidate()
        // 30s — Apple's processing typically completes in 2-15s on iPad Pro
        // M2 / iPhone 15 Pro. A 30s timeout means a hung session gets a
        // user-visible error instead of a permanent "Wird verarbeitet…" trap.
        processingTimeoutTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                self?.handleProcessingTimeout()
            }
        }
    }

    private func handleProcessingTimeout() {
        guard !didCompleteOnce else { return }
        Telemetry.log("processing_timeout")
        // Phase 1 hotfix (post-review B1): fire-before-dismiss.
        fireComplete(.failure(RoomScanError.processingTimeout))
        dismiss(animated: true, completion: nil)
    }

    /// Single-shot dispatch — Apple can fire shouldPresent + didPresent
    /// with errors back-to-back, and our watchdog can race the natural
    /// completion. Guard ensures the JS-side promise resolves exactly once.
    fileprivate func fireComplete(_ result: Result<[String: Any], Error>) {
        guard !didCompleteOnce else { return }
        didCompleteOnce = true
        processingTimeoutTimer?.invalidate()
        processingTimeoutTimer = nil
        onComplete?(result)
    }

    // MARK: - UI setup

    private func setupCancelButton() {
        cancelButton = UIButton(type: .system)
        cancelButton.setTitle("Abbrechen", for: .normal)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)

        NSLayoutConstraint.activate([
            cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
        ])
    }

    private func setupGuidanceOverlay() {
        let blur = UIBlurEffect(style: .systemUltraThinMaterialDark)
        overlayCard = UIVisualEffectView(effect: blur)
        overlayCard.layer.cornerRadius = 16
        overlayCard.clipsToBounds = true
        overlayCard.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlayCard)

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 0
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false

        // ── Row 1: activity indicator + instruction ──────────────────────
        let topRow = UIStackView()
        topRow.axis = .horizontal
        topRow.spacing = 8
        topRow.alignment = .center
        topRow.layoutMargins = UIEdgeInsets(top: 14, left: 16, bottom: 0, right: 16)
        topRow.isLayoutMarginsRelativeArrangement = true

        activityIndicator = UIActivityIndicatorView(style: .medium)
        activityIndicator.color = .white
        activityIndicator.hidesWhenStopped = false
        activityIndicator.setContentHuggingPriority(.required, for: .horizontal)

        instructionLabel = UILabel()
        instructionLabel.text = "Bewege dein iPhone langsam durch den Raum"
        instructionLabel.textColor = .white
        instructionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        instructionLabel.numberOfLines = 0

        topRow.addArrangedSubview(activityIndicator)
        topRow.addArrangedSubview(instructionLabel)

        // ── Row 2: surface count ─────────────────────────────────────────
        let countRow = UIView()
        countRow.layoutMargins = UIEdgeInsets(top: 6, left: 16, bottom: 12, right: 16)

        surfaceLabel = UILabel()
        surfaceLabel.text = "Scan läuft…"
        surfaceLabel.textColor = UIColor.white.withAlphaComponent(0.55)
        surfaceLabel.font = .systemFont(ofSize: 12, weight: .regular)
        surfaceLabel.translatesAutoresizingMaskIntoConstraints = false
        countRow.addSubview(surfaceLabel)
        NSLayoutConstraint.activate([
            surfaceLabel.topAnchor.constraint(equalTo: countRow.layoutMarginsGuide.topAnchor),
            surfaceLabel.bottomAnchor.constraint(equalTo: countRow.layoutMarginsGuide.bottomAnchor),
            surfaceLabel.leadingAnchor.constraint(equalTo: countRow.layoutMarginsGuide.leadingAnchor),
            surfaceLabel.trailingAnchor.constraint(equalTo: countRow.layoutMarginsGuide.trailingAnchor),
        ])

        // ── Separator ────────────────────────────────────────────────────
        separatorView = UIView()
        separatorView.backgroundColor = UIColor.white.withAlphaComponent(0.15)
        separatorView.heightAnchor.constraint(equalToConstant: 1).isActive = true
        separatorView.isHidden = true

        // ── Row 3: Fertig button ─────────────────────────────────────────
        finishButton = UIButton(type: .system)
        finishButton.setTitle("Fertig", for: .normal)
        finishButton.setTitleColor(UIColor.systemGreen, for: .normal)
        finishButton.setTitleColor(UIColor.systemGreen.withAlphaComponent(0.4), for: .disabled)
        finishButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        finishButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 16, bottom: 4, right: 16)
        finishButton.addTarget(self, action: #selector(finishTapped), for: .touchUpInside)
        finishButton.isHidden = true

        // ── Row 4: hint ──────────────────────────────────────────────────
        // Phase 1 fix: previous hint promised an Apple-rendered "Fertig oben
        // rechts" button — Apple's RoomCaptureView does NOT render its own
        // finish button when the host VC supplies a custom delegate + overlay
        // (which we do). The user waited for a system button that never
        // appears. New hint points to OUR Fertig button below.
        hintLabel = UILabel()
        hintLabel.text = "Tippe «Fertig» unten sobald der Raum komplett ist"
        hintLabel.textColor = UIColor.white.withAlphaComponent(0.4)
        hintLabel.font = .systemFont(ofSize: 11, weight: .regular)
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        hintLabel.layoutMargins = UIEdgeInsets(top: 0, left: 16, bottom: 12, right: 16)
        hintLabel.isHidden = true

        stack.addArrangedSubview(topRow)
        stack.addArrangedSubview(countRow)
        stack.addArrangedSubview(separatorView)
        stack.addArrangedSubview(finishButton)
        stack.addArrangedSubview(hintLabel)

        overlayCard.contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: overlayCard.contentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: overlayCard.contentView.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: overlayCard.contentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: overlayCard.contentView.trailingAnchor),

            overlayCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            overlayCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            overlayCard.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -160),
        ])
    }
}

// MARK: - RoomCaptureSessionDelegate

extension RoomScanViewController: RoomCaptureSessionDelegate {

    func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        Telemetry.log("instruction_changed", ["instruction": String(describing: instruction)])
        DispatchQueue.main.async { [weak self] in
            self?.instructionLabel.text = Self.germanInstruction(for: instruction)
        }
    }

    func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {
        updateSurfaceCount(from: room)
    }

    func captureSession(_ session: RoomCaptureSession, didChange room: CapturedRoom) {
        updateSurfaceCount(from: room)
    }

    private func updateSurfaceCount(from room: CapturedRoom) {
        // Never decrease wall count — LiDAR transiently removes walls mid-scan.
        let prevWalls = maxWallsSeen
        maxWallsSeen = max(maxWallsSeen, room.walls.count)
        let doors = room.doors.count
        let windows = room.windows.count
        let furniture = room.objects.count
        let hasFloor: Bool
        if #available(iOS 17.0, *) {
            hasFloor = !room.floors.isEmpty
        } else {
            hasFloor = false
        }

        if prevWalls != maxWallsSeen {
            Telemetry.log("walls_changed", ["walls": maxWallsSeen, "doors": doors, "windows": windows, "furniture": furniture])
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            var parts: [String] = []
            if self.maxWallsSeen > 0 { parts.append("\(self.maxWallsSeen) Wand\(self.maxWallsSeen == 1 ? "" : "wände")") }
            if doors > 0 { parts.append("\(doors) Tür\(doors == 1 ? "" : "en")") }
            if windows > 0 { parts.append("\(windows) Fenster") }
            self.surfaceLabel.text = parts.isEmpty ? "Scan läuft…" : parts.joined(separator: " · ") + " erkannt"

            // Phase 1: reveal-gate softened from `walls>=3` to ANY of
            //   walls>=2 OR furniture>0 OR (iOS17) floor present.
            // RoomPlan in small/awkward rooms (hallways, open lofts, low-
            // texture walls, mirrors) often plateaus at 1-2 walls — the
            // 90s force-reveal timer is the final safety net for the rest.
            let revealReady = self.maxWallsSeen >= 2 || furniture > 0 || hasFloor
            if revealReady && !self.finishVisible {
                self.finishVisible = true
                Telemetry.log("finish_revealed", ["walls": self.maxWallsSeen, "furniture": furniture])
                UIView.animate(withDuration: 0.35) {
                    self.separatorView.isHidden = false
                    self.finishButton.isHidden = false
                    self.hintLabel.isHidden = false
                }
            }
        }
    }

    private static func germanInstruction(for instruction: RoomCaptureSession.Instruction) -> String {
        switch instruction {
        case .normal:           return "Bewege dein iPhone langsam durch den Raum"
        case .moveCloseToWall:  return "Näher an die Wand herangehen"
        case .moveAwayFromWall: return "Etwas weiter von der Wand entfernen"
        case .slowDown:         return "Langsamer bewegen"
        case .turnOnLight:      return "Mehr Licht einschalten"
        case .lowTexture:       return "Strukturarme Wand – andere Seite versuchen"
        @unknown default:       return "Bewege dich weiter durch den Raum"
        }
    }
}

// MARK: - RoomCaptureViewDelegate

extension RoomScanViewController: RoomCaptureViewDelegate {

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        Telemetry.log("should_present", ["hasError": error != nil])
        if let error {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                // Phase 1 hotfix (post-review B1): fire-before-dismiss.
                self.fireComplete(.failure(error))
                self.dismiss(animated: true, completion: nil)
            }
            return false
        }
        // Phase 1 hotfix (post-review B2): Apple's docs say returning `false`
        // here without an error is reserved for "host VC explicitly declined
        // the processing pass". In practice RoomPlan sometimes hits this with
        // no error and no follow-up didPresent — the JS promise then hangs
        // forever. We don't ever return false with no error from our own
        // code, but if a future delegate-decorator does, surface it as
        // insufficientData so the toast pipeline can recover. Defensive only.
        isProcessing = true
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        Telemetry.log("did_present", [
            "hasError": error != nil,
            "walls": processedResult.walls.count,
            "doors": processedResult.doors.count,
            "windows": processedResult.windows.count,
        ])
        // Phase 1: do NOT flip isProcessing back to false here. The dismiss
        // below tears down the VC, which fires viewWillDisappear — that
        // already checks isProcessing to avoid the doubled stop() crash.
        // Flipping it false here re-opens the race window.
        processingTimeoutTimer?.invalidate()
        processingTimeoutTimer = nil
        if let error {
            // Phase 1 hotfix (post-review B1): fire-before-dismiss.
            fireComplete(.failure(error))
            dismiss(animated: true, completion: nil)
            return
        }

        // Phase 1 hotfix (post-review H1): wire SCAN_INSUFFICIENT_DATA from
        // Swift. Web layer branches on this code at useStartRoomScan.ts and
        // shows the right toast, but no Swift path was firing it — the user
        // got the generic SCAN_FAILED instead. Trigger here when Apple
        // hands back a CapturedRoom with no walls AND no furniture, which
        // is the "the user moved too little / lighting was bad" signal.
        let hasFloor: Bool
        if #available(iOS 17.0, *) {
            hasFloor = !processedResult.floors.isEmpty
        } else {
            hasFloor = false
        }
        if processedResult.walls.isEmpty
            && processedResult.objects.isEmpty
            && !hasFloor {
            Telemetry.log("did_present_insufficient_data", [
                "walls": processedResult.walls.count,
                "objects": processedResult.objects.count,
            ])
            fireComplete(.failure(RoomScanError.insufficientData))
            dismiss(animated: true, completion: nil)
            return
        }

        // Day 9 B15: hand the CapturedRoom to the plugin so the canonical
        // converter can run against it later. Fires BEFORE the heavy export
        // path so the plugin's cache is populated even if usdz export fails.
        // We pass it as `AnyObject` because Swift won't let us @available a
        // closure parameter type — see VC field comment.
        onCapturedRoom?(processedResult as AnyObject)

        // Phase 2: snapshot mesh harvester ON THE MAIN THREAD before we hop
        // to the export queue. viewWillDisappear hasn't fired yet (dismiss
        // animation runs after this callback returns), so the harvester is
        // still alive. Snapshot is queue.sync internally — safe + fast.
        // Capture the JSON dict into the export closure below so the export
        // path is independent of harvester teardown timing.
        let meshSummaryJson: [String: Any]? = {
            if #available(iOS 17.0, *),
               let harvester = meshHarvester as? MeshClassificationHarvester,
               let summary = harvester.snapshot() {
                Telemetry.log("mesh_harvester_snapshot", [
                    "anchors": summary.anchorCount,
                    "totalFaces": summary.totalFaces,
                    "wallCoverageRatio": summary.wallCoverageRatio,
                    "degraded": summary.degraded,
                    "samples": summary.samplesCollected,
                ])
                return summary.toJSON()
            }
            return nil
        }()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            let tmpDir = FileManager.default.temporaryDirectory
            let filename = "scan_\(Int(Date().timeIntervalSince1970)).usdz"
            let usdzURL = tmpDir.appendingPathComponent(filename)

            do {
                try processedResult.export(to: usdzURL)
            } catch {
                Telemetry.log("export_failed", ["error": String(describing: error)])
                DispatchQueue.main.async {
                    // Phase 1 hotfix (post-review B1): fire-before-dismiss.
                    self.fireComplete(.failure(error))
                    self.dismiss(animated: true, completion: nil)
                }
                return
            }

            var payload = self.buildMetadata(from: processedResult)
            payload["usdzPath"] = usdzURL.absoluteString
            payload["capturedAt"] = ISO8601DateFormatter().string(from: Date())
            // Block B.1: hand the device + telemetry snapshot back to JS so it
            // lands in scans.device_meta + the audit payload on finishCapture.
            payload["deviceMeta"] = self.deviceMetaFinalSnapshot()
            // Phase 2: optional mesh aggregate. nil on non-LiDAR / iOS<17 /
            // feature-flag-off / harvester ran but observed zero frames.
            if let mesh = meshSummaryJson {
                payload["meshClassification"] = mesh
            }

            DispatchQueue.main.async {
                // Phase 1 hotfix (post-review B1): fire-before-dismiss.
                self.fireComplete(.success(payload))
                self.dismiss(animated: true, completion: nil)
            }
        }
    }
}

// MARK: - Metadata extraction

private extension RoomScanViewController {

    func buildMetadata(from room: CapturedRoom) -> [String: Any] {
        let floorAreaM2: Double
        if #available(iOS 17.0, *) {
            floorAreaM2 = room.floors.reduce(0.0) { $0 + Double($1.dimensions.x * $1.dimensions.z) }
        } else {
            floorAreaM2 = estimateFloorAreaFromWalls(room.walls)
        }

        let ceilingHeightM = room.walls.map { Double($0.dimensions.y) }.max() ?? 0.0
        let walls = room.walls
            .map { ["widthM": Double($0.dimensions.x), "heightM": Double($0.dimensions.y)] }
            .sorted { ($0["widthM"] ?? 0) > ($1["widthM"] ?? 0) }
        let doors = room.doors.map { ["widthM": Double($0.dimensions.x), "heightM": Double($0.dimensions.y)] }
        let windows = room.windows.map { ["widthM": Double($0.dimensions.x), "heightM": Double($0.dimensions.y)] }

        return [
            "floorAreaM2": floorAreaM2,
            "ceilingHeightM": ceilingHeightM,
            "walls": walls,
            "doors": doors,
            "windows": windows,
            "furnitureCount": room.objects.count,
            "furnitureCategories": room.objects.map { categoryLabel($0.category) },
        ]
    }

    func estimateFloorAreaFromWalls(_ walls: [CapturedRoom.Surface]) -> Double {
        guard !walls.isEmpty else { return 0.0 }
        var minX = Float.infinity, maxX = -Float.infinity
        var minZ = Float.infinity, maxZ = -Float.infinity
        for wall in walls {
            let pos = wall.transform.columns.3
            let lx = wall.transform.columns.0
            let hw = wall.dimensions.x / 2
            minX = min(minX, pos.x + lx.x * hw, pos.x - lx.x * hw)
            maxX = max(maxX, pos.x + lx.x * hw, pos.x - lx.x * hw)
            minZ = min(minZ, pos.z + lx.z * hw, pos.z - lx.z * hw)
            maxZ = max(maxZ, pos.z + lx.z * hw, pos.z - lx.z * hw)
        }
        return Double((maxX - minX) * (maxZ - minZ))
    }

    func categoryLabel(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage: return "storage"; case .refrigerator: return "refrigerator"
        case .stove: return "stove"; case .bed: return "bed"; case .sink: return "sink"
        case .washerDryer: return "washer_dryer"; case .toilet: return "toilet"
        case .bathtub: return "bathtub"; case .oven: return "oven"
        case .dishwasher: return "dishwasher"; case .table: return "table"
        case .sofa: return "sofa"; case .chair: return "chair"
        case .fireplace: return "fireplace"; case .television: return "television"
        case .stairs: return "stairs"; @unknown default: return "unknown"
        }
    }
}

// MARK: - Errors

enum RoomScanError: LocalizedError {
    case cancelled
    case backgroundedDuringCapture
    case processingTimeout
    case insufficientData
    var errorDescription: String? {
        switch self {
        case .cancelled:                  return "Scan abgebrochen"
        case .backgroundedDuringCapture:  return "Scan unterbrochen — App in den Hintergrund gelegt"
        case .processingTimeout:          return "Scan-Verarbeitung dauert zu lange — bitte erneut versuchen"
        case .insufficientData:           return "Zu wenig Raumdaten erfasst — bitte mehr Wände scannen und erneut versuchen"
        }
    }
}

// MARK: - Telemetry bridge
//
// Phase 1: posts native lifecycle events to NotificationCenter so the
// Capacitor plugin can fan them out to JS via notifyListeners(). Allows
// Sentry breadcrumbs + Console.log without coupling the view controller
// to Capacitor types.
//
// Listener: RoomPlanPlugin observes `roomScanTelemetry` notifications and
// forwards each one as a `notifyListeners("roomScanTelemetry", payload)`.
//
enum Telemetry {
    static let notificationName = Notification.Name("FixupRoomScanTelemetry")

    /// Post on main so observers that hop to UIKit (e.g. the Capacitor
    /// plugin forwarding via `notifyListeners` to the WebView) never receive
    /// a synchronous delivery from a background queue. Phase 1's
    /// `export_failed` path logs from `DispatchQueue.global(qos:.userInitiated)`;
    /// without this hop the WebView observer would assert on main-thread
    /// checker. Already-on-main callers pay only a single sync check.
    static func log(_ event: String, _ data: [String: Any] = [:]) {
        var payload: [String: Any] = ["event": event, "timestamp": Date().timeIntervalSince1970]
        for (k, v) in data { payload[k] = v }
        if Thread.isMainThread {
            NotificationCenter.default.post(name: notificationName, object: nil, userInfo: payload)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: notificationName, object: nil, userInfo: payload)
            }
        }
    }
}
