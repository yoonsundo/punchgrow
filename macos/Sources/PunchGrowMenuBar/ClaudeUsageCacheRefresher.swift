import Darwin
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
        ".volta/bin/node",
    ]

    /// These managers keep installed runtimes below stable roots. Inspecting those directories is
    /// enough to find Node without sourcing shell startup files or invoking manager-controlled
    /// shims (`nvm`, `asdf`, and `mise` all normally populate `PATH` from the shell).
    private static let homeRelativeVersionedNodeRoots = [
        ".nvm/versions/node",
        ".asdf/installs/nodejs",
        ".local/share/mise/installs/node",
        ".mise/installs/node",
    ]

    private static let absoluteNodeCandidates = [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/usr/local/bin/node",
        "/usr/local/opt/node/bin/node",
        "/usr/bin/node",
    ]

    private let nodeResolver: @Sendable () -> URL?
    private let scriptURL: URL
    private let cacheURL: URL
    private let interval: TimeInterval
    private let timeout: TimeInterval
    private let terminationGracePeriod: TimeInterval

    init(
        claudeConfigDirectory: URL = ClaudeUsageCacheRefresher.defaultConfigDirectory(),
        nodeResolver: @escaping @Sendable () -> URL? = {
            ClaudeUsageCacheRefresher.locateNode()
        },
        interval: TimeInterval = ClaudeUsageCacheRefresher.defaultInterval,
        timeout: TimeInterval = ClaudeUsageCacheRefresher.defaultTimeout,
        terminationGracePeriod: TimeInterval = 0.5
    ) {
        self.nodeResolver = nodeResolver
        scriptURL = claudeConfigDirectory.appending(path: "hud/omc-hud.mjs")
        cacheURL = claudeConfigDirectory
            .appending(path: "plugins/oh-my-claudecode/.usage-cache-anthropic.json")
        self.interval = interval
        self.timeout = timeout
        self.terminationGracePeriod = terminationGracePeriod
    }

    static func defaultConfigDirectory() -> URL {
        if let override = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")
    }

    /// Resolves `node` from fixed locations without executing the user's shell or startup files.
    static func locateNode() -> URL? {
        let manager = FileManager.default
        return locateNode(
            homeDirectory: manager.homeDirectoryForCurrentUser,
            fileManager: manager,
            includeSystemCandidates: true
        )
    }

    static func locateNode(
        homeDirectory: URL,
        fileManager manager: FileManager = .default,
        includeSystemCandidates: Bool = true
    ) -> URL? {
        let homeCandidates = homeRelativeNodeCandidates.map {
            homeDirectory.appending(path: $0).path
        }
        let versionedCandidates = homeRelativeVersionedNodeRoots.flatMap { relativeRoot in
            let root = homeDirectory.appending(path: relativeRoot, directoryHint: .isDirectory)
            guard let versions = try? manager.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else { return [String]() }
            return versions
                .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending }
                .map {
                    root.appending(path: $0.lastPathComponent)
                        .appending(path: "bin/node").path
                }
        }
        let candidates = homeCandidates + versionedCandidates
            + (includeSystemCandidates ? absoluteNodeCandidates : [])
        for path in candidates where manager.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    /// Runs the status-line script when the cache has aged past `interval`.
    ///
    /// Returns whether a refresh ran to completion. A missing script, a missing `node`, or a
    /// non-zero exit all report `false`; the caller keeps showing the reading it already has,
    /// because a failed refresh leaves the cache file holding `null` rather than a stale value.
    func refreshIfStale(now: Date = .now) async -> Bool {
        guard !Task.isCancelled,
              FileManager.default.isReadableFile(atPath: scriptURL.path),
              isStale(now: now),
              let nodeURL = nodeResolver(),
              !Task.isCancelled else { return false }

        let cancellation = RefreshProcessCancellation(
            terminationGracePeriod: terminationGracePeriod
        )

        return await withTaskCancellationHandler {
            guard !Task.isCancelled,
                  let pid = Self.spawnRefreshProcess(
                    executableURL: nodeURL,
                    scriptURL: scriptURL
                  ) else { return false }
            cancellation.attach(processGroup: pid)

            let deadline = Date(timeIntervalSinceNow: timeout)
            var status: Int32 = 0
            var waitResult = Self.pollProcess(pid, status: &status)
            while waitResult == 0 {
                guard !Task.isCancelled, Date() < deadline else {
                    cancellation.terminateAndWait()
                    _ = Darwin.waitpid(pid, &status, 0)
                    return false
                }
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    cancellation.terminateAndWait()
                    _ = Darwin.waitpid(pid, &status, 0)
                    return false
                }
                waitResult = Self.pollProcess(pid, status: &status)
            }
            cancellation.clear(processGroup: pid)
            return waitResult == pid && Self.exitedSuccessfully(status)
        } onCancel: {
            cancellation.cancel()
        }
    }

    private func isStale(now: Date) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: cacheURL.path),
              let modifiedAt = attributes[.modificationDate] as? Date else {
            // No cache yet — the first run is what creates it.
            return true
        }
        return now.timeIntervalSince(modifiedAt) >= interval
    }

    private static func spawnRefreshProcess(executableURL: URL, scriptURL: URL) -> pid_t? {
        var inputDescriptors = [Int32](repeating: -1, count: 2)
        guard Darwin.pipe(&inputDescriptors) == 0 else { return nil }
        let nullDescriptor = Darwin.open("/dev/null", O_RDWR)
        guard nullDescriptor >= 0 else {
            Darwin.close(inputDescriptors[0])
            Darwin.close(inputDescriptors[1])
            return nil
        }
        defer {
            Darwin.close(inputDescriptors[0])
            Darwin.close(inputDescriptors[1])
            Darwin.close(nullDescriptor)
        }

        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { return nil }
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else {
            posix_spawn_file_actions_destroy(&actions)
            return nil
        }
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
        }

        guard posix_spawn_file_actions_adddup2(&actions, inputDescriptors[0], STDIN_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, nullDescriptor, STDOUT_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, nullDescriptor, STDERR_FILENO) == 0,
              posix_spawn_file_actions_addclose(&actions, inputDescriptors[0]) == 0,
              posix_spawn_file_actions_addclose(&actions, inputDescriptors[1]) == 0,
              posix_spawn_file_actions_addclose(&actions, nullDescriptor) == 0,
              posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return nil }

        let arguments = [executableURL.path, scriptURL.path]
        let mutableArguments = arguments.map { strdup($0) } + [nil]
        defer { mutableArguments.compactMap { $0 }.forEach { free($0) } }
        let mutableEnvironment = ProcessInfo.processInfo.environment
            .map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { mutableEnvironment.compactMap { $0 }.forEach { free($0) } }

        var pid: pid_t = 0
        let result = executableURL.path.withCString { executablePath in
            posix_spawn(
                &pid,
                executablePath,
                &actions,
                &attributes,
                mutableArguments,
                mutableEnvironment
            )
        }
        guard result == 0 else { return nil }

        // An empty object is a valid status-line payload: the script fills in its own defaults and
        // writes only the usage cache we are after.
        _ = Darwin.fcntl(inputDescriptors[1], F_SETNOSIGPIPE, 1)
        _ = Data("{}".utf8).withUnsafeBytes { bytes in
            Darwin.write(inputDescriptors[1], bytes.baseAddress, bytes.count)
        }
        return pid
    }

    private static func pollProcess(_ pid: pid_t, status: inout Int32) -> pid_t {
        var result: pid_t
        repeat {
            result = Darwin.waitpid(pid, &status, WNOHANG)
        } while result == -1 && errno == EINTR
        return result
    }

    private static func exitedSuccessfully(_ status: Int32) -> Bool {
        (status & 0x7f) == 0 && ((status >> 8) & 0xff) == 0
    }
}

