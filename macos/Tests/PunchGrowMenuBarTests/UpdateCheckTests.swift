import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 테스트에서 가변 값을 `@Sendable` 클로저로 넘기기 위한 최소 상자.
private final class MutableBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: Value

  init(_ value: Value) {
    storage = value
  }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func set(_ value: Value) {
    lock.lock()
    defer { lock.unlock() }
    storage = value
  }

  func mutate(_ transform: (inout Value) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    transform(&storage)
  }
}

private final class RecordingNotifier: UpdateNotifying, @unchecked Sendable {
  private let recorded = MutableBox([String]())

  var versions: [String] { recorded.value }

  func notifyUpdateAvailable(version: String) {
    recorded.mutate { $0.append(version) }
  }
}

private struct StubFetchError: Error {}

private func releasePayload(
  tag: String, draft: Bool = false, prerelease: Bool = false,
  htmlURL: String? = nil
) -> Data {
  let object: [String: Any] = [
    "tag_name": tag,
    "html_url": htmlURL ?? "https://github.com/yoonsundo/punchgrow/releases/tag/\(tag)",
    "body": "  새 크리처가 추가되었습니다.  ",
    "published_at": "2026-08-13T00:00:00Z",
    "draft": draft,
    "prerelease": prerelease,
  ]
  return try! JSONSerialization.data(withJSONObject: object)
}

final class UpdateCheckTests: XCTestCase {

  // MARK: - AppVersion

  func testAppVersionParsesTagAndPlainFormats() {
    XCTAssertEqual(AppVersion("v0.3.0")?.description, "0.3.0")
    XCTAssertEqual(AppVersion("0.3.0")?.description, "0.3.0")
    XCTAssertEqual(AppVersion("0.3")?.description, "0.3")
    XCTAssertEqual(AppVersion("  V1.2.3  ")?.description, "1.2.3")
    XCTAssertEqual(AppVersion("1.2.3-beta.1")?.description, "1.2.3")
    XCTAssertEqual(AppVersion("1.2.3+build7")?.description, "1.2.3")
  }

  func testAppVersionComparesNumericallyNotLexically() {
    XCTAssertTrue(AppVersion("0.10.0")! > AppVersion("0.9.0")!)
    XCTAssertTrue(AppVersion("1.0.0")! > AppVersion("0.99.99")!)
    XCTAssertTrue(AppVersion("0.3")! == AppVersion("0.3.0")!)
    XCTAssertFalse(AppVersion("0.3.0")! > AppVersion("0.3")!)
    XCTAssertTrue(AppVersion("0.3.1")! > AppVersion("0.3")!)
    XCTAssertEqual(AppVersion("0.3")!.hashValue, AppVersion("0.3.0")!.hashValue)
  }

  func testAppVersionRejectsMalformedTextWithoutCrashing() {
    for text in ["", "   ", "v", "abc", "1..2", "1.x", "1.-2", "٣.٤"] {
      XCTAssertNil(AppVersion(text), "\(text) 는 버전이 아니어야 합니다")
    }
  }

  // MARK: - 릴리스 파싱

  func testParseLatestReleaseReadsVersionURLAndTrimmedNotes() throws {
    let release = try XCTUnwrap(UpdateCheck.parseLatestRelease(releasePayload(tag: "v0.4.0")))

    XCTAssertEqual(release.version, AppVersion("0.4.0"))
    XCTAssertEqual(release.tagName, "v0.4.0")
    XCTAssertEqual(
      release.htmlURL?.absoluteString,
      "https://github.com/yoonsundo/punchgrow/releases/tag/v0.4.0")
    XCTAssertEqual(release.notes, "새 크리처가 추가되었습니다.")
    XCTAssertNotNil(release.publishedAt)
  }

  func testParseLatestReleaseExcludesDraftPrereleaseAndUnreadableTags() throws {
    try XCTAssertNil(UpdateCheck.parseLatestRelease(releasePayload(tag: "v0.4.0", draft: true)))
    try XCTAssertNil(
      UpdateCheck.parseLatestRelease(releasePayload(tag: "v0.4.0", prerelease: true)))
    try XCTAssertNil(UpdateCheck.parseLatestRelease(releasePayload(tag: "nightly")))
  }

  func testParseLatestReleaseThrowsOnMalformedPayload() {
    XCTAssertThrowsError(try UpdateCheck.parseLatestRelease(Data("not json".utf8))) { error in
      XCTAssertEqual(error as? UpdateCheckError, .malformedPayload)
    }
  }

