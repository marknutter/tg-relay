/**
 * Presence menubar app — macOS status-bar indicator for tg-relay presence.
 *
 * Shows 🟢 (present), 🔴 (away), ⚠️ (stale), or ❓ (unreachable) in the
 * menubar. Dropdown shows state details, daemon status, and lets you:
 * - Toggle /here /away overrides via the daemon's HTTP API
 * - Start / Stop / Restart the tg-relay daemon (via launchctl)
 *
 * Usage:
 *   swiftc -o PresenceMenuBar PresenceMenuBar.swift -framework Cocoa && ./PresenceMenuBar
 *
 * Environment:
 *   PRESENCE_URL    — daemon endpoint (default: http://localhost:7780)
 *   PRESENCE_TOKEN  — bearer token for override actions (same as daemon's TG_RELAY_PRESENCE_TOKEN)
 */

import Cocoa
import Foundation

// MARK: - Configuration

let baseURL = ProcessInfo.processInfo.environment["PRESENCE_URL"] ?? "http://localhost:7780"
let token   = ProcessInfo.processInfo.environment["PRESENCE_TOKEN"] ?? ""
let pollInterval: TimeInterval = 5.0

let daemonLabel = "com.marknutter.tg-relay"
let daemonPlist = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"
let menubarLabel = "com.marknutter.presence-menubar"
let menubarPlist = "\(NSHomeDirectory())/Library/LaunchAgents/\(menubarLabel).plist"

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

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var lastStatus: PresenceStatus?
    private var daemonRunning: Bool = false

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
        // Check daemon status
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
                addDisabled(menu, "Daemon is running but endpoint not reachable")
            }
            addDisabled(menu, "\(baseURL)/presence")
            menu.addItem(NSMenuItem.separator())
            addDaemonControls(menu)
            menu.addItem(NSMenuItem.separator())
            addQuit(menu)
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

        // Daemon controls
        addDaemonControls(menu)

        menu.addItem(NSMenuItem.separator())
        addQuit(menu)

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

    // MARK: - Actions

    @objc private func setHere() {
        postOverride(present: true)
    }

    @objc private func setAway() {
        postOverride(present: false)
    }

    @objc private func clearOverride() {
        deleteOverride()
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
        // kickstart -k restarts in-place using the CURRENT plist
        let uid = getuid()
        runLaunchctl(["kickstart", "-k", "gui/\(uid)/\(daemonLabel)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.poll() }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

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
            // Re-poll immediately so the UI updates.
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

    private func addQuit(_ menu: NSMenu) {
        let quitItem = NSMenuItem(title: "Quit Presence Monitor", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
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
