/**
 * Presence Monitor — all-in-one macOS menubar app for tg-relay.
 *
 * This single app:
 * 1. Launches and manages the tg-relay daemon as a child process
 * 2. Shows 🟢/🔴/⚠️/❓ presence in the menubar
 * 3. Provides override controls (here/away)
 * 4. Settings window with sliders/toggles for all thresholds
 *
 * Build:  ./build.sh
 * Output: PresenceMonitor.app (drag to /Applications, add to Login Items)
 *
 * Environment:
 *   PRESENCE_TOKEN — bearer token for override API (default: reads from UserDefaults)
 */

import Cocoa
import Foundation

// MARK: - Configuration

let pollInterval: TimeInterval = 5.0
let presencePort = 7780
let baseURL = "http://localhost:\(presencePort)"

let daemonLabel = "com.marknutter.tg-relay"

// Paths — these are MacBook Pro specific
let bunBin: String = {
    // Try common locations
    for p in ["/opt/homebrew/bin/bun", "/usr/local/bin/bun",
              "\(NSHomeDirectory())/.bun/bin/bun"] {
        if FileManager.default.fileExists(atPath: p) { return p }
    }
    return "/opt/homebrew/bin/bun"  // fallback
}()
let daemonScript = "\(NSHomeDirectory())/Code/tg-relay/src/daemon.ts"
let logFile = "\(NSHomeDirectory())/.claude/channels/telegram-router.log"

// MARK: - Settings keys and defaults

struct SliderSetting {
    let key: String
    let envVar: String
    let label: String
    let unit: SettingUnit
    let min: Int
    let max: Int
    let defaultValue: Int
}

enum SettingUnit {
    case seconds
    case milliseconds  // UI shows seconds, env var is ms
    case minutes       // UI shows minutes, env var is ms
}

let sliderSettings: [SliderSetting] = [
    SliderSetting(key: "awayIdleSeconds", envVar: "TG_RELAY_AWAY_IDLE_SECONDS",
                  label: "Go away after idle",
                  unit: .seconds, min: 15, max: 600, defaultValue: 90),
    SliderSetting(key: "presentIdleSeconds", envVar: "TG_RELAY_PRESENT_IDLE_SECONDS",
                  label: "Return to present after activity",
                  unit: .seconds, min: 5, max: 120, defaultValue: 30),
    SliderSetting(key: "faceSampleSeconds", envVar: "TG_RELAY_FACE_SAMPLE_MS",
                  label: "Face scan interval",
                  unit: .milliseconds, min: 5, max: 120, defaultValue: 15),
    SliderSetting(key: "presenceTickSeconds", envVar: "TG_RELAY_PRESENCE_TICK_MS",
                  label: "Presence poll interval",
                  unit: .milliseconds, min: 3, max: 60, defaultValue: 10),
    SliderSetting(key: "staleSeconds", envVar: "TG_RELAY_PRESENCE_STALE_SECONDS",
                  label: "Mark stale after",
                  unit: .seconds, min: 15, max: 300, defaultValue: 45),
    SliderSetting(key: "overrideTtlMinutes", envVar: "TG_RELAY_PRESENCE_OVERRIDE_TTL_MS",
                  label: "Override duration",
                  unit: .minutes, min: 5, max: 120, defaultValue: 30),
]

struct ToggleSetting {
    let key: String
    let envVar: String
    let label: String
    let defaultValue: Bool
}

let toggleSettings: [ToggleSetting] = [
    ToggleSetting(key: "camera", envVar: "TG_RELAY_PRESENCE_CAMERA",
                  label: "Face detection (camera)", defaultValue: true),
    ToggleSetting(key: "gating", envVar: "TG_RELAY_PRESENCE_GATING",
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

// MARK: - Daemon Manager

class DaemonManager {
    private var process: Process?
    private var restartCount = 0
    private let maxRestartDelay: TimeInterval = 30

    var isRunning: Bool { process?.isRunning ?? false }

    func start() {
        guard !isRunning else { return }

        let env = buildEnv()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bunBin)
        proc.arguments = [daemonScript]
        proc.environment = env

        // Pipe stdout/stderr to the log file
        let logHandle = FileHandle(forWritingAtPath: logFile)
            ?? { FileManager.default.createFile(atPath: logFile, contents: nil)
                 return FileHandle(forWritingAtPath: logFile) }()
        logHandle?.seekToEndOfFile()
        proc.standardOutput = logHandle
        proc.standardError = logHandle

        proc.terminationHandler = { [weak self] p in
            guard let self = self else { return }
            let code = p.terminationStatus
            self.appendLog("[presence-monitor] daemon exited (code=\(code)), restarting...")
            // Exponential backoff restart
            let delay = min(Double(1 << self.restartCount), self.maxRestartDelay)
            self.restartCount += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.process = nil
                self.start()
            }
        }

        do {
            try proc.run()
            process = proc
            restartCount = 0
            appendLog("[presence-monitor] daemon started (pid=\(proc.processIdentifier))")
        } catch {
            appendLog("[presence-monitor] failed to start daemon: \(error)")
        }
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.terminationHandler = nil  // Don't auto-restart
        proc.terminate()
        process = nil
        appendLog("[presence-monitor] daemon stopped")
    }

    func restart() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.start()
        }
    }

    private func buildEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let defaults = UserDefaults.standard

        // Core settings (always on for the MacBook Pro producer)
        env["TG_RELAY_PRESENCE_PRODUCER"] = "on"
        env["TG_RELAY_TTS_TIMEOUT_MS"] = "300000"

        // Token
        let savedToken = defaults.string(forKey: "presenceToken") ?? ""
        let envToken = ProcessInfo.processInfo.environment["PRESENCE_TOKEN"] ?? ""
        let finalToken = !savedToken.isEmpty ? savedToken : (!envToken.isEmpty ? envToken : "test123")
        env["TG_RELAY_PRESENCE_TOKEN"] = finalToken

        // Toggles
        for t in toggleSettings {
            let on = defaults.object(forKey: t.key) as? Bool ?? t.defaultValue
            env[t.envVar] = on ? "on" : "off"
        }

        // Sliders
        for s in sliderSettings {
            let stored = defaults.integer(forKey: s.key)
            let value = stored > 0 ? clamp(stored, s.min, s.max) : s.defaultValue
            switch s.unit {
            case .seconds:
                env[s.envVar] = String(value)
            case .milliseconds:
                env[s.envVar] = String(value * 1000)
            case .minutes:
                env[s.envVar] = String(value * 60 * 1000)
            }
        }

        return env
    }

    private func appendLog(_ msg: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(msg)\n"
        if let h = FileHandle(forWritingAtPath: logFile) {
            h.seekToEndOfFile()
            h.write(line.data(using: .utf8) ?? Data())
            h.closeFile()
        }
    }
}