  func testParseLatestReleaseRejectsUntrustedReleaseNotesURLs() throws {
    for url in [
      "http://github.com/yoonsundo/punchgrow/releases/tag/v0.4.0",
      "https://example.com/yoonsundo/punchgrow/releases/tag/v0.4.0",
      "file:///tmp/release-notes",
      "punchgrow://release/v0.4.0",
      "https://github.com/other/repository/releases/tag/v0.4.0",
      "https://github.com/yoonsundo/punchgrow/releases/../../attacker",
      "https://github.com/yoonsundo/punchgrow/releases/%2e%2e/%2e%2e/attacker",
      "https://github.com/yoonsundo/punchgrow/releases/tag/v0.4.0?redirect=1",
      "https://github.com/yoonsundo/punchgrow/releases/tag/v0.4.0#fragment",
      "https://github.com/yoonsundo/punchgrow/releases/download/v0.4.0/app.zip",
      "https://github.com/yoonsundo/punchgrow/releases/tag/v0.5.0",
    ] {
      let release = try XCTUnwrap(
        UpdateCheck.parseLatestRelease(releasePayload(tag: "v0.4.0", htmlURL: url)))
      XCTAssertNil(release.htmlURL, "untrusted release URL must fall back: \(url)")
      XCTAssertEqual(release.notesURL, UpdateCheck.releasesPageURL)
    }
  }

  func testLatestReleaseResponseURLMustRemainOnTheGitHubAPIOrigin() {
    XCTAssertTrue(UpdateCheck.isTrustedLatestReleaseResponseURL(UpdateCheck.latestReleaseURL))
    XCTAssertFalse(
      UpdateCheck.isTrustedLatestReleaseResponseURL(
        URL(string: "http://api.github.com/repos/yoonsundo/punchgrow/releases/latest")!))
    XCTAssertFalse(
      UpdateCheck.isTrustedLatestReleaseResponseURL(
        URL(string: "https://example.com/repos/yoonsundo/punchgrow/releases/latest")!))
    XCTAssertFalse(
      UpdateCheck.isTrustedLatestReleaseResponseURL(
        URL(string: "https://api.github.com:8443/repos/yoonsundo/punchgrow/releases/latest")!))
    XCTAssertFalse(
      UpdateCheck.isTrustedLatestReleaseResponseURL(
        URL(string: "https://api.github.com/repos/yoonsundo/punchgrow/releases/latest-attacker")!))
    XCTAssertFalse(
      UpdateCheck.isTrustedLatestReleaseResponseURL(
        URL(string: "https://api.github.com/repos/yoonsundo/punchgrow/releases/latest?redirect=1")!))
  }

  // MARK: - 후보 판단과 주기

  func testAvailableUpdateIgnoresSameOlderAndSkippedVersions() throws {
    let latest = try XCTUnwrap(UpdateCheck.parseLatestRelease(releasePayload(tag: "v0.4.0")))
    let current = AppVersion("0.3.0")!

    XCTAssertNotNil(UpdateCheck.availableUpdate(latest: latest, current: current, skipping: nil))
    XCTAssertNil(
      UpdateCheck.availableUpdate(latest: latest, current: AppVersion("0.4.0")!, skipping: nil))
    XCTAssertNil(
      UpdateCheck.availableUpdate(latest: latest, current: AppVersion("0.5.0")!, skipping: nil))
    XCTAssertNil(
      UpdateCheck.availableUpdate(
        latest: latest, current: current, skipping: AppVersion("0.4.0")))
    XCTAssertNotNil(
      UpdateCheck.availableUpdate(
        latest: latest, current: current, skipping: AppVersion("0.3.5")))
    XCTAssertNil(UpdateCheck.availableUpdate(latest: nil, current: current, skipping: nil))
  }

  func testDelayUntilNextCheckHonoursIntervalAndBackwardClocks() {
    let now = Date(timeIntervalSince1970: 1_000_000)

    XCTAssertEqual(UpdateCheck.delayUntilNextCheck(lastCheckedAt: nil, now: now), 0)
    XCTAssertEqual(
      UpdateCheck.delayUntilNextCheck(lastCheckedAt: now.addingTimeInterval(-3_600), now: now),
      UpdateCheck.checkInterval - 3_600, accuracy: 0.001)
    XCTAssertEqual(
      UpdateCheck.delayUntilNextCheck(lastCheckedAt: now.addingTimeInterval(-90_000), now: now), 0)
    // 저장값이 미래면(시계 되돌림) 기다리지 않고 곧바로 확인한다.
    XCTAssertEqual(
      UpdateCheck.delayUntilNextCheck(lastCheckedAt: now.addingTimeInterval(9_999), now: now), 0)
  }

