/**
 * Presence Monitor — macOS menubar app for tg-relay presence.
 *
 * Shows 🟢 (present), 🔴 (away), ⚠️ (stale), or ❓ (unreachable) in the
 * menubar. Features:
 * - Presence status display with override controls (here/away)
 * - Daemon management (start/stop/restart via launchctl)
 * - Settings window with sliders and toggles for presence thresholds
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

// MARK: - Settings keys and defaults (UserDefaults + env var mapping)

struct Setting {
    let key: String       // UserDefaults key
    let envVar: String    // Daemon env var name
    let label: String     // UI label
    let unit: SettingUnit
    let min: Int
    let max: Int
    let defaultValue: Int
}

enum SettingUnit {
    case seconds      // stored as seconds, env var as seconds
    case milliseconds // stored as seconds in UI, env var as milliseconds
}

let sliderSettings: [Setting] = [
    Setting(key: "awayIdleSeconds", envVar: "TG_RELAY_AWAY_IDLE_SECONDS",
            label: "Go away after idle",
            unit: .seconds, min: 15, max: 600, defaultValue: 90),
    Setting(key: "presentIdleSeconds", envVar: "TG_RELAY_PRESENT_IDLE_SECONDS",
            label: "Return to present after activity",
            unit: .seconds, min: 5, max: 120, defaultValue: 30),
    Setting(key: "faceSampleSeconds", envVar: "TG_RELAY_FACE_SAMPLE_MS",
            label: "Face scan interval",
            unit: .milliseconds, min: 5, max: 120, defaultValue: 15),
    Setting(key: "presenceTickSeconds", envVar: "TG_RELAY_PRESENCE_TICK_MS",
            label: "Presence poll interval",
            unit: .milliseconds, min: 3, max: 60, defaultValue: 10),
    Setting(key: "staleSeconds", envVar: "TG_RELAY_PRESENCE_STALE_SECONDS",
            label: "Mark stale after",
            unit: .seconds, min: 15, max: 300, defaultValue: 45),
    Setting(key: "overrideTtlMinutes", envVar: "TG_RELAY_PRESENCE_OVERRIDE_TTL_MS",
            label: "Override duration",
            unit: .milliseconds, min: 5, max: 120, defaultValue: 30),
]

struct Toggle {
    let key: String
    let envVar: String
    let label: String
    let defaultValue: Bool
}

let toggleSettings: [Toggle] = [
    Toggle(key: "camera", envVar: "TG_RELAY_PRESENCE_CAMERA",
           label: "Face detection (camera)", defaultValue: true),
    Toggle(key: "gating", envVar: "TG_RELAY_PRESENCE_GATING",
           label: "Presence gating (suppress sends when present)", defaultValue: true),
]

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
    private var sliders: [(Setting, NSSlider, NSTextField)] = []
    private var toggleButtons: [(Toggle, NSButton)] = []
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

        let rowHeight: CGFloat = 70
        let toggleHeight: CGFloat = 30
        let padding: CGFloat = 60  // top/bottom padding + button
        let windowHeight = CGFloat(sliderSettings.count) * rowHeight
            + CGFloat(toggleSettings.count) * toggleHeight
            + padding + 30  // section header

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: windowHeight),
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
        sliders = []
        toggleButtons = []

        var y = windowHeight - 30

        // ── Toggles section ─────────────────────────────────
        let toggleHeader = NSTextField(labelWithString: "Features")
        toggleHeader.frame = NSRect(x: 20, y: y, width: 200, height: 18)
        toggleHeader.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        toggleHeader.textColor = .secondaryLabelColor
        content.addSubview(toggleHeader)
        y -= 8

        for t in toggleSettings {
            y -= toggleHeight
            let stored = defaults.object(forKey: t.key) as? Bool ?? t.defaultValue
            let btn = NSButton(checkboxWithTitle: "  \(t.label)", target: nil, action: nil)
            btn.frame = NSRect(x: 20, y: y, width: 360, height: 22)
            btn.state = stored ? .on : .off
            btn.font = NSFont.systemFont(ofSize: 13)
            content.addSubview(btn)
            toggleButtons.append((t, btn))
        }

        y -= 20

        // ── Sliders section ─────────────────────────────────
        let slidersHeader = NSTextField(labelWithString: "Thresholds")
        slidersHeader.frame = NSRect(x: 20, y: y, width: 200, height: 18)
        slidersHeader.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        slidersHeader.textColor = .secondaryLabelColor
        content.addSubview(slidersHeader)
        y -= 5

        for s in sliderSettings {
            y -= rowHeight
            let stored = defaults.integer(forKey: s.key)
            let value = stored > 0 ? clamp(stored, s.min, s.max) : s.defaultValue

            // Special case: override TTL is in minutes in the UI
            let displayValue = s.key == "overrideTtlMinutes" ? value : value

            let titleLabel = NSTextField(labelWithString: s.label)
            titleLabel.frame = NSRect(x: 20, y: y + 35, width: 300, height: 18)
            titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
            content.addSubview(titleLabel)

            let slider = NSSlider(frame: NSRect(x: 20, y: y + 8, width: 290, height: 20))
            slider.minValue = Double(s.min)
            slider.maxValue = Double(s.max)
            slider.integerValue = displayValue
            slider.isContinuous = true
            slider.target = self
            slider.action = #selector(sliderChanged(_:))
            content.addSubview(slider)

            let valLabel = NSTextField(labelWithString: formatForSetting(s, displayValue))
            valLabel.frame = NSRect(x: 318, y: y + 8, width: 80, height: 20)
            valLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            valLabel.alignment = .right
            content.addSubview(valLabel)

            sliders.append((s, slider, valLabel))
        }

        // Apply button
        let applyBtn = NSButton(frame: NSRect(x: 150, y: 15, width: 130, height: 32))
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

    @objc private func sliderChanged(_ sender: NSSlider) {
        for (s, sl, lbl) in sliders where sl === sender {
            lbl.stringValue = formatForSetting(s, sl.integerValue)
            break
        }
    }

    @objc private func applySettings() {
        let defaults = UserDefaults.standard

        // Read the current plist
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: daemonPlist)),
              var plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              var env = plist["EnvironmentVariables"] as? [String: String] else {
            showAlert("Could not read daemon plist at:\n\(daemonPlist)")
            return
        }

        // Write slider values
        for (s, slider, _) in sliders {
            let value = slider.integerValue
            defaults.set(value, forKey: s.key)

            switch s.unit {
            case .seconds:
                env[s.envVar] = String(value)
            case .milliseconds:
                if s.key == "overrideTtlMinutes" {
                    env[s.envVar] = String(value * 60 * 1000) // minutes → ms
                } else {
                    env[s.envVar] = String(value * 1000)  // seconds → ms
                }
            }
        }

        // Write toggle values
        for (t, btn) in toggleButtons {
            let on = btn.state == .on
            defaults.set(on, forKey: t.key)
            env[t.envVar] = on ? "on" : "off"
        }

        plist["EnvironmentVariables"] = env

        // Write plist back
        if let newData = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
            do {
                try newData.write(to: URL(fileURLWithPath: daemonPlist))
            } catch {
                showAlert("Could not write plist: \(error.localizedDescription)")
                return
            }
        }

        // Restart daemon (unload + load to pick up plist changes)
        appDelegate?.restartDaemonAction()
        window?.close()
    }

    private func formatForSetting(_ s: Setting, _ value: Int) -> String {
        if s.key == "overrideTtlMinutes" {
            return "\(value) min"
        }
        return formatDuration(value)
    }

    private func showAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Settings Error"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

private func formatDuration(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds)s" }
    let m = seconds / 60
    let s = seconds % 60
    return s == 0 ? "\(m)m" : "\(m)m \(s)s"
}

private func clamp(_ v: Int, _ lo: Int, _ hi: Int) -> Int {
    return Swift.min(Swift.max(v, lo), hi)
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

    @objc private func restartDaemon() { restartDaemonAction() }

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