// MARK: - Settings Window

class SettingsWindowController: NSObject {
    private var window: NSWindow?
    private var sliders: [(SliderSetting, NSSlider, NSTextField)] = []
    private var toggleButtons: [(ToggleSetting, NSButton)] = []
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
        let padding: CGFloat = 60
        let windowHeight = CGFloat(sliderSettings.count) * rowHeight
            + CGFloat(toggleSettings.count) * toggleHeight
            + padding + 30

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

        // Toggles
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

        // Sliders
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

            let titleLabel = NSTextField(labelWithString: s.label)
            titleLabel.frame = NSRect(x: 20, y: y + 35, width: 300, height: 18)
            titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
            content.addSubview(titleLabel)

            let slider = NSSlider(frame: NSRect(x: 20, y: y + 8, width: 290, height: 20))
            slider.minValue = Double(s.min)
            slider.maxValue = Double(s.max)
            slider.integerValue = value
            slider.isContinuous = true
            slider.target = self
            slider.action = #selector(sliderChanged(_:))
            content.addSubview(slider)

            let valLabel = NSTextField(labelWithString: formatForSetting(s, value))
            valLabel.frame = NSRect(x: 318, y: y + 8, width: 80, height: 20)
            valLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            valLabel.alignment = .right
            content.addSubview(valLabel)

            sliders.append((s, slider, valLabel))
        }

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

        for (s, slider, _) in sliders {
            defaults.set(slider.integerValue, forKey: s.key)
        }
        for (t, btn) in toggleButtons {
            defaults.set(btn.state == .on, forKey: t.key)
        }

        appDelegate?.restartDaemon()
        window?.close()
    }

    private func formatForSetting(_ s: SliderSetting, _ value: Int) -> String {
        if s.unit == .minutes { return "\(value) min" }
        return formatDuration(value)
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
    private let daemon = DaemonManager()
    private var settingsController: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.systemFont(ofSize: 14)
        updateUI(status: nil)

        // Unload the standalone daemon plist if it exists (migration)
        unloadLegacyDaemon()

        // Start the daemon as a child process
        daemon.start()

        // Start polling after a brief delay to let daemon start
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.poll()
            self.timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
                self?.poll()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        daemon.stop()
    }

    private func unloadLegacyDaemon() {
        let plist = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"
        guard FileManager.default.fileExists(atPath: plist) else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["unload", plist]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
    }

    // MARK: - Polling

    private func poll() {
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
            if !daemon.isRunning {
                addDisabled(menu, "⛔ Daemon is not running")
            } else {
                addDisabled(menu, "Daemon starting up…")
            }
            menu.addItem(NSMenuItem.separator())
            addDaemonControls(menu)
            menu.addItem(NSMenuItem.separator())
            addSettingsAndQuit(menu)
            statusItem.menu = menu
            return
        }

        if s.stale {
            statusItem.button?.title = "⚠️"
        } else if s.present {
            statusItem.button?.title = "🟢"
        } else {
            statusItem.button?.title = "🔴"
        }

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

        if let op = s.overridePresent, let exp = s.overrideExpiresIn {
            let label = op ? "HERE" : "AWAY"
            addDisabled(menu, "Override: \(label) (expires in \(formatAge(exp)))")
        }

        menu.addItem(NSMenuItem.separator())

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

    private func addDaemonControls(_ menu: NSMenu) {
        if daemon.isRunning {
            addDisabled(menu, "✅ Daemon running")
        } else {
            addDisabled(menu, "⛔ Daemon stopped")
        }
        let restartItem = NSMenuItem(title: "🔄  Restart Daemon", action: #selector(restartDaemonAction), keyEquivalent: "r")
        restartItem.target = self
        menu.addItem(restartItem)
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

    @objc private func restartDaemonAction() { restartDaemon() }

    func restartDaemon() {
        daemon.restart()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.poll() }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - API calls

    private func postOverride(present: Bool) {
        guard let url = URL(string: "\(baseURL)/presence/override") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let t = ProcessInfo.processInfo.environment["PRESENCE_TOKEN"]
            ?? UserDefaults.standard.string(forKey: "presenceToken") ?? ""
        if !t.isEmpty {
            request.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
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
        let t = ProcessInfo.processInfo.environment["PRESENCE_TOKEN"]
            ?? UserDefaults.standard.string(forKey: "presenceToken") ?? ""
        if !t.isEmpty {
            request.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
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
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
