import Foundation

/// Nudges Claude Code's status line into rewriting the usage cache that `LocalUsageScanner` reads.
///
/// The cache file is the only place the Claude weekly percentage is published locally, and only
/// Claude Code writes it — so while that process sits idle the file can trail the provider's own
/// usage screen by fifteen minutes or more. Running its status-line script ourselves refreshes the
/// file on our own schedule.
///
/// The script is what holds the Keychain grant for the OAuth token, so delegating to it keeps this
/// app out of the credential path entirely. Reading that Keychain item directly would make macOS
/// prompt for the login password on every scan, because the grant names Claude Code and not us.
struct ClaudeUsageCacheRefresher: Sendable {
    /// Matches the cadence the status-line script itself uses; asking more often only spends
    /// processes, since the script serves its own cache back within that window anyway.
    static let defaultInterval: TimeInterval = 60
    /// The script makes one network call, so allow for a slow response without letting a wedged
    /// process outlive the scan loop that spawned it.
    static let defaultTimeout: TimeInterval = 20

    /// Home-relative first: `~/.local/bin/node` is the runtime Claude Code's own installer ships,
    /// so it is the interpreter the script we run is actually tested against. Preferring it also
    /// sidesteps whatever unrelated Node the user happens to have on `PATH` — a Homebrew build with
    /// a certificate bundle that cannot verify the API's issuer fails the fetch while the bundled
    /// runtime succeeds, and the only visible symptom is a usage value that stops moving.
    private static let homeRelativeNodeCandidates = [
        ".local/bin/node",
        "homebrew/bin/node",
    ]

    private static let absoluteNodeCandidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]

    private let nodeURL: URL?
    private let scriptURL: URL
    private let cacheURL: URL
    private let interval: TimeInterval
    private let timeout: TimeInterval

    init(
        claudeConfigDirectory: URL = ClaudeUsageCacheRefresher.defaultConfigDirectory(),
        nodeURL: URL? = ClaudeUsageCacheRefresher.locateNode(),
        interval: TimeInterval = ClaudeUsageCacheRefresher.defaultInterval,
        timeout: TimeInterval = ClaudeUsageCacheRefresher.defaultTimeout
    ) {
        self.nodeURL = nodeURL
        scriptURL = claudeConfigDirectory.appending(path: "hud/omc-hud.mjs")
        cacheURL = claudeConfigDirectory
            .appending(path: "plugins/oh-my-claudecode/.usage-cache-anthropic.json")
        self.interval = interval
        self.timeout = timeout
    }

    static func defaultConfigDirectory() -> URL {
        if let override = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")
    }

    /// Resolves `node` without relying on `PATH`, which a launched app does not inherit from the
    /// user's shell. The login shell is consulted last because it is the slow path.
    static func locateNode() -> URL? {
        let manager = FileManager.default
        let home = manager.homeDirectoryForCurrentUser
        let candidates = homeRelativeNodeCandidates.map { home.appending(path: $0).path }
            + absoluteNodeCandidates
        for path in candidates where manager.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return loginShellNodePath().map(URL.init(fileURLWithPath:))
    }

    private static func loginShellNodePath() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let path = String(data: data, encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty,
              FileManager.default.isExecutableFile(atPath: path) else { return nil }
        return path
    }

    /// Runs the status-line script when the cache has aged past `interval`.
    ///
    /// Returns whether a refresh ran to completion. A missing script, a missing `node`, or a
    /// non-zero exit all report `false`; the caller keeps showing the reading it already has,
    /// because a failed refresh leaves the cache file holding `null` rather than a stale value.
    func refreshIfStale(now: Date = .now) -> Bool {
        guard let nodeURL,
              FileManager.default.isReadableFile(atPath: scriptURL.path),
              isStale(now: now) else { return false }

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [scriptURL.path]
        // The script renders a status line to stdout that means nothing outside a terminal.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let input = Pipe()
        process.standardInput = input

        guard (try? process.run()) != nil else { return false }
        // An empty object is a valid status-line payload: the script fills in its own defaults and,
        // with no session identifier to key on, writes nothing but the usage cache we are after.
        try? input.fileHandleForWriting.write(contentsOf: Data("{}".utf8))
        try? input.fileHandleForWriting.close()

        guard waitForExit(process, deadline: Date(timeIntervalSinceNow: timeout)) else {
            process.terminate()
            return false
        }
        return process.terminationStatus == 0
    }

    private func isStale(now: Date) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: cacheURL.path),
              let modifiedAt = attributes[.modificationDate] as? Date else {
            // No cache yet — the first run is what creates it.
            return true
        }
        return now.timeIntervalSince(modifiedAt) >= interval
    }

    private func waitForExit(_ process: Process, deadline: Date) -> Bool {
        while process.isRunning {
            guard Date() < deadline else { return false }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return true
    }
}
