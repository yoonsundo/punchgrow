import Darwin
import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class SafeFileBoundaryTests: XCTestCase {
  func testPrimaryStateLoadAndMigrationCheckRejectSymbolicLinks() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external.json")
    let stateURL = directory.appending(path: "state.json")
    try JSONEncoder.punchGrow.encode(GameState()).write(to: external)
    try FileManager.default.createSymbolicLink(at: stateURL, withDestinationURL: external)
    let persistence = GamePersistence(fileURL: stateURL)

    XCTAssertThrowsError(try persistence.load())
    XCTAssertThrowsError(try persistence.requiresMigrationCommit())
  }

  func testPrimaryStateRejectsSymbolicLinkedParentDirectory() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let externalDirectory = directory.appending(path: "external-state")
    let linkedDirectory = directory.appending(path: "linked-state")
    try FileManager.default.createDirectory(
      at: externalDirectory, withIntermediateDirectories: true)
    try JSONEncoder.punchGrow.encode(GameState())
      .write(to: externalDirectory.appending(path: "state.json"))
    try FileManager.default.createSymbolicLink(
      at: linkedDirectory, withDestinationURL: externalDirectory)
    let persistence = GamePersistence(
      fileURL: linkedDirectory.appending(path: "state.json"))

    XCTAssertThrowsError(try persistence.load())
    XCTAssertThrowsError(try persistence.requiresMigrationCommit())
    XCTAssertThrowsError(try persistence.save(GameState()))
    XCTAssertEqual(
      try Data(contentsOf: externalDirectory.appending(path: "state.json")),
      try JSONEncoder.punchGrow.encode(GameState())
    )
  }

  func testLocalUsageCacheSaveRejectsSymbolicLinkedParentDirectory() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let externalDirectory = directory.appending(path: "external-cache")
    let linkedDirectory = directory.appending(path: "linked-cache")
    try FileManager.default.createDirectory(
      at: externalDirectory, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: linkedDirectory, withDestinationURL: externalDirectory)
    let persistence = LocalUsageCachePersistence(
      fileURL: linkedDirectory.appending(path: "cache.json"))

    XCTAssertThrowsError(try persistence.save(LocalUsageCache()))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: externalDirectory.appending(path: "cache.json").path))
  }

  func testPrimaryStateLoadAndMigrationCheckRejectNonRegularAndOversizedFiles() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let directoryPersistence = GamePersistence(fileURL: directory)

    XCTAssertThrowsError(try directoryPersistence.load())
    XCTAssertThrowsError(try directoryPersistence.requiresMigrationCommit())

    let oversizedURL = directory.appending(path: "oversized-state.json")
    XCTAssertTrue(FileManager.default.createFile(atPath: oversizedURL.path, contents: nil))
    let handle = try FileHandle(forWritingTo: oversizedURL)
    try handle.truncate(atOffset: 20_000_001)
    try handle.close()
    let oversizedPersistence = GamePersistence(fileURL: oversizedURL)

    XCTAssertThrowsError(try oversizedPersistence.load())
    XCTAssertThrowsError(try oversizedPersistence.requiresMigrationCommit())
  }

  func testDescriptorIdentityRejectsPathReplacement() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "session.jsonl")
    try Data("first\n".utf8).write(to: fileURL)
    let original = try NoFollowRegularFile.open(fileURL, maximumByteCount: 1_024)
    let identity = original.identity
    original.close()
    let replacementURL = directory.appending(path: "replacement.jsonl")
    try Data("replacement\n".utf8).write(to: replacementURL)
    try FileManager.default.removeItem(at: fileURL)
    try FileManager.default.moveItem(at: replacementURL, to: fileURL)

    XCTAssertThrowsError(
      try NoFollowRegularFile.open(
        fileURL, maximumByteCount: 1_024, expectedIdentity: identity))
  }

  func testAppendCompatibleIdentityAcceptsGrowthButStillReadsCapturedSnapshot() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "session.jsonl")
    try Data("first\n".utf8).write(to: fileURL)
    let enumerated = try NoFollowRegularFile.open(fileURL, maximumByteCount: 1_024)
    let identity = enumerated.identity
    enumerated.close()
    let writer = try FileHandle(forWritingTo: fileURL)
    try writer.seekToEnd()
    try writer.write(contentsOf: Data("appended\n".utf8))
    try writer.close()

    let reopened = try NoFollowRegularFile.open(
      fileURL, maximumByteCount: 1_024, expectedIdentity: identity,
      allowsGrowth: true)
    let snapshot = try reopened.read(upToCount: Int(identity.snapshot.size))

    XCTAssertEqual(snapshot, Data("first\n".utf8))
  }

  func testDirectoryAnchorSurvivesParentPathReplacementWithoutEscape() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let anchoredRoot = directory.appending(path: "root")
    let movedRoot = directory.appending(path: "moved-root")
    let replacementRoot = directory.appending(path: "replacement-root")
    try FileManager.default.createDirectory(at: anchoredRoot, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: replacementRoot, withIntermediateDirectories: true)
    try Data("trusted".utf8).write(to: anchoredRoot.appending(path: "state.json"))
    try Data("escaped".utf8).write(to: replacementRoot.appending(path: "state.json"))
    let anchor = try NoFollowDirectory.open(anchoredRoot)
    try FileManager.default.moveItem(at: anchoredRoot, to: movedRoot)
    try FileManager.default.createSymbolicLink(
      at: anchoredRoot, withDestinationURL: replacementRoot)

    let file = try anchor.openFile(
      components: ["state.json"], maximumByteCount: 1_024)

    XCTAssertEqual(try file.readAll(maximumByteCount: 1_024), Data("trusted".utf8))
  }

  func testAtomicWriteReplacesRegularFileAndRestrictsPermissions() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "state.json")
    try Data("old".utf8).write(to: fileURL)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: fileURL.path)
    let originalIdentity = try NoFollowRegularFile.open(
      fileURL, maximumByteCount: 1_024
    ).identity.stable
    let anchor = try NoFollowDirectory.open(directory)

    try anchor.atomicWrite(Data("new state".utf8), fileName: "state.json")

    let replacement = try NoFollowRegularFile.open(fileURL, maximumByteCount: 1_024)
    XCTAssertNotEqual(replacement.identity.stable, originalIdentity)
    XCTAssertEqual(
      try replacement.readAll(maximumByteCount: 1_024), Data("new state".utf8))
    XCTAssertEqual(try permissions(of: fileURL), 0o600)
    XCTAssertEqual(try directoryEntries(at: directory), ["state.json"])
  }

  func testAtomicWritePublishesReplacementAndReturnsUnconfirmedWhenDirectorySyncFails() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "state.json")
    try Data("old".utf8).write(to: fileURL)
    let anchor = try NoFollowDirectory.open(directory)

    let durability = try anchor.atomicWrite(
      Data("new state".utf8),
      fileName: "state.json",
      directorySynchronizer: { _ in
        .directorySyncUnconfirmed(errorCode: EIO)
      })

    XCTAssertEqual(durability, .directorySyncUnconfirmed(errorCode: EIO))
    XCTAssertEqual(try Data(contentsOf: fileURL), Data("new state".utf8))
  }

  func testAtomicWriteRejectsPreexistingTemporarySymlinkWithoutTouchingTarget() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external.json")
    let temporary = directory.appending(path: ".state.fixed.tmp")
    try Data("external".utf8).write(to: external)
    try FileManager.default.createSymbolicLink(at: temporary, withDestinationURL: external)
    let anchor = try NoFollowDirectory.open(directory)

    XCTAssertThrowsError(
      try anchor.atomicWrite(
        Data("replacement".utf8), fileName: "state.json",
        temporaryName: ".state.fixed.tmp"))
    XCTAssertEqual(try Data(contentsOf: external), Data("external".utf8))
    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(atPath: temporary.path),
      external.path)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: directory.appending(path: "state.json").path))
  }

  func testAtomicWriteRejectsFinalSymlinkWithoutTouchingTarget() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external.json")
    let destination = directory.appending(path: "state.json")
    try Data("external".utf8).write(to: external)
    try FileManager.default.createSymbolicLink(
      at: destination, withDestinationURL: external)
    let anchor = try NoFollowDirectory.open(directory)

    XCTAssertThrowsError(
      try anchor.atomicWrite(
        Data("replacement".utf8), fileName: "state.json",
        temporaryName: ".state.fixed.tmp"))

    XCTAssertEqual(try Data(contentsOf: external), Data("external".utf8))
    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(atPath: destination.path),
      external.path)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: directory.appending(path: ".state.fixed.tmp").path))
  }

  func testAtomicWriteCleansUpCreatedTemporaryFileAfterFailure() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(
      at: directory.appending(path: "state.json"), withIntermediateDirectories: true)
    let anchor = try NoFollowDirectory.open(directory)

    XCTAssertThrowsError(
      try anchor.atomicWrite(
        Data("state".utf8), fileName: "state.json",
        temporaryName: ".state.fixed.tmp"))
    XCTAssertEqual(try directoryEntries(at: directory), ["state.json"])
  }

  func testCreatedDirectoryIsRestrictiveAndRejectsSymlinkComponents() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let anchor = try NoFollowDirectory.open(directory)
    let created = try anchor.openOrCreateDirectory(components: ["PunchGrow"])
    try created.atomicWrite(Data("state".utf8), fileName: "state.json")

    let createdURL = directory.appending(path: "PunchGrow")
    XCTAssertEqual(try permissions(of: createdURL), 0o700)
    XCTAssertEqual(try permissions(of: createdURL.appending(path: "state.json")), 0o600)

    let external = directory.appending(path: "external")
    let linked = directory.appending(path: "linked")
    try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: external)
    XCTAssertThrowsError(try anchor.openOrCreateDirectory(components: ["linked"]))
  }

  func testExistingManagedDirectoryPermissionsAreRestricted() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let managed = directory.appending(path: "PunchGrow")
    try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: managed.path)
    let anchor = try NoFollowDirectory.open(directory)

    _ = try anchor.openOrCreateDirectory(components: ["PunchGrow"])

    XCTAssertEqual(try permissions(of: managed), 0o700)
  }

  func testManagedStateLoadAndMigrationCheckTightenExistingPermissions() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let managed = directory.appending(path: "PunchGrow")
    let stateURL = managed.appending(path: "state.json")
    try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    try JSONEncoder.punchGrow.encode(GameState()).write(to: stateURL)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: managed.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: stateURL.path)
    let persistence = GamePersistence(managedStorageAnchorURL: directory)

    XCTAssertFalse(try persistence.requiresMigrationCommit())
    XCTAssertEqual(try permissions(of: managed), 0o700)
    XCTAssertEqual(try permissions(of: stateURL), 0o600)

    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: managed.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: stateURL.path)
    XCTAssertEqual(try persistence.load(), GameState())
    XCTAssertEqual(try permissions(of: managed), 0o700)
    XCTAssertEqual(try permissions(of: stateURL), 0o600)
  }

  func testManagedCacheLoadTightensExistingPermissions() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let managed = directory.appending(path: "PunchGrow")
    let cacheURL = managed.appending(path: "local-usage-cache.json")
    try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    try JSONEncoder.punchGrow.encode(LocalUsageCache()).write(to: cacheURL)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: managed.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: cacheURL.path)
    let persistence = LocalUsageCachePersistence(managedStorageAnchorURL: directory)

    XCTAssertEqual(try persistence.load(), LocalUsageCache())

    XCTAssertEqual(try permissions(of: managed), 0o700)
    XCTAssertEqual(try permissions(of: cacheURL), 0o600)

    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: managed.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: cacheURL.path)
    persistence.migrateManagedPermissionsIfPresent()
    XCTAssertEqual(try permissions(of: managed), 0o700)
    XCTAssertEqual(try permissions(of: cacheURL), 0o600)
  }

  func testInjectedLoadsDoNotAlterCallerPermissions() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let stateURL = directory.appending(path: "state.json")
    let cacheURL = directory.appending(path: "cache.json")
    try JSONEncoder.punchGrow.encode(GameState()).write(to: stateURL)
    try JSONEncoder.punchGrow.encode(LocalUsageCache()).write(to: cacheURL)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: directory.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: stateURL.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o640], ofItemAtPath: cacheURL.path)

    XCTAssertEqual(try GamePersistence(fileURL: stateURL).load(), GameState())
    XCTAssertEqual(
      try LocalUsageCachePersistence(fileURL: cacheURL).load(), LocalUsageCache())
    LocalUsageCachePersistence(fileURL: cacheURL).migrateManagedPermissionsIfPresent()

    XCTAssertEqual(try permissions(of: directory), 0o755)
    XCTAssertEqual(try permissions(of: stateURL), 0o644)
    XCTAssertEqual(try permissions(of: cacheURL), 0o640)
  }

  func testCacheDeleteRemovesRegularCacheAndLegacyTemporaryFile() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cacheURL = directory.appending(path: "cache.json")
    let temporaryURL = directory.appending(path: "cache.json.tmp")
    let generatedTemporaryURL = directory.appending(
      path: ".cache.json.\(UUID().uuidString).tmp")
    let unrelatedURL = directory.appending(path: ".cache.json.not-a-uuid.tmp")
    try Data("cache".utf8).write(to: cacheURL)
    try Data("temporary".utf8).write(to: temporaryURL)
    try Data("generated temporary".utf8).write(to: generatedTemporaryURL)
    try Data("unrelated".utf8).write(to: unrelatedURL)
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)

    try persistence.delete()
    try persistence.delete()

    XCTAssertEqual(try directoryEntries(at: directory), [unrelatedURL.lastPathComponent])
  }

  func testCacheDeleteRejectsGeneratedTemporarySymlinkBeforeDeletingCache() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cacheURL = directory.appending(path: "cache.json")
    let external = directory.appending(path: "external.json")
    let generatedTemporaryURL = directory.appending(
      path: ".cache.json.\(UUID().uuidString).tmp")
    try Data("cache".utf8).write(to: cacheURL)
    try Data("external".utf8).write(to: external)
    try FileManager.default.createSymbolicLink(
      at: generatedTemporaryURL, withDestinationURL: external)
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)

    XCTAssertThrowsError(try persistence.delete())
    XCTAssertEqual(try Data(contentsOf: cacheURL), Data("cache".utf8))
    XCTAssertEqual(try Data(contentsOf: external), Data("external".utf8))
    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(
        atPath: generatedTemporaryURL.path),
      external.path)
  }

  func testCacheDeleteRejectsSymbolicLinkedParentWithoutEscape() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external")
    let linked = directory.appending(path: "linked")
    let externalCache = external.appending(path: "cache.json")
    let externalTemporary = external.appending(path: "cache.json.tmp")
    try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
    try Data("cache".utf8).write(to: externalCache)
    try Data("temporary".utf8).write(to: externalTemporary)
    try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: external)
    let persistence = LocalUsageCachePersistence(
      fileURL: linked.appending(path: "cache.json"))

    XCTAssertThrowsError(try persistence.delete())
    XCTAssertEqual(try Data(contentsOf: externalCache), Data("cache".utf8))
    XCTAssertEqual(try Data(contentsOf: externalTemporary), Data("temporary".utf8))
  }

  func testCacheDeleteRejectsFinalDirectoryAndPreservesLegacyTemporaryFile() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cacheURL = directory.appending(path: "cache.json")
    let temporaryURL = directory.appending(path: "cache.json.tmp")
    try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true)
    try Data("temporary".utf8).write(to: temporaryURL)
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)

    XCTAssertThrowsError(try persistence.delete())
    XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))
    XCTAssertEqual(try Data(contentsOf: temporaryURL), Data("temporary".utf8))
  }

  func testCacheDeleteRejectsFinalSymlinkWithoutTouchingTarget() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external.json")
    let cacheURL = directory.appending(path: "cache.json")
    try Data("external".utf8).write(to: external)
    try FileManager.default.createSymbolicLink(at: cacheURL, withDestinationURL: external)
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)

    XCTAssertThrowsError(try persistence.delete())
    XCTAssertEqual(try Data(contentsOf: external), Data("external".utf8))
    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(atPath: cacheURL.path),
      external.path)
  }

  func testBackupRestoreRejectsSymbolicLinkAsInvalidBackup() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let external = directory.appending(path: "external.pgrow")
    let linkedBackup = directory.appending(path: "linked.pgrow")
    try persistence.export(GameState(), to: external)
    try FileManager.default.createSymbolicLink(
      at: linkedBackup, withDestinationURL: external)

    XCTAssertThrowsError(try persistence.restore(from: linkedBackup)) { error in
      XCTAssertEqual(error as? GameError, .invalidBackup)
    }
  }

  func testBackupExportAllowsAuthorizedLinkedParentAndRestrictsPermissions() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let selectedDirectory = directory.appending(path: "selected")
    let linkedDirectory = directory.appending(path: "selected-link")
    try FileManager.default.createDirectory(
      at: selectedDirectory, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: linkedDirectory, withDestinationURL: selectedDirectory)
    let destination = linkedDirectory.appending(path: "backup.pgrow")
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))

    try persistence.export(GameState(), to: destination)

    XCTAssertEqual(try permissions(of: selectedDirectory.appending(path: "backup.pgrow")), 0o600)
    XCTAssertEqual(try persistence.restore(from: destination), GameState())
  }

  func testBackupExportRejectsFinalSymlinkWithoutTouchingTarget() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external.pgrow")
    let destination = directory.appending(path: "backup.pgrow")
    try Data("external".utf8).write(to: external)
    try FileManager.default.createSymbolicLink(
      at: destination, withDestinationURL: external)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))

    XCTAssertThrowsError(try persistence.export(GameState(), to: destination))
    XCTAssertEqual(try Data(contentsOf: external), Data("external".utf8))
  }

  func testLocalUsageCacheRejectsSymbolicLinkAndRetainsCorruptDecodeFallback() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let external = directory.appending(path: "external-cache.json")
    let cacheURL = directory.appending(path: "local-usage-cache.json")
    try JSONEncoder.punchGrow.encode(LocalUsageCache()).write(to: external)
    try FileManager.default.createSymbolicLink(at: cacheURL, withDestinationURL: external)
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)

    XCTAssertThrowsError(try persistence.load())

    try FileManager.default.removeItem(at: cacheURL)
    try Data("{corrupt-cache".utf8).write(to: cacheURL)
    XCTAssertEqual(try persistence.load(), LocalUsageCache())

    try FileManager.default.removeItem(at: cacheURL)
    XCTAssertTrue(FileManager.default.createFile(atPath: cacheURL.path, contents: nil))
    let handle = try FileHandle(forWritingTo: cacheURL)
    try handle.truncate(atOffset: 100_000_001)
    try handle.close()
    XCTAssertThrowsError(try persistence.load()) { error in
      XCTAssertEqual(error as? CollectorError, .invalidPayload)
    }
  }

  private func makeTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-safe-file-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func permissions(of url: URL) throws -> mode_t {
    var status = stat()
    guard url.path.withCString({ Darwin.lstat($0, &status) }) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return status.st_mode & 0o777
  }

  private func directoryEntries(at url: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
  }
}
