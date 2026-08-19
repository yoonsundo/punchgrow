import Darwin
import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class ClaudeUsageCacheRefresherTests: XCTestCase {
  @MainActor
  func testDisabledServiceDoesNotResolveNodeOrLaunchRefresh() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-refresh-consent-\(UUID().uuidString)")
    let suiteName = "ClaudeUsageCacheRefresherConsentTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    let probe = ResolverProbe()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      defaults.removePersistentDomain(forName: suiteName)
      try? FileManager.default.removeItem(at: directory)
    }
    let refresher = ClaudeUsageCacheRefresher(
      claudeConfigDirectory: directory,
      nodeResolver: {
        probe.recordResolution()
        return nil
      },
      interval: 0
    )

    let service = LocalUsageService(
      cacheRefresher: refresher,
      interval: 0.01,
      defaults: defaults,
      onEvents: { _ in .duplicate }
    )
    try await Task.sleep(for: .milliseconds(100))

    XCTAssertFalse(service.collectionEnabled)
    XCTAssertFalse(service.isRunning)
    XCTAssertEqual(probe.resolutionCount, 0)
  }

  func testCancellingRefreshForceKillsSIGTERMResistantChild() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-refresh-cancellation-\(UUID().uuidString)")
    let configDirectory = directory.appending(path: "config")
    let scriptURL = configDirectory.appending(path: "hud/omc-hud.mjs")
    let pidURL = directory.appending(path: "child.pid")
    try FileManager.default.createDirectory(
      at: scriptURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let quotedPIDPath = pidURL.path.replacingOccurrences(of: "'", with: "'\\''")
    let script = """
      trap '' TERM
      (trap '' TERM; while :; do sleep 1; done) &
      echo $! > '\(quotedPIDPath)'
      while :; do sleep 1; done
      """
    try Data(script.utf8).write(to: scriptURL)
    let refresher = ClaudeUsageCacheRefresher(
      claudeConfigDirectory: configDirectory,
      nodeResolver: { URL(fileURLWithPath: "/bin/sh") },
      interval: 0,
      timeout: 60,
      terminationGracePeriod: 0.1
    )

    let refresh = Task { await refresher.refreshIfStale() }
    var childPID: pid_t?
    for _ in 0..<200 where childPID == nil {
      if let contents = try? String(contentsOf: pidURL, encoding: .utf8),
         let parsed = pid_t(contents.trimmingCharacters(in: .whitespacesAndNewlines)) {
        childPID = parsed
      } else {
        try await Task.sleep(for: .milliseconds(5))
      }
    }
    let pid = try XCTUnwrap(childPID)

    refresh.cancel()
    let completed = await refresh.value
    XCTAssertFalse(completed)
    for _ in 0..<200 where kill(pid, 0) == 0 {
      try await Task.sleep(for: .milliseconds(5))
    }

    XCTAssertEqual(kill(pid, 0), -1)
    XCTAssertEqual(errno, ESRCH)
  }

  func testLocateNodeFindsFixedVersionManagerInstallationsWithoutShellExecution() throws {
    let roots = [
      ".volta/bin/node",
      ".nvm/versions/node/v22.17.0/bin/node",
      ".asdf/installs/nodejs/22.17.0/bin/node",
      ".local/share/mise/installs/node/22.17.0/bin/node",
      ".mise/installs/node/22.17.0/bin/node",
    ]

    for relativePath in roots {
      let home = FileManager.default.temporaryDirectory
        .appending(path: "punchgrow-node-discovery-\(UUID().uuidString)")
      let node = home.appending(path: relativePath)
      try FileManager.default.createDirectory(
        at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
      XCTAssertTrue(FileManager.default.createFile(atPath: node.path, contents: Data()))
      XCTAssertEqual(chmod(node.path, S_IRUSR | S_IWUSR | S_IXUSR), 0)
      defer { try? FileManager.default.removeItem(at: home) }

      XCTAssertEqual(
        ClaudeUsageCacheRefresher.locateNode(
          homeDirectory: home,
          includeSystemCandidates: false
        ),
        node
      )
    }
  }
}

private final class ResolverProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  var resolutionCount: Int {
    lock.withLock { count }
  }

  func recordResolution() {
    lock.withLock { count += 1 }
  }
}
