import AppKit
import Combine
import Foundation
import UserNotifications

/// 알림센터 통지 창구. 테스트가 실제 알림을 띄우지 않고 호출을 셀 수 있도록 분리했다.
protocol UpdateNotifying: Sendable {
    func notifyUpdateAvailable(version: String)
}

/// 실제 macOS 알림. 앱 번들 밖(`swift run`)에서는 아무것도 하지 않는다 —
/// `UNUserNotificationCenter.current()`는 번들 식별자가 없으면 프로세스를 끝낸다.
struct SystemUpdateNotifier: UpdateNotifying {
    func notifyUpdateAvailable(version: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        // 센터를 클로저로 넘기지 않고 안에서 다시 가져온다 — UNUserNotificationCenter는 Sendable이 아니다.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
            granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "PunchGrow 새 버전 \(version)"
            content.body = "터미널에서 \(UpdateCheck.brewUpgradeCommand) 를 실행하면 업데이트됩니다."
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(
                    identifier: "punchgrow.update.\(version)",
                    content: content,
                    trigger: nil
                ),
                withCompletionHandler: nil
            )
        }
    }
}

/// 새 릴리스가 있는지 하루 한 번 확인하고, 사용자에게 알린다.
///
/// 앱은 스스로 설치하지 않는다. Homebrew 캐스크로 배포되므로 앱이 번들을 교체하면 brew가 아는
/// 버전과 실제 버전이 어긋난다. 여기서는 감지와 안내까지만 하고 설치는 `brew upgrade`에 맡긴다.
/// 이 확인은 앱이 **직접** 보내는 유일한 네트워크 요청이고, 사용량이나 게임 데이터는 전송하지 않는다.
/// 앱이 유발하는 유일한 트래픽이라는 뜻은 아니다 — 자동 수집이 켜져 있으면 `LocalUsageService`가
/// `ClaudeUsageCacheRefresher`를 통해 Claude Code 상태줄 스크립트를 띄우고, 그 스크립트가 자신의
/// 자격 증명으로 공급자에 사용률을 조회한다. 개인정보 문구를 쓸 때 이 경로를 빼면 거짓이 된다.
@MainActor
final class UpdateService: ObservableObject {
    static let automaticCheckDefaultsKey = "updateCheckEnabled"
    static let lastCheckedAtDefaultsKey = "updateLastCheckedAt"
    static let skippedVersionDefaultsKey = "updateSkippedVersion"
    static let notifiedVersionDefaultsKey = "updateNotifiedVersion"
    /// 설정 화면의 기존 알림 토글. 꺼져 있으면 알림센터 통지는 보내지 않고 앱 안 배너만 남긴다.
    static let systemNotificationsDefaultsKey = "notifications"
    /// 회차 사이 최소 간격이자 실패 백오프의 출발점.
    static let retryDelay: TimeInterval = 60

    @Published private(set) var automaticCheckEnabled: Bool
    @Published private(set) var availableUpdate: ReleaseInfo?
    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var isChecking = false
    @Published private(set) var errorMessage: String?

    let currentVersion: AppVersion?

    private let defaults: UserDefaults
    private let now: @Sendable () -> Date
    private let fetch: @Sendable () async throws -> Data
    private let sleeper: @Sendable (TimeInterval) async throws -> Void
    private let notifier: UpdateNotifying
    private var task: Task<Void, Never>?
    private var manualTask: Task<Void, Never>?
    private var manualTaskGeneration = 0
    private var consecutiveFailures = 0

