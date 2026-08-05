import Foundation
import XCTest

@testable import PunchGrowMenuBar

private final class ScanOverlapProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var active = 0
  private var starts = 0
  private var peak = 0

  func runUntilCancelled() throws -> LocalUsageScanResult {
    lock.lock()
    active += 1
    starts += 1
    peak = max(peak, active)
    lock.unlock()
    defer {
      lock.lock()
      active -= 1
      lock.unlock()
    }
    while !Task.isCancelled {
      Thread.sleep(forTimeInterval: 0.005)
    }
    throw CancellationError()
  }

  func snapshot() -> (active: Int, starts: Int, peak: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (active, starts, peak)
  }
}

final class LocalUsageReaderTests: XCTestCase {
  private var temporaryDirectory: URL!
  private var claudeRoot: URL!
  private var codexRoot: URL!

  override func setUpWithError() throws {
    temporaryDirectory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-local-usage-\(UUID().uuidString)")
    claudeRoot = temporaryDirectory.appending(path: "claude-projects")
    codexRoot = temporaryDirectory.appending(path: "codex-sessions")
    try FileManager.default.createDirectory(at: claudeRoot, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: codexRoot, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: temporaryDirectory)
  }

  func testFirstScanReportsClaudeAndCodexTotalsWithoutCreditingHistoricalUsage() throws {
    try write(
      [
        claudeLine(messageID: "message-a", requestID: "request-a", output: 5),
        claudeLine(messageID: "message-a", requestID: "request-a", output: 200),
      ],
      to: claudeRoot.appending(path: "project/session.jsonl")
    )
    try write(
      [codexLine(input: 1_000, cached: 200, output: 50)],
      to: codexRoot.appending(path: "2026/08/rollout-a.jsonl")
    )

    let result = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    XCTAssertEqual(result.observedTotals[.claude], 1_310)
    XCTAssertEqual(result.observedTotals[.codex], 1_050)
    XCTAssertTrue(result.creditEvents.isEmpty, "기존 로그는 설치 직후 잔액으로 소급 적립하면 안 된다")
    XCTAssertTrue(result.cache.baselineCompleted)
  }

