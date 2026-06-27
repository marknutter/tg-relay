/**
 * Presence Monitor — macOS menubar app for tg-relay presence.
 *
 * Shows 🟢 (present), 🔴 (away), ⚠️ (stale), or ❓ (unreachable) in the
 * menubar. Features:
 * - Presence status display with override controls (here/away)
 * - Daemon management (start/stop/restart via launchctl)
 * - Settings window with sliders for presence thresholds
 *
 * Build as .app:
 *   ./build.sh
 *
 * Environment:
 *   PRESENCE_URL    — daemon endpoint (default: http://localhost:7780)
 *   PRESENCE_TOKEN  — bearer token for override actions
 */

import Cocoa
import Foundation

// MARK: - Configuration

let baseURL = ProcessInfo.processInfo.environment["PRESENCE_URL"] ?? "http://localhost:7780"
let token   = ProcessInfo.processInfo.environment["PRESENCE_TOKEN"] ?? ""
let pollInterval: TimeInterval = 5.0

let daemonLabel = "com.marknutter.tg-relay"
let daemonPlist = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"

// MARK: - Settings keys (UserDefaults)

let kAwayIdle   = "awayIdleSeconds"      // How long idle before → away
let kFaceSample = "faceSampleSeconds"    // Camera check interval
let kStale      = "staleSeconds"         // When state is considered stale

let defaultAwayIdle   = 90
let defaultFaceSample = 15
let defaultStale      = 45

// MARK: - State model

struct PresenceStatus {
    let present: Bool
    let stale: Bool
    let ageSeconds: Int
    let source: String
    let gating: String
    let producer: Bool
    let overridePresent: Bool?
    let overrideExpiresIn: Int?
}

// MARK: - Settings Window

class SettingsWindowController: NSObject {
    private var window: NSWindow?
    private var awaySlider: NSSlider!
    private var awayLabel: NSTextField!
    private var faceSlider: NSSlider!
    private var faceLabel: NSTextField!
    private var staleSlider: NSSlider!
    private var staleLabel: NSTextField!
    private weak var appDelegate: AppDelegate?

    init(appDelegate: AppDelegate) {
        self.appDelegate = appDelegate
        super.init()
    }

    func show() {
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 280),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        w.title = "Presence Settings"
        w.center()
        w.isReleasedWhenClosed = false

        let content = NSView(frame: w.contentView!.bounds)
        content.autoresizingMask = [.width, .height]

        let defaults = UserDefaults.standard
        var y: CGFloat = 230

        // Away idle threshold
        y = addSliderRow(
            to: content, y: y,
            label: "Go away after idle:",
            min: 30, max: 600, value: defaults.integer(forKey: kAwayIdle).clamped(30, 600, defaultAwayIdle),
            format: { formatDuration($0) },
            sliderOut: &awaySlider, labelOut: &awayLabel,
            action: #selector(awaySliderChanged)
        )

        // Face sample interval
        y = addSliderRow(
            to: content, y: y,
            label: "Camera check interval:",
            min: 5, max: 120, value: defaults.integer(forKey: kFaceSample).clamped(5, 120, defaultFaceSample),
            format: { formatDuration($0) },
            sliderOut: &faceSlider, labelOut: &faceLabel,
            action: #selector(faceSliderChanged)
        )

        // Stale threshold
        y = addSliderRow(
            to: content, y: y,
            label: "Stale after:",
            min: 30, max: 300, value: defaults.integer(forKey: kStale).clamped(30, 300, defaultStale),
            format: { formatDuration($0) },
            sliderOut: &staleSlider, labelOut: &staleLabel,
            action: #selector(staleSliderChanged)
        )

        // Apply button
        let applyBtn = NSButton(frame: NSRect(x: 130, y: 15, width: 120, height: 32))
        applyBtn.title = "Apply & Restart"
        applyBtn.bezelStyle = .rounded
        applyBtn.target = self
        applyBtn.action = #selector(applySettings)
        content.addSubview(applyBtn)

