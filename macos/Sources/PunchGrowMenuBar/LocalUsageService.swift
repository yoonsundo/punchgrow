import Combine
import Darwin
import Foundation

@MainActor
final class LocalUsageService: ObservableObject {
    static let collectionEnabledDefaultsKey = "localUsageCollectionEnabled"

    @Published private(set) var collectionEnabled: Bool
    @Published private(set) var isRunning = false
    @Published private(set) var observedTotals: [TokenProvider: Int] = [:]
    @Published private(set) var observedWeeklyTotals: [TokenProvider: Int] = [:]
    @Published private(set) var observedWeeklyBreakdown: [TokenProvider: LocalUsageCounts] = [:]
    @Published private(set) var quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot] = [:]
    @Published private(set) var lastScanAt: Date?
    @Published private(set) var errorMessage: String?

    /// The endpoint is the same one Claude Code's status line polls. Asking more often than it does
    /// buys little — the provider recomputes on its own schedule — and risks being rate limited, so
    /// stay close to that cadence rather than matching the file scan interval.
    static let claudeQuotaPollInterval: TimeInterval = 60
    private static let maximumClaudeQuotaBackoffSteps = 3

    private let scanner: LocalUsageScanner
    private let persistence: LocalUsageCachePersistence
    private let usageAPI: ClaudeUsageAPIClient?
    private var lastClaudeQuotaPollAt: TimeInterval?
    private var claudeQuotaFailureStreak = 0
    private let interval: TimeInterval
    private let defaults: UserDefaults
    private let onEvents: ([TokenUsageEvent]) -> TokenIngestionResult
    private let onObservedTotals: (
        [TokenProvider: Int], [TokenProvider: Int], [TokenProvider: LocalUsageCounts],
        [TokenProvider: ProviderQuotaSnapshot]
    ) -> Void
    private let onDiscoveredProviders: (Set<TokenProvider>) -> Void
    private let onScanError: (String) -> Void
    private let onProviderScanError: (TokenProvider, String) -> Void
    private let monotonicNow: @Sendable () -> TimeInterval
    private let sleeper: @Sendable (TimeInterval) async throws -> Void
    private let scanOperation: @Sendable (
        LocalUsageScanner, LocalUsageCache
    ) throws -> LocalUsageScanResult
    private var task: Task<Void, Never>?
    private var scanWorker: Task<LocalUsageScanResult, Error>?
    private var scanWorkerID: UUID?
    private var restartAfterWorkerStops = false
    private var generation = 0

    init(
        scanner: LocalUsageScanner = LocalUsageScanner(),
        persistence: LocalUsageCachePersistence = LocalUsageCachePersistence(),
        usageAPI: ClaudeUsageAPIClient? = ClaudeUsageAPIClient(),
        interval: TimeInterval = 10,
        defaults: UserDefaults = .standard,
        onObservedTotals: @escaping (
            [TokenProvider: Int], [TokenProvider: Int], [TokenProvider: LocalUsageCounts],
            [TokenProvider: ProviderQuotaSnapshot]
        ) -> Void = { _, _, _, _ in },
        onDiscoveredProviders: @escaping (Set<TokenProvider>) -> Void = { _ in },
        onScanError: @escaping (String) -> Void = { _ in },
        onProviderScanError: @escaping (TokenProvider, String) -> Void = { _, _ in },
        monotonicNow: @escaping @Sendable () -> TimeInterval = {
            ProcessInfo.processInfo.systemUptime
        },
        sleeper: @escaping @Sendable (TimeInterval) async throws -> Void = { delay in
            try await Task.sleep(for: .seconds(delay))
        },
        scanOperation: @escaping @Sendable (
            LocalUsageScanner, LocalUsageCache
        ) throws -> LocalUsageScanResult = { scanner, cache in
            try scanner.scan(cache: cache)
        },
        onEvents: @escaping ([TokenUsageEvent]) -> TokenIngestionResult
    ) {
        self.scanner = scanner
        self.persistence = persistence
        self.usageAPI = usageAPI
        self.interval = interval
        self.defaults = defaults
        collectionEnabled = defaults.bool(forKey: Self.collectionEnabledDefaultsKey)
        self.onObservedTotals = onObservedTotals
        self.onDiscoveredProviders = onDiscoveredProviders
        self.onScanError = onScanError
        self.onProviderScanError = onProviderScanError
        self.monotonicNow = monotonicNow
        self.sleeper = sleeper
        self.scanOperation = scanOperation
        self.onEvents = onEvents
    }

    nonisolated static func nextScanDelay(
        activeDuration: TimeInterval,
        hasDrainableBacklog: Bool,
        idleInterval: TimeInterval = 10
    ) -> TimeInterval {
        guard hasDrainableBacklog else { return max(0, idleInterval) }
        return max(1, max(0, activeDuration) * 3)
    }

    func start() {
        setCollectionEnabled(true)
    }

    func resumeIfEnabled() {
        guard collectionEnabled else { return }
        beginScanning()
    }

    private func beginScanning() {
        guard task == nil else { return }
        guard scanWorker == nil else {
            restartAfterWorkerStops = true
            isRunning = true
            return
        }
        generation += 1
        let activeGeneration = generation
        isRunning = true
        task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                let startedAt = self.monotonicNow()
                await self.refreshClaudeQuotaIfDue()
                let hasDrainableBacklog = await self.scanOnce(generation: activeGeneration)
                guard !Task.isCancelled,
                      self.generation == activeGeneration,
                      self.collectionEnabled else { return }
                let activeDuration = max(0, self.monotonicNow() - startedAt)
                let delay = Self.nextScanDelay(
                    activeDuration: activeDuration,
                    hasDrainableBacklog: hasDrainableBacklog,
                    idleInterval: self.interval
                )
                do {
                    try await self.sleeper(delay)
                } catch {
                    return
                }
            }
        }
    }

    func stop() {
        setCollectionEnabled(false)
    }

    func shutdown() {
        stopScanning()
    }

    private func stopScanning() {
        generation += 1
        restartAfterWorkerStops = false
        task?.cancel()
        task = nil
        scanWorker?.cancel()
        isRunning = false
        onDiscoveredProviders([])
    }

    func disconnect() {
        setCollectionEnabled(false)
        do {
            try deleteLocalCache()
            observedTotals = [:]
            observedWeeklyTotals = [:]
            observedWeeklyBreakdown = [:]
            quotaSnapshots = [:]
            lastScanAt = nil
            errorMessage = nil
            onObservedTotals([:], [:], [:], [:])
        } catch {
            reportError("로컬 사용량 캐시를 삭제하지 못했습니다. 다른 앱이 파일을 사용 중인지 확인해 주세요.")
        }
    }

    private func setCollectionEnabled(_ enabled: Bool) {
        collectionEnabled = enabled
        defaults.set(enabled, forKey: Self.collectionEnabledDefaultsKey)
        if enabled {
            beginScanning()
        } else {
            stopScanning()
        }
    }

    /// Polls the Claude usage endpoint on its own schedule, independent of the file scan.
    ///
    /// A failed poll is not an error the user needs to see — the scan still publishes the cached
    /// file reading — so it only widens the retry gap, up to eight times the base interval.
    private func refreshClaudeQuotaIfDue() async {
        guard let usageAPI else { return }
        let now = monotonicNow()
        let backoffMultiplier = pow(2, Double(claudeQuotaFailureStreak))
        let isDue = lastClaudeQuotaPollAt.map {
            now - $0 >= Self.claudeQuotaPollInterval * backoffMultiplier
        } ?? true
        guard isDue else { return }
        lastClaudeQuotaPollAt = now

        if let snapshot = await usageAPI.fetchWeeklyQuota() {
            scanner.liveClaudeQuota.snapshot = snapshot
            claudeQuotaFailureStreak = 0
        } else {
            claudeQuotaFailureStreak = min(
                claudeQuotaFailureStreak + 1, Self.maximumClaudeQuotaBackoffSteps
            )
        }
    }

    private func scanOnce(generation activeGeneration: Int) async -> Bool {
        let scanner = self.scanner
        let persistence = self.persistence
        let scanOperation = self.scanOperation
        let workerID = UUID()
        let worker = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            let cache = try persistence.load()
            try Task.checkCancellation()
            let result = try autoreleasepool {
                try scanOperation(scanner, cache)
            }
            malloc_zone_pressure_relief(malloc_default_zone(), 0)
            return result
        }
        scanWorker = worker
        scanWorkerID = workerID
        defer {
            if scanWorkerID == workerID {
                scanWorker = nil
                scanWorkerID = nil
                let shouldRestart = restartAfterWorkerStops
                    && collectionEnabled && task == nil
                restartAfterWorkerStops = false
                if shouldRestart {
                    beginScanning()
                }
            }
        }
        do {
            let result = try await worker.value
            guard generation == activeGeneration, collectionEnabled else { return false }
            let ingestion = result.creditEvents.isEmpty ? TokenIngestionResult.duplicate : onEvents(result.creditEvents)
            guard ingestion != .failed else {
                reportError(TokenIngestionResult.persistenceFailureMessage)
                return false
            }
            // Keep the write on the main actor so disconnect cannot race it and recreate a
            // cache after the user has requested deletion.
            try persistence.save(result.cache)
            guard generation == activeGeneration, collectionEnabled else { return false }
            observedTotals = result.observedTotals
            observedWeeklyTotals = result.observedWeeklyTotals
            observedWeeklyBreakdown = result.observedWeeklyBreakdown
            quotaSnapshots = result.quotaSnapshots
            onObservedTotals(
                result.observedTotals, result.observedWeeklyTotals,
                result.observedWeeklyBreakdown, result.quotaSnapshots
            )
            onDiscoveredProviders(Set(result.successfulProviders))
            lastScanAt = .now
            if result.failedProviders.isEmpty {
                errorMessage = nil
            } else {
                let providers = result.failedProviders.map(\.rawValue).joined(separator: ", ")
                let message = "일부 로컬 사용량 로그를 읽지 못했습니다: \(providers)"
                errorMessage = message
                for provider in result.failedProviders {
                    onProviderScanError(provider, message)
                }
            }
            return result.hasDrainableBacklog
        } catch {
            guard generation == activeGeneration, collectionEnabled else { return false }
            reportError("로컬 사용량 로그를 안전하게 읽지 못했습니다. 원본 로그는 변경하지 않았습니다.")
            return false
        }
    }

    private func reportError(_ message: String) {
        errorMessage = message
        onScanError(message)
    }

    private func deleteLocalCache() throws {
        let manager = FileManager.default
        for url in [persistence.fileURL, persistence.fileURL.appendingPathExtension("tmp")] {
            guard manager.fileExists(atPath: url.path) else { continue }
            let values = try url.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory != true else { throw CollectorError.invalidPayload }
            try manager.removeItem(at: url)
        }
    }
}