  func testSecondScanCreditsOnlyNewClaudeDeltaAndDoesNotReplayDuplicateStreamFrames() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write(
      [claudeLine(messageID: "message-a", requestID: "request-a", output: 20)],
      to: log
    )
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    try append(
      [
        claudeLine(messageID: "message-a", requestID: "request-a", output: 100),
        claudeLine(messageID: "message-a", requestID: "request-a", output: 100),
      ],
      to: log
    )
    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    let events = result.creditEvents.filter { $0.provider == .claude }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events[0].inputTokens, 0)
    XCTAssertEqual(events[0].cachedTokens, 0)
    XCTAssertEqual(events[0].outputTokens, 80)
  }

  func testClaudeDedupKeyIncludesBothMessageAndRequestIdentifiers() throws {
    try write(
      [
        claudeLine(messageID: "shared-message", requestID: "request-a", output: 1),
        claudeLine(messageID: "shared-message", requestID: "request-b", output: 2),
      ],
      to: claudeRoot.appending(path: "project/session.jsonl")
    )

    let result = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    XCTAssertEqual(result.observedTotals[.claude], 2_223)
    XCTAssertEqual(result.cache.claudeMaximums.count, 2)
  }

  func testCodexTotalUsageCreditsCumulativeGrowthWhileLastUsageRisesAndFalls() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        codexSessionMetadata(),
        codexTaskStarted(turnID: "turn-a", startedAt: 1_785_747_600),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:01.000Z",
          lastInput: 120, lastCached: 20, lastOutput: 10,
          totalInput: 120, totalCached: 20, totalOutput: 10),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:02.000Z",
          lastInput: 50, lastCached: 5, lastOutput: 2,
          totalInput: 220, totalCached: 40, totalOutput: 30),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:03.000Z",
          lastInput: 160, lastCached: 30, lastOutput: 20,
          totalInput: 220, totalCached: 40, totalOutput: 30),
      ],
      to: codexRoot.appending(path: "2026/08/rollout-frames.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))
    let events = result.creditEvents.filter { $0.provider == .codex }

    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(events.reduce(0) { $0 + $1.totalTokens }, 250, "누적 130→250→250은 630이 아니라 250만 적립해야 한다")
    XCTAssertEqual(result.observedWeeklyBreakdown[.codex]?.inputTokens, 180)
    XCTAssertEqual(result.observedWeeklyBreakdown[.codex]?.cachedTokens, 40)
    XCTAssertEqual(result.observedWeeklyBreakdown[.codex]?.outputTokens, 30)
  }

  func testCodexMissingTurnKeyUsesConservativeSessionSnapshotMaximum() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        codexSessionMetadata(),
        codexLine(timestamp: "2026-08-03T09:00:01.000Z", input: 120, cached: 20, output: 10),
        codexLine(timestamp: "2026-08-03T09:00:02.000Z", input: 220, cached: 40, output: 30),
        codexLine(timestamp: "2026-08-03T09:00:03.000Z", input: 220, cached: 40, output: 30),
      ],
      to: codexRoot.appending(path: "2026/08/rollout-no-turn.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.creditEvents.filter { $0.provider == .codex }.reduce(0) { $0 + $1.totalTokens }, 250)
    XCTAssertEqual(result.cache.codexMaximums.count, 1)
  }

  func testCodexSlowForkReplayIsExcludedUntilStructurallyNewChildTaskStarts() throws {
    let log = codexRoot.appending(path: "2026/08/rollout-child.jsonl")
    try write(
      [codexLine(input: 100, cached: 20, output: 10)],
      to: codexRoot.appending(path: "2026/08/rollout-parent.jsonl")
    )
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    try write(
      [
        codexForkMetadata(),
        codexTaskStarted(turnID: "replayed-parent-turn", startedAt: 1_785_747_000),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:00.010Z",
          lastInput: 100, lastCached: 20, lastOutput: 10,
          totalInput: 100, totalCached: 20, totalOutput: 10),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:30.000Z",
          lastInput: 120, lastCached: 25, lastOutput: 12,
          totalInput: 120, totalCached: 25, totalOutput: 12),
        codexTaskStarted(turnID: "first-child-turn", startedAt: 1_785_747_600),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:30.001Z",
          lastInput: 40, lastCached: 10, lastOutput: 8,
          totalInput: 160, totalCached: 35, totalOutput: 20),
      ],
      to: log
    )
    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    let events = result.creditEvents.filter { $0.provider == .codex }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events[0].inputTokens, 30)
    XCTAssertEqual(events[0].cachedTokens, 10)
    XCTAssertEqual(events[0].outputTokens, 8)
  }

  func testCodexRapidFirstChildTurnIsCreditedWithoutOneSecondDelay() throws {
    let log = codexRoot.appending(path: "2026/08/rollout-rapid-child.jsonl")
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        codexForkMetadata(),
        codexTaskStarted(turnID: "first-child-turn", startedAt: 1_785_747_600),
        codexLine(timestamp: "2026-08-03T09:00:00.002Z", input: 40, cached: 10, output: 9),
      ],
      to: log
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    let events = result.creditEvents.filter { $0.provider == .codex }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events[0].totalTokens, 49)
  }

  func testForkReplayParentMetadataDoesNotReplaceChildSessionIdentity() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = codexRoot.appending(path: "2026/08/rollout-child-with-parent-meta.jsonl")
    try write(
      [
        codexForkMetadata(),
        #"{"type":"session_meta","timestamp":"2026-08-03T08:30:00.000Z","payload":{"id":"parent","timestamp":"2026-08-03T08:30:00.000Z","thread_source":"cli"}}"#,
        codexTaskStarted(turnID: "replayed-parent-turn", startedAt: 1_785_747_000),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:00.010Z",
          lastInput: 100, lastCached: 20, lastOutput: 10,
          totalInput: 100, totalCached: 20, totalOutput: 10),
        codexTaskStarted(turnID: "first-child-turn", startedAt: 1_785_747_600),
        codexCumulativeLine(
          timestamp: "2026-08-03T09:00:00.020Z",
          lastInput: 40, lastCached: 10, lastOutput: 8,
          totalInput: 140, totalCached: 30, totalOutput: 18),
      ],
      to: log
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))
    let expectedSessionKey = LocalUsageScanner.hash("codex-session:child")
    let expectedTotalKey = LocalUsageScanner.hash("codex-session-total:\(expectedSessionKey)")

    XCTAssertEqual(result.creditEvents.filter { $0.provider == .codex }.map(\.totalTokens), [48])
    XCTAssertNotNil(result.cache.codexMaximums[expectedTotalKey])
  }

  func testMalformedAndTruncatedLinesDoNotBlockLaterValidUsage() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write([claudeLine(messageID: "baseline", requestID: "baseline", output: 1)], to: log)
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    try append(
      [
        #"{"type":"assistant","message":{"usage":{"input_tokens":999"#,
        "not-json",
        claudeLine(messageID: "invalid", requestID: "invalid", input: -1, output: 4),
        claudeLine(messageID: "valid", requestID: "valid", input: 7, output: 11, cacheWrite: 2, cacheRead: 3),
      ],
      to: log
    )
    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.creditEvents.count, 1)
    XCTAssertEqual(result.creditEvents[0].totalTokens, 23)
  }

  func testOversizedIrrelevantRecordDoesNotBlockFollowingClaudeUsage() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/oversized.jsonl")
    try writeOversizedIrrelevantRecord(
      payloadByteCount: 57_100_000,
      followedBy: claudeLine(
        messageID: "after-large-record", requestID: "after-large-record",
        input: 7, output: 11, cacheWrite: 2, cacheRead: 3),
      to: log
    )

    var cache = baseline.cache
    var credited: [Int] = []
    for batch in 1...20 where credited.isEmpty {
      let result = try scanner.scan(
        cache: cache, now: fixedNow.addingTimeInterval(Double(batch * 60)))
      cache = result.cache
      credited += result.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens)
    }

    XCTAssertEqual(credited, [23])
    XCTAssertNil(cache.files.values.first?.discardingOversizedLine)
  }

  func testActiveFileGrowthIsDeferredBeyondSnapshottedSizeThenCreditedOnce() async throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/growing.jsonl")
    try writeOversizedIrrelevantRecord(payloadByteCount: 57_100_000, to: log)
    let snapshottedSize = UInt64(try XCTUnwrap(
      log.resourceValues(forKeys: [.fileSizeKey]).fileSize))
    let scanner = scanner
    let scanNow = fixedNow.addingTimeInterval(30)
    let scanTask = Task.detached {
      try scanner.scan(cache: baseline.cache, now: scanNow)
    }
    try await Task.sleep(for: .milliseconds(50))
    try append(
      [
        claudeLine(
          messageID: "appended-during-scan", requestID: "appended-during-scan",
          input: 7, output: 11, cacheWrite: 2, cacheRead: 3)
      ],
      to: log
    )

    let raced = try await scanTask.value
    let cursor = try XCTUnwrap(raced.cache.files.values.first)
    XCTAssertEqual(cursor.fileSize, snapshottedSize)
    XCTAssertLessThanOrEqual(cursor.byteOffset, cursor.fileSize)
    XCTAssertNoThrow(try raced.cache.validate())
    XCTAssertTrue(raced.creditEvents.isEmpty)

    var cache = raced.cache
    var credited: [Int] = []
    for batch in 1...20 where credited.isEmpty {
      let completed = try scanner.scan(
        cache: cache, now: fixedNow.addingTimeInterval(Double(60 + batch * 30)))
      cache = completed.cache
      credited += completed.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens)
    }
    let replay = try scanner.scan(
      cache: cache, now: fixedNow.addingTimeInterval(900))

    XCTAssertEqual(credited, [23])
    XCTAssertTrue(replay.creditEvents.isEmpty)
  }

  func testBoundedBaselineResumesWithoutCreditingUntilAllFilesDrain() throws {
    let budget = 1_024
    let boundedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot,
      providerBodyReadSoftBudget: budget)
    let lines = (0..<2_000).map { index in
      claudeLine(messageID: "historical-\(index)", requestID: "historical-\(index)", output: 1)
    }
    try write(lines, to: claudeRoot.appending(path: "project/batched.jsonl"))

    let first = try boundedScanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let firstCursor = try XCTUnwrap(first.cache.files.values.first)

    XCTAssertTrue(first.hasDrainableBacklog)
    XCTAssertFalse(first.cache.baselineCompletedProviders?.contains(.claude) == true)
    XCTAssertTrue(first.creditEvents.isEmpty)
    XCTAssertLessThan(firstCursor.byteOffset, firstCursor.fileSize)

    var cache = first.cache
    var batchCount = 1
    while cache.baselineCompletedProviders?.contains(.claude) != true, batchCount < 1_000 {
      let batch = try boundedScanner.scan(
        cache: cache, now: fixedNow.addingTimeInterval(Double(batchCount)))
      XCTAssertTrue(batch.creditEvents.isEmpty)
      cache = batch.cache
      batchCount += 1
    }

    XCTAssertTrue(cache.baselineCompletedProviders?.contains(.claude) == true)
    XCTAssertLessThan(batchCount, 1_000)
  }

  func testUnterminatedWriterTailDoesNotRequestImmediateDrain() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/writer-tail.jsonl")
    try write([], to: log)
    try appendRaw(
      claudeLine(messageID: "tail", requestID: "tail", output: 4),
      to: log
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow)

    XCTAssertFalse(result.hasDrainableBacklog)
    XCTAssertTrue(result.creditEvents.isEmpty)
    XCTAssertEqual(result.cache.files.values.first?.byteOffset, 0)
  }

  func testWriterTailLargerThanSoftBudgetStillUsesIdleDelayClassification() throws {
    let boundedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot,
      providerBodyReadSoftBudget: 1 * 1_024 * 1_024)
    let baseline = try boundedScanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/large-writer-tail.jsonl")
    try write([], to: log)
    try appendRaw(String(repeating: "x", count: 5 * 1_024 * 1_024), to: log)

    let result = try boundedScanner.scan(cache: baseline.cache, now: fixedNow)

    XCTAssertFalse(result.hasDrainableBacklog)
    XCTAssertEqual(result.cache.files.values.first?.byteOffset, 0)
    XCTAssertTrue(result.creditEvents.isEmpty)
  }

  func testOversizedDiscardStatePersistsAndResumesAcrossSmallBatches() throws {
    let boundedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot,
      providerBodyReadSoftBudget: 1_024 * 1_024)
    let baseline = try boundedScanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/resumable-oversized.jsonl")
    try writeOversizedIrrelevantRecord(
      payloadByteCount: 10 * 1_024 * 1_024,
      followedBy: claudeLine(
        messageID: "after-resume", requestID: "after-resume",
        input: 7, output: 11, cacheWrite: 2, cacheRead: 3),
      to: log)

    var result = try boundedScanner.scan(cache: baseline.cache, now: fixedNow)
    var sawDiscardState = result.cache.files.values.contains {
      $0.discardingOversizedLine == true
    }
    var credited: [Int] = []
    for batch in 1...20 where credited.isEmpty {
      result = try boundedScanner.scan(
        cache: result.cache, now: fixedNow.addingTimeInterval(Double(batch)))
      sawDiscardState = sawDiscardState || result.cache.files.values.contains {
        $0.discardingOversizedLine == true
      }
      credited += result.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens)
    }

    XCTAssertTrue(sawDiscardState)
    XCTAssertEqual(credited, [23])
    XCTAssertFalse(result.cache.files.values.contains { $0.discardingOversizedLine == true })
  }

  func testTruncateClearsPersistedOversizedDiscardState() throws {
    let boundedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot,
      providerBodyReadSoftBudget: 1 * 1_024 * 1_024)
    let baseline = try boundedScanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/discard-then-truncate.jsonl")
    try writeOversizedIrrelevantRecord(payloadByteCount: 10 * 1_024 * 1_024, to: log)
    let discarding = try boundedScanner.scan(cache: baseline.cache, now: fixedNow)
    XCTAssertTrue(discarding.cache.files.values.contains { $0.discardingOversizedLine == true })

    try write(
      [claudeLine(
        messageID: "after-truncate", requestID: "after-truncate",
        input: 7, output: 11, cacheWrite: 2, cacheRead: 3)],
      to: log)
    let recovered = try boundedScanner.scan(
      cache: discarding.cache, now: fixedNow.addingTimeInterval(1))

    XCTAssertFalse(recovered.cache.files.values.contains { $0.discardingOversizedLine == true })
    XCTAssertEqual(recovered.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens), [23])
  }

  func testPersistedFileRotationAllowsLaterFileToProgressAfterLongLine() throws {
    let budget = 1_024
    let boundedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot,
      providerBodyReadSoftBudget: budget)
    let candidates = (0..<8).map { claudeRoot.appending(path: "project/\($0).jsonl") }
    let ordered = candidates.sorted {
      LocalUsageScanner.hash("file:claude:\($0.path)")
        < LocalUsageScanner.hash("file:claude:\($1.path)")
    }
    let long = ordered[0]
    let later = ordered[1]
    try write([String(repeating: "x", count: 128 * 1_024)], to: long)
    try write(
      [claudeLine(messageID: "later", requestID: "later", output: 7)],
      to: later)

    let first = try boundedScanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let second = try boundedScanner.scan(
      cache: first.cache, now: fixedNow.addingTimeInterval(1))
    let laterKey = LocalUsageScanner.hash("file:claude:\(later.path)")

    XCTAssertTrue(first.hasDrainableBacklog)
    XCTAssertNil(first.cache.files[laterKey])
    XCTAssertEqual(second.cache.files[laterKey]?.byteOffset, second.cache.files[laterKey]?.fileSize)
    XCTAssertTrue(second.cache.claudeMaximums.count == 1)
    XCTAssertTrue(second.creditEvents.isEmpty, "분할 기준선의 마지막 batch도 소급 지급하면 안 된다")
  }

  func testRepeatedScanDoesNotReplayPreviouslyCreditedUsage() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [claudeLine(messageID: "new", requestID: "new", output: 25)],
      to: claudeRoot.appending(path: "project/repeated-scan.jsonl")
    )
    let credited = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    let replay = try scanner.scan(cache: credited.cache, now: fixedNow.addingTimeInterval(120))

    XCTAssertTrue(replay.creditEvents.isEmpty)
  }

  func testLaterFileReadsEarlierStagedMaximumWithoutDoubleCrediting() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [claudeLine(messageID: "shared", requestID: "shared", output: 20)],
      to: claudeRoot.appending(path: "project/a.jsonl")
    )
    try write(
      [claudeLine(messageID: "shared", requestID: "shared", output: 100)],
      to: claudeRoot.appending(path: "project/b.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.cache.claudeMaximums.count, 1)
    XCTAssertEqual(result.observedTotals[.claude], 1_210)
    XCTAssertEqual(
      result.creditEvents.filter { $0.provider == .claude }.reduce(0) { $0 + $1.totalTokens },
      1_210)
  }

  func testProviderFailureDiscardsFilesAndMaximumsStagedBeforeFailure() throws {
    try write(
      [claudeLine(messageID: "first", requestID: "first", output: 20)],
      to: claudeRoot.appending(path: "project/a.jsonl")
    )
    try write(
      [claudeLine(messageID: "second", requestID: "second", output: 30)],
      to: claudeRoot.appending(path: "project/b.jsonl")
    )
    let limitedScanner = LocalUsageScanner(
      claudeRoot: claudeRoot, codexRoot: codexRoot, fileLimit: 1)

    let result = try limitedScanner.scan(cache: LocalUsageCache(), now: fixedNow)

    XCTAssertEqual(result.failedProviders, [.claude])
    XCTAssertEqual(result.successfulProviders, [.codex])
    XCTAssertTrue(result.cache.files.isEmpty)
    XCTAssertTrue(result.cache.claudeMaximums.isEmpty)
    XCTAssertTrue(result.creditEvents.isEmpty)
    XCTAssertEqual(result.cache.baselineCompletedProviders, [.codex])
  }

  func testMalformedCodexRecordDoesNotBlockFollowingTokenEvent() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        #"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":BROKEN}}}"#,
        "not-json",
        codexLine(input: 40, cached: 10, output: 8),
      ],
      to: codexRoot.appending(path: "2026/08/malformed-then-valid.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.creditEvents.filter { $0.provider == .codex }.map(\.totalTokens), [48])
  }

  func testStringEncodedTokenCountsRemainSupportedByNarrowDecoder() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        #"{"type" : "assistant","requestId":"string-request","timestamp":"2026-08-03T09:00:00.000Z","message":{"id":"string-message","usage":{"input_tokens":"7","output_tokens":"11","cache_creation_input_tokens":"2","cache_read_input_tokens":"3"}}}"#
      ],
      to: claudeRoot.appending(path: "project/string-counts.jsonl")
    )
    try write(
      [
        #"{"type":"event_msg","timestamp":"2026-08-03T09:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":"40","cached_input_tokens":"10","output_tokens":"8"}}}}"#
      ],
      to: codexRoot.appending(path: "2026/08/string-counts.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens), [23])
    XCTAssertEqual(result.creditEvents.filter { $0.provider == .codex }.map(\.totalTokens), [48])
  }

  func testStringStartedAtPreservesForkChildBoundary() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try write(
      [
        codexForkMetadata(),
        #"{"type":"event_msg","timestamp":"2026-08-03T09:00:00.001Z","payload":{"type":"task_started","turn_id":"first-child-turn","started_at":"1785747600"}}"#,
        codexLine(timestamp: "2026-08-03T09:00:00.002Z", input: 40, cached: 10, output: 9),
      ],
      to: codexRoot.appending(path: "2026/08/string-started-at.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(result.creditEvents.filter { $0.provider == .codex }.map(\.totalTokens), [49])
  }

  func testLargeClaudeProjectionAndStructuralFallbackPreserveUsage() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let largeContent = String(repeating: "x", count: 70_000)
    try write(
      [claudeLine(messageID: "projected", requestID: "projected-request", output: 9,
                   extraContent: largeContent)],
      to: claudeRoot.appending(path: "project/large-projected.jsonl")
    )
    try write(
      [#"{"type":"assistant","requestId":"fallback-request","timestamp":"2026-08-03T09:00:00.000Z","content":"\#(largeContent)","message":{"id":"fallback","usage":{"input_tokens":7,"output_tokens":11}},"usage":{"input_tokens":999,"output_tokens":999}}"#],
      to: claudeRoot.appending(path: "project/large-fallback.jsonl")
    )

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertEqual(
      result.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens).sorted(),
      [18, 1_119]
    )
  }

  func testUnterminatedTailIsDeferredThenCreditedExactlyOnceAfterNewlineArrives() throws {
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let log = claudeRoot.appending(path: "project/active-writer.jsonl")
    try write([], to: log)
    try appendRaw(
      claudeLine(
        messageID: "active-tail", requestID: "active-tail",
        input: 7, output: 11, cacheWrite: 2, cacheRead: 3),
      to: log
    )

    let incomplete = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(30))
    try appendRaw("\n", to: log)
    let completed = try scanner.scan(cache: incomplete.cache, now: fixedNow.addingTimeInterval(60))
    let replay = try scanner.scan(cache: completed.cache, now: fixedNow.addingTimeInterval(90))

    XCTAssertTrue(incomplete.creditEvents.isEmpty, "작성 중인 마지막 줄은 완성 전까지 반영하면 안 된다")
    XCTAssertEqual(completed.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens), [23])
    XCTAssertTrue(replay.creditEvents.isEmpty, "완성된 tail은 정확히 한 번만 반영해야 한다")
  }

  func testProviderRecoveryEstablishesClaudeBaselineBeforeCreditingNewUsage() throws {
    try FileManager.default.removeItem(at: claudeRoot)
    try write(
      ["not-a-directory"],
      to: claudeRoot
    )
    try write(
      [codexLine(input: 40, cached: 10, output: 8)],
      to: codexRoot.appending(path: "2026/08/provider-isolation.jsonl")
    )
    let failed = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    XCTAssertEqual(failed.failedProviders, [.claude])
    XCTAssertEqual(failed.successfulProviders, [.codex])
    XCTAssertEqual(failed.observedTotals[.codex], 48)
    XCTAssertTrue(failed.creditEvents.isEmpty)

    try FileManager.default.removeItem(at: claudeRoot)
    let claudeLog = claudeRoot.appending(path: "project/recovered.jsonl")
    try write(
      [
        claudeLine(
          messageID: "historical", requestID: "historical",
          input: 500, output: 500, cacheWrite: 0, cacheRead: 0)
      ],
      to: claudeLog
    )
    let recovered = try scanner.scan(
      cache: failed.cache, now: fixedNow.addingTimeInterval(60))

    XCTAssertTrue(recovered.failedProviders.isEmpty)
    XCTAssertEqual(Set(recovered.successfulProviders), Set([.claude, .codex]))
    XCTAssertEqual(recovered.observedTotals[.claude], 1_000)
    XCTAssertEqual(recovered.observedTotals[.codex], 48)
    XCTAssertTrue(recovered.creditEvents.isEmpty, "복구 시 발견한 Claude 과거 로그는 소급 적립하면 안 된다")

    try append(
      [
        claudeLine(
          messageID: "new-after-recovery", requestID: "new-after-recovery",
          input: 7, output: 11, cacheWrite: 2, cacheRead: 3)
      ],
      to: claudeLog
    )
    let credited = try scanner.scan(
      cache: recovered.cache, now: fixedNow.addingTimeInterval(120))

    XCTAssertTrue(credited.failedProviders.isEmpty)
    XCTAssertEqual(credited.creditEvents.filter { $0.provider == .claude }.map(\.totalTokens), [23])
    XCTAssertEqual(credited.observedTotals[.codex], 48)
  }

  func testSymbolicLinkJSONLIsIgnoredWithoutReadingExternalContent() throws {
    let external = temporaryDirectory.appending(path: "external-secret.jsonl")
    try write(
      [claudeLine(messageID: "external", requestID: "external", output: 99)],
      to: external
    )
    let link = claudeRoot.appending(path: "project/link.jsonl")
    try FileManager.default.createDirectory(
      at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: external)

    let result = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    XCTAssertNil(result.observedTotals[.claude])
    XCTAssertTrue(result.cache.claudeMaximums.isEmpty)
  }

  func testPersistedCacheContainsNoPromptsResponsesOrRawFilePaths() throws {
    let secretPathComponent = "private-project-super-secret"
    let secretPrompt = "DO_NOT_PERSIST_PROMPT_\(UUID().uuidString)"
    let log = claudeRoot.appending(path: "\(secretPathComponent)/session.jsonl")
    try write(
      [claudeLine(messageID: "message-a", requestID: "request-a", output: 4, extraContent: secretPrompt)],
      to: log
    )
    let result = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let cacheFile = temporaryDirectory.appending(path: "usage-cache.json")

    try LocalUsageCachePersistence(fileURL: cacheFile).save(result.cache)
    let persisted = String(decoding: try Data(contentsOf: cacheFile), as: UTF8.self)

    XCTAssertFalse(persisted.contains(secretPathComponent))
    XCTAssertFalse(persisted.contains(secretPrompt))
    XCTAssertFalse(persisted.contains(log.path))
    XCTAssertFalse(persisted.contains("message-a"))
    XCTAssertFalse(persisted.contains("request-a"))
  }

  func testCorruptCacheRecoversByEstablishingANewBaselineWithoutWindfall() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write([claudeLine(messageID: "historical", requestID: "historical", input: 500, output: 500)], to: log)
    let cacheFile = temporaryDirectory.appending(path: "usage-cache.json")
    try Data("{corrupt-cache".utf8).write(to: cacheFile)

    let persistence = LocalUsageCachePersistence(fileURL: cacheFile)
    let recovered = try persistence.load()
    let result = try scanner.scan(cache: recovered, now: fixedNow)

    XCTAssertTrue(result.creditEvents.isEmpty)
    XCTAssertEqual(result.observedTotals[.claude], 1_000)
    XCTAssertTrue(result.cache.baselineCompleted)
  }

  func testChangedFileMetadataInvalidatesCacheAndUnchangedWarmScanIsStable() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write([claudeLine(messageID: "a", requestID: "a", output: 10)], to: log)
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)

    let warm = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(30))
    XCTAssertTrue(warm.creditEvents.isEmpty)
    XCTAssertEqual(warm.observedTotals, baseline.observedTotals)

    try append(
      [claudeLine(messageID: "b", requestID: "b", input: 3, output: 7)],
      to: log
    )
    let invalidated = try scanner.scan(cache: warm.cache, now: fixedNow.addingTimeInterval(60))
    XCTAssertEqual(invalidated.creditEvents.map(\.totalTokens), [10])
    XCTAssertEqual(invalidated.observedTotals[.claude], 20)
  }

  func testSameSizeRewriteWithNewModificationDateInvalidatesCachedCursor() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write([claudeLine(messageID: "message-a", requestID: "request-a", output: 10)], to: log)
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    let originalSize = try XCTUnwrap(log.resourceValues(forKeys: [.fileSizeKey]).fileSize)

    try write([claudeLine(messageID: "message-b", requestID: "request-b", output: 20)], to: log)
    try FileManager.default.setAttributes(
      [.modificationDate: fixedNow.addingTimeInterval(120)], ofItemAtPath: log.path)
    XCTAssertEqual(try log.resourceValues(forKeys: [.fileSizeKey]).fileSize, originalSize)

    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(120))

    XCTAssertEqual(result.creditEvents.map(\.totalTokens), [1_130])
    XCTAssertEqual(result.observedTotals[.claude], 2_250)
  }

  func testLocalUsageEventCannotDoubleCreditWhenReplayedIntoGameState() throws {
    let log = claudeRoot.appending(path: "project/session.jsonl")
    try write([claudeLine(messageID: "a", requestID: "a", output: 10)], to: log)
    let baseline = try scanner.scan(cache: LocalUsageCache(), now: fixedNow)
    try append([
      claudeLine(
        messageID: "b", requestID: "b", input: 0, output: 25, cacheWrite: 0, cacheRead: 0)
    ], to: log)
    let result = try scanner.scan(cache: baseline.cache, now: fixedNow.addingTimeInterval(60))
    let event = try XCTUnwrap(result.creditEvents.first)
    var state = GameState()
    let startingBalance = state.tokenBalance

    try GameEngine.ingest(event, into: &state, now: fixedNow)

    XCTAssertEqual(state.tokenBalance, startingBalance + 25)
    XCTAssertThrowsError(try GameEngine.ingest(event, into: &state, now: fixedNow)) { error in
      XCTAssertEqual(error as? GameError, .duplicateUsageEvent)
    }
  }

  private var scanner: LocalUsageScanner {
    LocalUsageScanner(claudeRoot: claudeRoot, codexRoot: codexRoot)
  }

  private var fixedNow: Date {
    ISO8601DateFormatter().date(from: "2026-08-03T09:30:00Z")!
  }

  private func claudeLine(
    messageID: String,
    requestID: String,
    timestamp: String = "2026-08-03T09:00:00.000Z",
    input: Int = 100,
    output: Int,
    cacheWrite: Int = 10,
    cacheRead: Int = 1_000,
    extraContent: String = ""
  ) -> String {
    """
    {"type":"assistant","requestId":"\(requestID)","timestamp":"\(timestamp)","prompt":"\(extraContent)","message":{"id":"\(messageID)","model":"claude-test","content":"\(extraContent)","usage":{"input_tokens":\(input),"output_tokens":\(output),"cache_creation_input_tokens":\(cacheWrite),"cache_read_input_tokens":\(cacheRead)}}}
    """
  }

  private func codexLine(
    timestamp: String = "2026-08-03T09:00:00.000Z",
    input: Int,
    cached: Int,
    output: Int
  ) -> String {
    """
    {"type":"event_msg","timestamp":"\(timestamp)","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":\(input),"cached_input_tokens":\(cached),"output_tokens":\(output)}}}}
    """
  }

  private func codexCumulativeLine(
    timestamp: String,
    lastInput: Int,
    lastCached: Int,
    lastOutput: Int,
    totalInput: Int,
    totalCached: Int,
    totalOutput: Int
  ) -> String {
    """
    {"type":"event_msg","timestamp":"\(timestamp)","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":\(lastInput),"cached_input_tokens":\(lastCached),"output_tokens":\(lastOutput)},"total_token_usage":{"input_tokens":\(totalInput),"cached_input_tokens":\(totalCached),"output_tokens":\(totalOutput)}}}}
    """
  }

  private func codexForkMetadata() -> String {
    #"{"type":"session_meta","timestamp":"2026-08-03T09:00:00.000Z","payload":{"id":"child","timestamp":"2026-08-03T09:00:00.000Z","parent_thread_id":"parent","thread_source":"subagent"}}"#
  }

  private func codexSessionMetadata() -> String {
    #"{"type":"session_meta","timestamp":"2026-08-03T09:00:00.000Z","payload":{"id":"session-a","timestamp":"2026-08-03T09:00:00.000Z","thread_source":"cli"}}"#
  }

  private func codexTaskStarted(turnID: String, startedAt: Int) -> String {
    """
    {"type":"event_msg","timestamp":"2026-08-03T09:00:00.001Z","payload":{"type":"task_started","turn_id":"\(turnID)","started_at":\(startedAt)}}
    """
  }

  private func write(_ lines: [String], to file: URL) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try (lines.joined(separator: "\n") + "\n").write(
      to: file, atomically: true, encoding: .utf8)
  }

  private func append(_ lines: [String], to file: URL) throws {
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data((lines.joined(separator: "\n") + "\n").utf8))
  }

  private func appendRaw(_ value: String, to file: URL) throws {
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(value.utf8))
  }

  private func writeOversizedIrrelevantRecord(
    payloadByteCount: Int,
    followedBy line: String? = nil,
    to file: URL
  ) throws {
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil))
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.write(contentsOf: Data(#"{"type":"tool_output","payload":""#.utf8))
    let chunk = Data(repeating: 0x61, count: 64 * 1024)
    var remaining = payloadByteCount
    while remaining > 0 {
      let count = min(remaining, chunk.count)
      if count == chunk.count {
        try handle.write(contentsOf: chunk)
      } else {
        try handle.write(contentsOf: Data(chunk.prefix(count)))
      }
      remaining -= count
    }
    var suffix = #""}"# + "\n"
    if let line {
      suffix += line + "\n"
    }
    try handle.write(contentsOf: Data(suffix.utf8))
  }
}