        w.contentView = content
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w
    }

    private func addSliderRow(
        to view: NSView, y: CGFloat,
        label: String,
        min: Int, max: Int, value: Int,
        format: @escaping (Int) -> String,
        sliderOut: inout NSSlider!,
        labelOut: inout NSTextField!,
        action: Selector
    ) -> CGFloat {
        let titleLabel = NSTextField(labelWithString: label)
        titleLabel.frame = NSRect(x: 20, y: y, width: 200, height: 20)
        titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        view.addSubview(titleLabel)

        let slider = NSSlider(frame: NSRect(x: 20, y: y - 30, width: 260, height: 20))
        slider.minValue = Double(min)
        slider.maxValue = Double(max)
        slider.integerValue = value
        slider.target = self
        slider.action = action
        slider.isContinuous = true
        view.addSubview(slider)
        sliderOut = slider

        let valLabel = NSTextField(labelWithString: format(value))
        valLabel.frame = NSRect(x: 290, y: y - 30, width: 70, height: 20)
        valLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        valLabel.alignment = .right
        view.addSubview(valLabel)
        labelOut = valLabel

        return y - 70
    }

    @objc private func awaySliderChanged() {
        awayLabel.stringValue = formatDuration(awaySlider.integerValue)
    }
    @objc private func faceSliderChanged() {
        faceLabel.stringValue = formatDuration(faceSlider.integerValue)
    }
    @objc private func staleSliderChanged() {
        staleLabel.stringValue = formatDuration(staleSlider.integerValue)
    }

    @objc private func applySettings() {
        let away = awaySlider.integerValue
        let face = faceSlider.integerValue
        let stale = staleSlider.integerValue

        // Save to UserDefaults
        let defaults = UserDefaults.standard
        defaults.set(away, forKey: kAwayIdle)
        defaults.set(face, forKey: kFaceSample)
        defaults.set(stale, forKey: kStale)

        // Update daemon plist with new env vars
        updateDaemonPlist(awayIdle: away, faceSample: face, stale: stale)

        // Restart daemon
        appDelegate?.restartDaemonAction()

        window?.close()
    }

    private func updateDaemonPlist(awayIdle: Int, faceSample: Int, stale: Int) {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: daemonPlist)),
              var plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              var env = plist["EnvironmentVariables"] as? [String: String] else { return }

        env["TG_RELAY_AWAY_IDLE_SECONDS"] = String(awayIdle)
        env["TG_RELAY_FACE_SAMPLE_MS"] = String(faceSample * 1000)
        env["TG_RELAY_STALE_SECONDS"] = String(stale)
        plist["EnvironmentVariables"] = env

        if let newData = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
            try? newData.write(to: URL(fileURLWithPath: daemonPlist))
        }
    }
}

private func formatDuration(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds)s" }
    let m = seconds / 60
    let s = seconds % 60
    return s == 0 ? "\(m)m" : "\(m)m \(s)s"
}