private final class RefreshProcessCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private let terminationGracePeriod: TimeInterval
    private var processGroup: pid_t?
    private var isCancelled = false

    init(terminationGracePeriod: TimeInterval) {
        self.terminationGracePeriod = max(0, terminationGracePeriod)
    }

    func attach(processGroup: pid_t) {
        let shouldTerminate = lock.withLock {
            self.processGroup = processGroup
            return isCancelled
        }
        if shouldTerminate {
            signal(processGroup: processGroup, signal: SIGTERM)
        }
    }

    func cancel() {
        let processGroup = lock.withLock {
            isCancelled = true
            return self.processGroup
        }
        guard let processGroup else { return }
        signal(processGroup: processGroup, signal: SIGTERM)
    }

    func terminateAndWait() {
        cancel()
        guard let processGroup = lock.withLock({ self.processGroup }) else { return }
        waitForGroupExit(processGroup, timeout: terminationGracePeriod)
        if groupExists(processGroup) {
            signal(processGroup: processGroup, signal: SIGKILL)
            waitForGroupExit(processGroup, timeout: 0.5)
        }
    }

    func clear(processGroup: pid_t) {
        lock.withLock {
            if self.processGroup == processGroup {
                self.processGroup = nil
            }
        }
    }

    private func waitForGroupExit(_ processGroup: pid_t, timeout: TimeInterval) {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while groupExists(processGroup), Date() < deadline {
            usleep(10_000)
        }
    }

    private func groupExists(_ processGroup: pid_t) -> Bool {
        Darwin.kill(-processGroup, 0) == 0 || errno == EPERM
    }

    private func signal(processGroup: pid_t, signal: Int32) {
        _ = Darwin.kill(-processGroup, signal)
    }
}