final class LocalUsageServiceConsentTests: XCTestCase {
  func testNextScanDelayThrottlesBacklogAndUsesIdleIntervalOtherwise() {
    XCTAssertEqual(
      LocalUsageService.nextScanDelay(activeDuration: 0.1, hasDrainableBacklog: true),
      1)
    XCTAssertEqual(
      LocalUsageService.nextScanDelay(activeDuration: 2, hasDrainableBacklog: true),
      6)
    XCTAssertEqual(
      LocalUsageService.nextScanDelay(
        activeDuration: 2, hasDrainableBacklog: false, idleInterval: 12),
      12)
  }

  @MainActor
  func testImmediateStopAndRestartNeverOverlapsDetachedScanWorkers() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-worker-overlap-\(UUID().uuidString)")
    let cacheURL = directory.appending(path: "cache.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let suiteName = "LocalUsageWorkerOverlapTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let probe = ScanOverlapProbe()
    let service = LocalUsageService(
      persistence: LocalUsageCachePersistence(fileURL: cacheURL),
      interval: 60,
      defaults: defaults,
      scanOperation: { _, _ in try probe.runUntilCancelled() },
      onEvents: { _ in .duplicate }
    )

    service.start()
    for _ in 0..<200 where probe.snapshot().starts < 1 {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(probe.snapshot().starts, 1)

    service.stop()
    service.start()
    for _ in 0..<200 where probe.snapshot().starts < 2 {
      try await Task.sleep(for: .milliseconds(5))
    }

    XCTAssertEqual(probe.snapshot().starts, 2)
    XCTAssertEqual(probe.snapshot().peak, 1)
    service.stop()
    for _ in 0..<200 where probe.snapshot().active != 0 {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(probe.snapshot().active, 0)
  }

  @MainActor
  func testCollectionRequiresPersistedOptInAndStopRevokesIt() throws {
    let suiteName = "LocalUsageServiceConsentTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-consent-roots-\(UUID().uuidString)")
    let claudeRoot = directory.appending(path: "claude")
    let codexRoot = directory.appending(path: "codex")
    try FileManager.default.createDirectory(at: claudeRoot, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: codexRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = LocalUsageService(
      scanner: LocalUsageScanner(claudeRoot: claudeRoot, codexRoot: codexRoot),
      defaults: defaults,
      onEvents: { _ in .duplicate }
    )

    XCTAssertFalse(service.collectionEnabled)
    XCTAssertFalse(service.isRunning)

    service.start()
    XCTAssertTrue(service.collectionEnabled)
    XCTAssertTrue(service.isRunning)
    XCTAssertTrue(defaults.bool(forKey: LocalUsageService.collectionEnabledDefaultsKey))

    service.shutdown()
    XCTAssertTrue(service.collectionEnabled)
    XCTAssertFalse(service.isRunning)
    XCTAssertTrue(defaults.bool(forKey: LocalUsageService.collectionEnabledDefaultsKey))

    service.resumeIfEnabled()
    XCTAssertTrue(service.isRunning)

    service.stop()
    XCTAssertFalse(service.collectionEnabled)
    XCTAssertFalse(service.isRunning)
    XCTAssertFalse(defaults.bool(forKey: LocalUsageService.collectionEnabledDefaultsKey))
  }

  @MainActor
  func testDisconnectDeletesOnlyPunchGrowCacheAndResetsObservedState() throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-consent-cache-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cacheURL = directory.appending(path: "local-usage-cache.json")
    let persistence = LocalUsageCachePersistence(fileURL: cacheURL)
    try persistence.save(LocalUsageCache())
    let suiteName = "LocalUsageServiceDisconnectTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    var resetWasPublished = false
    let service = LocalUsageService(
      persistence: persistence,
      defaults: defaults,
      onObservedTotals: { total, weekly, breakdown, _ in
        resetWasPublished = total.isEmpty && weekly.isEmpty && breakdown.isEmpty
      },
      onEvents: { _ in .duplicate }
    )

    service.disconnect()

    XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path))
    XCTAssertFalse(service.collectionEnabled)
    XCTAssertFalse(service.isRunning)
    XCTAssertTrue(resetWasPublished)
  }

  @MainActor
  func testScanFailureIsPublishedForIntegrationStatusProjection() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "punchgrow-consent-error-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let suiteName = "LocalUsageServiceErrorTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    var projectedMessage: String?
    let service = LocalUsageService(
      persistence: LocalUsageCachePersistence(fileURL: directory),
      interval: 60,
      defaults: defaults,
      onScanError: { projectedMessage = $0 },
      onEvents: { _ in .duplicate }
    )

    service.start()
    for _ in 0..<20 where projectedMessage == nil {
      try await Task.sleep(for: .milliseconds(10))
    }
    service.stop()

    XCTAssertEqual(projectedMessage, service.errorMessage)
    XCTAssertNotNil(projectedMessage)
  }
}