  // MARK: - UpdateService

  /// 모든 서비스 테스트가 쓰는 조립기. 시계·페처·저장소·알림을 전부 주입해 실제 네트워크나
  /// 사용자 설정에 닿지 않게 한다. 저장소는 매번 새 스위트라 테스트끼리 상태가 새지 않는다.
  @MainActor
  private func makeService(
    currentVersion: String? = "0.3.0",
    now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_000_000) },
    notifier: UpdateNotifying = RecordingNotifier(),
    seedDefaults: (UserDefaults) -> Void = { _ in },
    sleeper: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in },
    payload: @escaping @Sendable () throws -> Data = { releasePayload(tag: "v0.4.0") }
  ) -> (UpdateService, UserDefaults, MutableBox<Int>) {
    let defaults = UserDefaults(suiteName: "punchgrow.tests.\(UUID().uuidString)")!
    seedDefaults(defaults)
    let fetchCount = MutableBox(0)
    let service = UpdateService(
      currentVersion: currentVersion.flatMap(AppVersion.init),
      defaults: defaults,
      notifier: notifier,
      now: now,
      sleeper: sleeper,
      fetch: {
        fetchCount.mutate { $0 += 1 }
        return try payload()
      }
    )
    return (service, defaults, fetchCount)
  }

  @MainActor
  func testAutomaticCheckIsEnabledWhenNoPreferenceStored() {
    let (service, defaults, _) = makeService()

    XCTAssertTrue(service.automaticCheckEnabled)
    XCTAssertNil(defaults.object(forKey: UpdateService.automaticCheckDefaultsKey))
  }

  @MainActor
  func testDisabledAutomaticCheckNeverTouchesTheNetwork() async {
    let (service, _, fetchCount) = makeService()
    service.setAutomaticCheckEnabled(false)

    service.resumeIfEnabled()
    let outcome = await service.checkIfDue()

    XCTAssertEqual(outcome, .skipped)
    XCTAssertEqual(fetchCount.value, 0)
    XCTAssertNil(service.availableUpdate)
  }

  @MainActor
  func testCheckIsSkippedWithinTwentyFourHoursButManualCheckIgnoresIt() async {
    let (service, _, fetchCount) = makeService()

    let firstRun = await service.checkIfDue()
    XCTAssertEqual(firstRun, .succeeded)
    XCTAssertEqual(fetchCount.value, 1)
    XCTAssertEqual(service.availableUpdate?.version, AppVersion("0.4.0"))

    // 같은 시각에 다시 요청해도 주기가 남아 있어 네트워크를 건드리지 않는다.
    let secondRun = await service.checkIfDue()
    XCTAssertEqual(secondRun, .skipped)
    XCTAssertEqual(fetchCount.value, 1)

    // 수동 확인은 주기를 무시한다.
    let manualRun = await service.check()
    XCTAssertEqual(manualRun, .succeeded)
    XCTAssertEqual(fetchCount.value, 2)
  }

  @MainActor
  func testStoredLastCheckedAtSurvivesRelaunchAndSuppressesImmediateCheck() async {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let anHourAgo = now.addingTimeInterval(-3_600)
    let (service, _, fetchCount) = makeService(seedDefaults: {
      $0.set(anHourAgo, forKey: UpdateService.lastCheckedAtDefaultsKey)
    })

    XCTAssertEqual(service.lastCheckedAt, anHourAgo)
    let outcome = await service.checkIfDue()
    XCTAssertEqual(outcome, .skipped)
    XCTAssertEqual(fetchCount.value, 0)
  }

  @MainActor
  func testSkippingAVersionSuppressesItButNotAHigherOne() async {
    let (service, defaults, _) = makeService()
    await service.check()
    service.skipCurrentUpdate()

    XCTAssertNil(service.availableUpdate)
    XCTAssertEqual(defaults.string(forKey: UpdateService.skippedVersionDefaultsKey), "0.4.0")

    await service.check()
    XCTAssertNil(service.availableUpdate, "건너뛴 버전은 다시 알리지 않아야 합니다")

    let (higher, higherDefaults, _) = makeService(payload: { releasePayload(tag: "v0.5.0") })
    higherDefaults.set("0.4.0", forKey: UpdateService.skippedVersionDefaultsKey)
    await higher.check()
    XCTAssertEqual(higher.availableUpdate?.version, AppVersion("0.5.0"))
  }

  @MainActor
  func testNetworkFailureReportsAnErrorAndKeepsCheckingLater() async {
    let (service, _, fetchCount) = makeService(payload: { throw StubFetchError() })

    let failedRun = await service.check()
    XCTAssertEqual(failedRun, .failed)
    XCTAssertNotNil(service.errorMessage)
    XCTAssertNil(service.availableUpdate)
    XCTAssertNil(service.lastCheckedAt, "실패는 마지막 성공 확인 시각을 갱신하면 안 됩니다")
    XCTAssertEqual(fetchCount.value, 1)

    let retryRun = await service.check()
    XCTAssertEqual(retryRun, .failed)
    XCTAssertEqual(fetchCount.value, 2, "실패 뒤에도 수동 확인은 계속 동작해야 합니다")
  }

  @MainActor
  func testFailureBacksOffExponentiallyAndResetsOnTheSameInstance() async {
    // 같은 인스턴스에서 실패 → 성공 → 실패를 겪게 해야 초기화가 실제로 검증된다.
    // 새 서비스를 만들어 비교하면 태어날 때부터 0이라 단언이 무조건 통과한다.
    let shouldFail = MutableBox(true)
    let (service, _, _) = makeService(payload: {
      if shouldFail.value { throw StubFetchError() }
      return releasePayload(tag: "v0.4.0")
    })

    // 실패가 24시간 예산을 쓰지 않으므로 주기는 백오프가 결정한다.
    await service.check()
    XCTAssertEqual(service.delayAfter(.failed), UpdateService.retryDelay, accuracy: 0.001)
    await service.check()
    XCTAssertEqual(service.delayAfter(.failed), UpdateService.retryDelay * 2, accuracy: 0.001)
    await service.check()
    XCTAssertEqual(service.delayAfter(.failed), UpdateService.retryDelay * 4, accuracy: 0.001)

    shouldFail.set(false)
    let recovered = await service.check()
    XCTAssertEqual(recovered, .succeeded)
    XCTAssertEqual(service.delayAfter(.succeeded), UpdateCheck.checkInterval, accuracy: 0.001)

    // 초기화됐다면 다음 실패는 다시 60초부터 시작한다.
    shouldFail.set(true)
    await service.check()
    XCTAssertEqual(
      service.delayAfter(.failed), UpdateService.retryDelay, accuracy: 0.001,
      "성공이 연속 실패 카운터를 0으로 되돌려야 합니다")
  }

  /// 실패가 섞인 루프. 실패 회차가 하루 예산을 쓰지 않고 백오프로 재시도하며, 성공한 뒤에는
  /// 다시 하루 주기로 돌아가는지 확인한다. 성공만 도는 테스트로는 이 구간이 검증되지 않는다.
  @MainActor
  func testPollingLoopBacksOffOnFailureThenReturnsToTheDailyInterval() async {
    let clock = MutableBox(Date(timeIntervalSince1970: 1_000_000))
    let delays = MutableBox([TimeInterval]())
    let attempts = MutableBox(0)
    let (service, _, _) = makeService(
      now: { clock.value },
      sleeper: { delay in
        delays.mutate { $0.append(delay) }
        clock.set(clock.value.addingTimeInterval(delay))
        if delays.value.count >= 3 { throw CancellationError() }
      },
      payload: {
        attempts.mutate { $0 += 1 }
        // 처음 두 회차는 실패, 세 번째부터 성공.
        if attempts.value <= 2 { throw StubFetchError() }
        return releasePayload(tag: "v0.4.0")
      }
    )

    service.resumeIfEnabled()
    var spins = 0
    while delays.value.count < 3, spins < 100_000 {
      await Task.yield()
      spins += 1
    }
    service.shutdown()

    XCTAssertEqual(
      delays.value,
      [UpdateService.retryDelay, UpdateService.retryDelay * 2, UpdateCheck.checkInterval],
      "실패는 60초→120초로 백오프하고, 성공하면 하루 주기로 돌아가야 합니다")
    XCTAssertEqual(service.availableUpdate?.version, AppVersion("0.4.0"))
  }

  @MainActor
  func testCancellationIsNotReportedAsANetworkFailure() async {
    let (service, _, _) = makeService(payload: { throw CancellationError() })

    // 취소된 확인은 거짓 오류를 남기지 않고 백오프도 오염시키지 않아야 한다.
    let task = Task { @MainActor in await service.check() }
    task.cancel()
    let outcome = await task.value

    XCTAssertEqual(outcome, .skipped)
    XCTAssertNil(service.errorMessage, "취소는 네트워크 오류가 아닙니다")
    XCTAssertEqual(
      service.delayAfter(.failed), UpdateService.retryDelay, accuracy: 0.001,
      "취소가 연속 실패 카운터를 올리면 안 됩니다")
  }

  @MainActor
  func testDelayAfterNeverDropsBelowTheRetryFloor() {
    let (service, _, _) = makeService()

    // 확인한 적이 없으면 delayUntilNextCheck 는 0이다. 그래도 루프가 쉬지 않고 돌면 안 된다.
    XCTAssertEqual(service.delayUntilNextCheck(), 0, accuracy: 0.001)
    XCTAssertEqual(service.delayAfter(.skipped), UpdateService.retryDelay, accuracy: 0.001)
    XCTAssertEqual(service.delayAfter(.succeeded), UpdateService.retryDelay, accuracy: 0.001)
  }

  /// 앱이 실제로 타는 경로. 폴링 루프가 하루에 한 번만 확인하고, 어떤 회차도 60초보다 짧게
  /// 쉬지 않는지 — 즉 고속 회전하지 않는지 — 가짜 시계를 전진시키며 확인한다.
  @MainActor
  func testPollingLoopChecksOncePerDayAndNeverSpinsHot() async {
    let clock = MutableBox(Date(timeIntervalSince1970: 1_000_000))
    let delays = MutableBox([TimeInterval]())
    let (service, _, fetchCount) = makeService(
      now: { clock.value },
      sleeper: { delay in
        delays.mutate { $0.append(delay) }
        clock.set(clock.value.addingTimeInterval(delay))
        // 네 회차를 관찰했으면 취소로 루프를 끝낸다.
        if delays.value.count >= 4 { throw CancellationError() }
      }
    )

    service.resumeIfEnabled()
    var spins = 0
    while delays.value.count < 4, spins < 100_000 {
      await Task.yield()
      spins += 1
    }
    service.shutdown()

    XCTAssertEqual(delays.value.count, 4, "폴링 루프가 네 회차를 돌아야 합니다")
    XCTAssertEqual(fetchCount.value, 4, "회차마다 정확히 한 번씩만 확인해야 합니다")
    XCTAssertTrue(
      delays.value.allSatisfy { $0 >= UpdateService.retryDelay },
      "어떤 회차도 재시도 하한보다 짧게 쉬면 안 됩니다: \(delays.value)")
    XCTAssertTrue(
      delays.value.allSatisfy { $0 == UpdateCheck.checkInterval },
      "성공한 회차는 하루 주기여야 합니다: \(delays.value)")
  }

  @MainActor
  func testNotifiesOncePerVersionAndAgainForAHigherVersion() async {
    let notifier = RecordingNotifier()
    let tag = MutableBox("v0.4.0")
    let (service, _, _) = makeService(
      notifier: notifier, payload: { releasePayload(tag: tag.value) })

    await service.check()
    await service.check()
    XCTAssertEqual(notifier.versions, ["0.4.0"], "같은 버전으로는 한 번만 알려야 합니다")

    tag.set("v0.5.0")
    await service.check()
    XCTAssertEqual(notifier.versions, ["0.4.0", "0.5.0"])
  }

  @MainActor
  func testSystemNotificationToggleOffStillShowsTheInAppBanner() async {
    let notifier = RecordingNotifier()
    let (service, defaults, _) = makeService(notifier: notifier)
    defaults.set(false, forKey: UpdateService.systemNotificationsDefaultsKey)

    await service.check()

    XCTAssertEqual(notifier.versions, [], "알림 토글이 꺼져 있으면 알림센터로 보내지 않습니다")
    XCTAssertEqual(service.availableUpdate?.version, AppVersion("0.4.0"), "배너는 그대로 보여야 합니다")
  }

  @MainActor
  func testUnknownRunningVersionDisablesCheckingEntirely() async {
    let (service, _, fetchCount) = makeService(currentVersion: nil)

    service.resumeIfEnabled()
    let outcome = await service.check()
    XCTAssertEqual(outcome, .skipped)
    XCTAssertEqual(fetchCount.value, 0)
    XCTAssertNil(service.availableUpdate)
  }
}
