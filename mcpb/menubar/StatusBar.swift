// Always-visible menu bar item for download progress.
//
// The chat window is turn-based, so an extension cannot push updates into it,
// and a progress page only helps while you are looking at it. The menu bar is
// the one surface on macOS that is always on screen, so that is where a
// long-running job belongs.
//
// Reads the same job JSON the extension and CLI already write. It is a viewer
// with no state of its own: nothing here can corrupt a download, and killing it
// at any moment is safe.
//
// Build:
//   swiftc -O -o spotify-statusbar StatusBar.swift -framework Cocoa

import Cocoa

struct Job {
    let id: String
    let phase: String
    let playlist: String
    let done: Int
    let total: Int
    let outputDir: String?
    let updatedAt: Date?

    var isActive: Bool {
        !["completed", "failed", "cancelled"].contains(phase)
    }

    var percent: Int {
        total > 0 ? Int((Double(done) / Double(total)) * 100) : 0
    }
}

final class StatusBarController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private var jobs: [Job] = []

    private lazy var jobsDir: URL = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/SpotifyPlaylistDownloader/jobs")

    func applicationDidFinishLaunching(_ note: Notification) {
        // .accessory keeps it out of the Dock and the app switcher. It is a
        // status indicator, not something you alt-tab to.
        NSApp.setActivationPolicy(.accessory)

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "♪"

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: - Reading state

    private func loadJobs() -> [Job] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: jobsDir.path)
        else { return [] }

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return names.compactMap { name -> Job? in
            guard name.hasSuffix(".json") else { return nil }
            guard
                let data = try? Data(contentsOf: jobsDir.appendingPathComponent(name)),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }

            return Job(
                id: obj["id"] as? String ?? "",
                phase: obj["phase"] as? String ?? "unknown",
                playlist: obj["playlistName"] as? String ?? "Download",
                done: obj["trackCount"] as? Int ?? 0,
                total: obj["trackTotal"] as? Int ?? 0,
                outputDir: obj["outputDir"] as? String,
                updatedAt: (obj["updatedAt"] as? String).flatMap { iso.date(from: $0) }
            )
        }
        .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
    }

    // MARK: - Rendering

    private func refresh() {
        jobs = loadJobs()
        let active = jobs.filter { $0.isActive }

        if let job = active.first {
            item.button?.title = title(for: job)
        } else {
            // Nothing running. Stay quiet rather than showing a stale number.
            item.button?.title = "♪"
        }

        item.menu = buildMenu(active: active)
    }

    private func title(for job: Job) -> String {
        switch job.phase {
        case "fetching_metadata":
            return "♪ reading…"
        case "downloading":
            // Counts, not a percentage. "47 of 116" says how much is left in a
            // way a percentage does not.
            return job.total > 0 ? "♪ \(job.done)/\(job.total)" : "♪ \(job.done)"
        default:
            return "♪ \(job.phase)"
        }
    }

    private func buildMenu(active: [Job]) -> NSMenu {
        let menu = NSMenu()

        if active.isEmpty {
            menu.addItem(disabled("No downloads running"))
        } else {
            for job in active {
                menu.addItem(disabled(job.playlist))
                let detail = job.phase == "fetching_metadata"
                    ? "   Reading the track list…"
                    : "   \(job.done) of \(job.total) tracks  ·  \(job.percent)%"
                menu.addItem(disabled(detail))

                if job.outputDir != nil {
                    let show = NSMenuItem(
                        title: "   Show progress window",
                        action: #selector(openProgress(_:)), keyEquivalent: "")
                    show.target = self
                    show.representedObject = job
                    menu.addItem(show)
                }

                let cancel = NSMenuItem(
                    title: "   Cancel this download",
                    action: #selector(cancelJob(_:)), keyEquivalent: "")
                cancel.target = self
                cancel.representedObject = job
                menu.addItem(cancel)
                menu.addItem(.separator())
            }
        }

        let recent = jobs.filter { !$0.isActive }.prefix(5)
        if !recent.isEmpty {
            menu.addItem(disabled("Recent"))
            for job in recent {
                let mark = job.phase == "completed" ? "✓" : "✗"
                let entry = NSMenuItem(
                    title: "   \(mark) \(job.playlist) — \(job.done)/\(job.total)",
                    action: job.outputDir != nil ? #selector(openFolder(_:)) : nil,
                    keyEquivalent: "")
                entry.target = self
                entry.representedObject = job
                menu.addItem(entry)
            }
            menu.addItem(.separator())
        }

        let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    private func disabled(_ text: String) -> NSMenuItem {
        let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    // MARK: - Actions

    @objc private func openProgress(_ sender: NSMenuItem) {
        guard let job = sender.representedObject as? Job, let dir = job.outputDir else { return }
        let page = URL(fileURLWithPath: dir).appendingPathComponent("progress.html")
        if FileManager.default.fileExists(atPath: page.path) {
            NSWorkspace.shared.open(page)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: dir))
        }
    }

    @objc private func openFolder(_ sender: NSMenuItem) {
        guard let job = sender.representedObject as? Job, let dir = job.outputDir else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    @objc private func cancelJob(_ sender: NSMenuItem) {
        guard let job = sender.representedObject as? Job else { return }
        // Same marker file the extension and CLI use, so all three interfaces
        // agree on what cancellation means.
        let marker = jobsDir.appendingPathComponent("\(job.id).cancel")
        try? Data(Date().description.utf8).write(to: marker)
        refresh()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let controller = StatusBarController()
app.delegate = controller
app.run()