extension Int {
    func clamped(_ lo: Int, _ hi: Int, _ fallback: Int) -> Int {
        let v = self == 0 ? fallback : self
        return Swift.min(Swift.max(v, lo), hi)
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var lastStatus: PresenceStatus?
    private var daemonRunning: Bool = false
    private var settingsController: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.systemFont(ofSize: 14)
        updateUI(status: nil)
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    // MARK: - Polling

    private func poll() {
        daemonRunning = isDaemonRunning()

        guard let url = URL(string: "\(baseURL)/presence") else {
            DispatchQueue.main.async { self.updateUI(status: nil) }
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self?.updateUI(status: nil)
                    return
                }
                let overrideObj = json["override"] as? [String: Any]
                let status = PresenceStatus(
                    present: json["present"] as? Bool ?? false,
                    stale: json["stale"] as? Bool ?? false,
                    ageSeconds: json["ageSeconds"] as? Int ?? 0,
                    source: json["source"] as? String ?? "unknown",
                    gating: json["gating"] as? String ?? "off",
                    producer: json["producer"] as? Bool ?? false,
                    overridePresent: overrideObj?["present"] as? Bool,
                    overrideExpiresIn: overrideObj?["expiresInSeconds"] as? Int
                )
                self?.updateUI(status: status)
            }
        }.resume()
    }

    // MARK: - UI

    private func updateUI(status: PresenceStatus?) {
        lastStatus = status
        let menu = NSMenu()
        menu.autoenablesItems = false

        guard let s = status else {
            statusItem.button?.title = "❓"
            addDisabled(menu, "Presence: Unreachable")
            if !daemonRunning {
                addDisabled(menu, "⛔ Daemon is not running")
            } else {
                addDisabled(menu, "Daemon running but endpoint not reachable")
            }
            addDisabled(menu, "\(baseURL)/presence")
            menu.addItem(NSMenuItem.separator())
            addDaemonControls(menu)
            menu.addItem(NSMenuItem.separator())
            addSettingsAndQuit(menu)
            statusItem.menu = menu
            return
        }

        // Menubar icon
        if s.stale {
            statusItem.button?.title = "⚠️"
        } else if s.present {
            statusItem.button?.title = "🟢"
        } else {
            statusItem.button?.title = "🔴"
        }

        // Status details
        let stateLabel = s.stale ? "Stale" : (s.present ? "Present (here)" : "Away")
        addDisabled(menu, "Status: \(stateLabel)")
        addDisabled(menu, "Updated: \(formatAge(s.ageSeconds))")
        addDisabled(menu, "Source: \(s.source)")

        if s.gating == "on" {
            addDisabled(menu, "Gating: ON (sends gated)")
        } else {
            addDisabled(menu, "Gating: OFF (all sends pass through)")
        }

        if !s.producer {
            addDisabled(menu, "Producer: off (consumer-only)")
        }

        // Override info
        if let op = s.overridePresent, let exp = s.overrideExpiresIn {
            let label = op ? "HERE" : "AWAY"
            addDisabled(menu, "Override: \(label) (expires in \(formatAge(exp)))")
        }

        menu.addItem(NSMenuItem.separator())

        // Override actions
        let hereItem = NSMenuItem(title: "☀️  Set Here (30 min)", action: #selector(setHere), keyEquivalent: "h")
        hereItem.target = self
        menu.addItem(hereItem)

        let awayItem = NSMenuItem(title: "🌙  Set Away (30 min)", action: #selector(setAway), keyEquivalent: "a")
        awayItem.target = self
        menu.addItem(awayItem)

        if s.overridePresent != nil {
            let clearItem = NSMenuItem(title: "↩️  Clear Override", action: #selector(clearOverride), keyEquivalent: "c")
            clearItem.target = self
            menu.addItem(clearItem)
        }

        menu.addItem(NSMenuItem.separator())
        addDaemonControls(menu)
        menu.addItem(NSMenuItem.separator())
        addSettingsAndQuit(menu)

        statusItem.menu = menu
    }

    // MARK: - Daemon controls

    private func addDaemonControls(_ menu: NSMenu) {
        if daemonRunning {
            addDisabled(menu, "✅ Daemon running")
            let restartItem = NSMenuItem(title: "🔄  Restart Daemon", action: #selector(restartDaemon), keyEquivalent: "r")
            restartItem.target = self
            menu.addItem(restartItem)
            let stopItem = NSMenuItem(title: "⏹  Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        } else {
            addDisabled(menu, "⛔ Daemon stopped")
            let startItem = NSMenuItem(title: "▶️  Start Daemon", action: #selector(startDaemon), keyEquivalent: "r")
            startItem.target = self
            menu.addItem(startItem)
        }
    }

    private func addSettingsAndQuit(_ menu: NSMenu) {
        let settingsItem = NSMenuItem(title: "⚙️  Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let quitItem = NSMenuItem(title: "Quit Presence Monitor", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    // MARK: - Actions

    @objc private func setHere() { postOverride(present: true) }
    @objc private func setAway() { postOverride(present: false) }
    @objc private func clearOverride() { deleteOverride() }

    @objc private func openSettings() {
        if settingsController == nil {
            settingsController = SettingsWindowController(appDelegate: self)
        }
        settingsController?.show()
    }

    @objc private func startDaemon() {
        runLaunchctl(["load", daemonPlist])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.poll() }
    }

    @objc private func stopDaemon() {
        runLaunchctl(["unload", daemonPlist])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.poll() }
    }

    @objc private func restartDaemon() {
        restartDaemonAction()
    }

    func restartDaemonAction() {
        // Unload + load picks up plist changes (kickstart doesn't)
        runLaunchctl(["unload", daemonPlist])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.runLaunchctl(["load", daemonPlist])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.poll() }
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Daemon helpers

    private func isDaemonRunning() -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        let uid = getuid()
        task.arguments = ["print", "gui/\(uid)/\(daemonLabel)"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func runLaunchctl(_ args: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = args
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
    }

    // MARK: - API calls

    private func postOverride(present: Bool) {
        guard let url = URL(string: "\(baseURL)/presence/override") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["present": present])
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.poll() }
        }.resume()
    }

    private func deleteOverride() {
        guard let url = URL(string: "\(baseURL)/presence/override") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.poll() }
        }.resume()
    }

    // MARK: - Helpers

    private func addDisabled(_ menu: NSMenu, _ title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
    }

    private func formatAge(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s ago" }
        return "\(seconds / 3600)h \(seconds % 3600 / 60)m ago"
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // No dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