    init(
        currentVersion: AppVersion? = UpdateCheck.runningAppVersion,
        defaults: UserDefaults = .standard,
        notifier: UpdateNotifying = SystemUpdateNotifier(),
        now: @escaping @Sendable () -> Date = { Date() },
        sleeper: @escaping @Sendable (TimeInterval) async throws -> Void = { delay in
            try await Task.sleep(for: .seconds(delay))
        },
        fetch: @escaping @Sendable () async throws -> Data = UpdateService.fetchLatestRelease
    ) {
        self.currentVersion = currentVersion
        self.defaults = defaults
        self.notifier = notifier
        self.now = now
        self.sleeper = sleeper
        self.fetch = fetch
        // 키가 없으면 켜짐. bool(forKey:)는 없는 키를 false로 읽으므로 object로 확인한다.
        automaticCheckEnabled = defaults.object(forKey: Self.automaticCheckDefaultsKey) as? Bool ?? true
        lastCheckedAt = defaults.object(forKey: Self.lastCheckedAtDefaultsKey) as? Date
    }

    var skippedVersion: AppVersion? {
        (defaults.string(forKey: Self.skippedVersionDefaultsKey)).flatMap(AppVersion.init)
    }

    // MARK: - 수명 주기

    func resumeIfEnabled() {
        guard automaticCheckEnabled, currentVersion != nil else { return }
        beginPolling()
    }

    func setAutomaticCheckEnabled(_ enabled: Bool) {
        automaticCheckEnabled = enabled
        defaults.set(enabled, forKey: Self.automaticCheckDefaultsKey)
        if enabled {
            beginPolling()
        } else {
            stopPolling()
        }
    }

    func shutdown() {
        stopPolling()
        manualTask?.cancel()
        manualTask = nil
    }

    /// 폴링은 오직 `checkIfDue()`만 호출한다. 활성 여부와 주기 판단을 한 곳에 모아 두어야
    /// 테스트가 검증하는 경로와 앱이 실제로 타는 경로가 갈라지지 않는다.
    private func beginPolling() {
        guard task == nil, currentVersion != nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.automaticCheckEnabled else { return }
                let outcome = await self.checkIfDue()
                let delay = self.delayAfter(outcome)
                do { try await self.sleeper(delay) } catch { return }
            }
        }
    }

    private func stopPolling() {
        task?.cancel()
        task = nil
    }

    // MARK: - 확인

    enum CheckOutcome: Equatable {
        /// 확인이 끝나고 결과를 반영했다.
        case succeeded
        /// 확인을 시도했지만 네트워크나 응답이 실패했다.
        case failed
        /// 확인을 시도하지 않았다 (꺼져 있음, 주기 전, 이미 확인 중, 버전을 모름).
        case skipped
    }

    func delayUntilNextCheck() -> TimeInterval {
        UpdateCheck.delayUntilNextCheck(lastCheckedAt: lastCheckedAt, now: now())
    }

    /// 다음 회차까지 둘 간격. 어떤 경우에도 `retryDelay` 아래로 내려가지 않는다.
    func delayAfter(_ outcome: CheckOutcome) -> TimeInterval {
        switch outcome {
        case .failed: return failureBackoffDelay()
        case .succeeded, .skipped: return max(delayUntilNextCheck(), Self.retryDelay)
        }
    }

    /// 연속 실패마다 간격을 두 배로 늘리되 하루를 넘기지 않는다. 잠깐 오프라인이었던 사용자가
    /// 하루치 안내를 통째로 놓치지 않으면서, 계속 오프라인인 기기가 1분마다 재시도하지도 않는다.
    private func failureBackoffDelay() -> TimeInterval {
        let doublings = Double(min(max(consecutiveFailures - 1, 0), 16))
        return min(UpdateCheck.checkInterval, Self.retryDelay * pow(2, doublings))
    }

    /// 자동 주기용. 아직 주기가 안 됐으면 네트워크를 건드리지 않는다.
    @discardableResult
    func checkIfDue() async -> CheckOutcome {
        guard automaticCheckEnabled, delayUntilNextCheck() <= 0 else { return .skipped }
        return await check()
    }

    /// 설정의 `지금 확인` 버튼용. 주기와 무관하게 즉시 확인한다.
    func checkNow() {
        manualTask?.cancel()
        manualTaskGeneration += 1
        let generation = manualTaskGeneration
        manualTask = Task { [weak self] in
            await self?.check()
            // 자기 세대일 때만 슬롯을 비운다. 그러지 않으면 뒤늦게 끝난 이전 요청이
            // 지금 실행 중인 요청의 참조를 지워 shutdown()이 그것을 취소하지 못한다.
            guard let self, self.manualTaskGeneration == generation else { return }
            self.manualTask = nil
        }
    }

    /// 주기를 무시하고 한 번 확인한다.
    @discardableResult
    func check() async -> CheckOutcome {
        guard let currentVersion, !isChecking else { return .skipped }
        isChecking = true
        defer { isChecking = false }
        do {
            let data = try await fetch()
            let latest = try UpdateCheck.parseLatestRelease(data)
            consecutiveFailures = 0
            lastCheckedAt = now()
            defaults.set(lastCheckedAt, forKey: Self.lastCheckedAtDefaultsKey)
            errorMessage = nil
            let update = UpdateCheck.availableUpdate(
                latest: latest, current: currentVersion, skipping: skippedVersion
            )
            availableUpdate = update
            if let update { notifyIfFirstSighting(of: update) }
            return .succeeded
        } catch {
            // 취소는 실패가 아니다. 자동 확인을 끄거나 앱을 닫으면 진행 중이던 요청이 취소되는데,
            // URLSession은 그때 URLError(.cancelled)를 던진다. 이를 네트워크 오류로 보고하면
            // 거짓 오류가 설정 화면에 남고 백오프 카운터까지 오염된다.
            if Task.isCancelled { return .skipped }
            // 실패는 lastCheckedAt을 갱신하지 않는다. 그 값은 마지막으로 성공한 확인을 뜻하며,
            // 실패로 24시간 예산을 소모하면 잠깐의 네트워크 장애가 하루치 안내를 삼킨다.
            consecutiveFailures += 1
            errorMessage = "업데이트를 확인하지 못했습니다. 네트워크 상태를 확인해 주세요."
            return .failed
        }
    }

    /// 같은 버전으로는 한 번만 알린다. 더 높은 버전이 나오면 다시 알린다.
    private func notifyIfFirstSighting(of update: ReleaseInfo) {
        let alreadyNotified = defaults.string(forKey: Self.notifiedVersionDefaultsKey)
            .flatMap(AppVersion.init)
        if let alreadyNotified, update.version <= alreadyNotified { return }
        let systemNotificationsEnabled =
            defaults.object(forKey: Self.systemNotificationsDefaultsKey) as? Bool ?? true
        // 보내지 않았으면 보냈다고 기록하지 않는다. 그래야 알림을 껐다가 다시 켠 사용자가
        // 그 사이에 나온 버전을 영영 못 받는 일이 없다.
        guard systemNotificationsEnabled else { return }
        defaults.set(update.version.description, forKey: Self.notifiedVersionDefaultsKey)
        notifier.notifyUpdateAvailable(version: update.version.description)
    }

    // MARK: - 사용자 동작

    func skipCurrentUpdate() {
        guard let availableUpdate else { return }
        defaults.set(availableUpdate.version.description, forKey: Self.skippedVersionDefaultsKey)
        self.availableUpdate = nil
    }

    var releaseNotesURL: URL {
        availableUpdate?.notesURL ?? UpdateCheck.releasesPageURL
    }

    /// 배너와 설정 패널이 함께 쓰는 클립보드 복사. 두 화면이 서로 다른 명령을 넣는 일이 없도록 한 곳에 둔다.
    static func copyBrewUpgradeCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(UpdateCheck.brewUpgradeCommand, forType: .string)
    }

    // MARK: - 기본 네트워크 구현

    static let fetchLatestRelease: @Sendable () async throws -> Data = {
        var request = URLRequest(url: UpdateCheck.latestReleaseURL)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("PunchGrow", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw UpdateCheckError.badResponse(status: -1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw UpdateCheckError.badResponse(status: http.statusCode)
        }
        guard data.count <= UpdateCheck.maximumResponseBytes else {
            throw UpdateCheckError.responseTooLarge
        }
        return data
    }
}
