import CryptoKit
import Darwin
import Foundation

struct LocalUsageScanner: Sendable {
    private static let readChunkSize = 256 * 1024
    private static let maximumLineSize = 8 * 1024 * 1024
    private static let defaultProviderBodyReadSoftBudget = 4 * 1024 * 1024
    private static let maximumFilesPerRoot = 100_000
    private static let dateParser = LockedISO8601Parser()
    private static let jsonDecoder = LockedJSONDecoder()
    private static let jsonTypeKey = Data(#""type""#.utf8)
    private static let jsonContentKey = Data(#""content""#.utf8)
    private static let jsonUsageKey = Data(#""usage""#.utf8)
    private static let hexDigits = Array("0123456789abcdef".utf8)
    private static let claudeRelevantTypes = [Data(#""assistant""#.utf8)]
    private static let codexRelevantTypes = [
        Data(#""session_meta""#.utf8),
        Data(#""event_msg""#.utf8),
    ]

    private final class LockedISO8601Parser: @unchecked Sendable {
        private let lock = NSLock()
        private let fractional: ISO8601DateFormatter
        private let standard = ISO8601DateFormatter()

        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        }

        func parse(_ value: String) -> Date? {
            lock.lock()
            defer { lock.unlock() }
            return fractional.date(from: value) ?? standard.date(from: value)
        }
    }

    private final class LockedJSONDecoder: @unchecked Sendable {
        private let lock = NSLock()
        private let decoder = JSONDecoder()

        func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
            lock.lock()
            defer { lock.unlock() }
            return try decoder.decode(type, from: data)
        }
    }

    private enum NumberOrString: Decodable {
        case number(Double)
        case string(String)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let integer = try? container.decode(Int.self) {
                self = .number(Double(integer))
            } else if let number = try? container.decode(Double.self) {
                self = .number(number)
            } else {
                self = .string(try container.decode(String.self))
            }
        }
    }

    private enum NumberField {
        case absent
        case value(NumberOrString)
        case invalid

        var isAbsent: Bool {
            if case .absent = self { return true }
            return false
        }
    }

    private struct ClaudeRecord: Decodable {
        let type: String?
        let requestID: String?
        let timestamp: String?
        let message: ClaudeMessage?

        private enum CodingKeys: String, CodingKey {
            case type
            case requestID = "requestId"
            case timestamp
            case message
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            type = try? container.decode(String.self, forKey: .type)
            requestID = try? container.decode(String.self, forKey: .requestID)
            timestamp = try? container.decode(String.self, forKey: .timestamp)
            message = try? container.decode(ClaudeMessage.self, forKey: .message)
        }
    }

    private struct ClaudeMessage: Decodable {
        let id: String?
        let usage: ClaudeUsage?

        private enum CodingKeys: String, CodingKey { case id, usage }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try? container.decode(String.self, forKey: .id)
            usage = try? container.decode(ClaudeUsage.self, forKey: .usage)
        }
    }

    private struct ClaudeUsage: Decodable {
        let inputTokens: NumberField
        let cacheCreationInputTokens: NumberField
        let cacheReadInputTokens: NumberField
        let outputTokens: NumberField

        private enum CodingKeys: String, CodingKey {
            case inputTokens = "input_tokens"
            case cacheCreationInputTokens = "cache_creation_input_tokens"
            case cacheReadInputTokens = "cache_read_input_tokens"
            case outputTokens = "output_tokens"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            inputTokens = Self.field(.inputTokens, in: container)
            cacheCreationInputTokens = Self.field(.cacheCreationInputTokens, in: container)
            cacheReadInputTokens = Self.field(.cacheReadInputTokens, in: container)
            outputTokens = Self.field(.outputTokens, in: container)
        }

        private static func field(
            _ key: CodingKeys,
            in container: KeyedDecodingContainer<CodingKeys>
        ) -> NumberField {
            guard container.contains(key) else { return .absent }
            guard let value = try? container.decode(NumberOrString.self, forKey: key) else {
                return .invalid
            }
            return .value(value)
        }
    }

    private struct CodexRecord: Decodable {
        let type: String?
        let timestamp: String?
        let payload: CodexPayload?

        private enum CodingKeys: String, CodingKey { case type, timestamp, payload }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            type = try? container.decode(String.self, forKey: .type)
            timestamp = try? container.decode(String.self, forKey: .timestamp)
            payload = try? container.decode(CodexPayload.self, forKey: .payload)
        }
    }

    private struct CodexPayload: Decodable {
        let type: String?
        let id: String?
        let sessionID: String?
        let timestamp: String?
        let isForkMetadata: Bool
        let turnID: String?
        let startedAt: NumberOrString?
        let info: CodexUsageInfo?
        let rateLimits: CodexRateLimits?

        private enum CodingKeys: String, CodingKey {
            case type, id, timestamp, info
            case rateLimits = "rate_limits"
            case sessionID = "session_id"
            case forkedFromID = "forked_from_id"
            case parentThreadID = "parent_thread_id"
            case turnID = "turn_id"
            case startedAt = "started_at"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            type = try? container.decode(String.self, forKey: .type)
            id = try? container.decode(String.self, forKey: .id)
            sessionID = try? container.decode(String.self, forKey: .sessionID)
            timestamp = try? container.decode(String.self, forKey: .timestamp)
            isForkMetadata = container.contains(.forkedFromID)
                || container.contains(.parentThreadID)
            turnID = try? container.decode(String.self, forKey: .turnID)
            startedAt = try? container.decode(NumberOrString.self, forKey: .startedAt)
            info = try? container.decode(CodexUsageInfo.self, forKey: .info)
            rateLimits = try? container.decode(CodexRateLimits.self, forKey: .rateLimits)
        }
    }

    private struct CodexRateLimits: Decodable {
        let primary: CodexRateLimitWindow?
    }

    private struct CodexRateLimitWindow: Decodable {
        let usedPercent: Double
        let resetsAt: TimeInterval?

        private enum CodingKeys: String, CodingKey {
            case usedPercent = "used_percent"
            case resetsAt = "resets_at"
        }
    }

    private struct CodexUsageInfo: Decodable {
        let totalTokenUsage: CodexUsage?
        let lastTokenUsage: CodexUsage?

        private enum CodingKeys: String, CodingKey {
            case totalTokenUsage = "total_token_usage"
            case lastTokenUsage = "last_token_usage"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            totalTokenUsage = try? container.decode(CodexUsage.self, forKey: .totalTokenUsage)
            lastTokenUsage = try? container.decode(CodexUsage.self, forKey: .lastTokenUsage)
        }
    }

    private struct CodexUsage: Decodable {
        let inputTokens: NumberField
        let cachedInputTokens: NumberField
        let cacheReadInputTokens: NumberField
        let cacheWriteInputTokens: NumberField
        let outputTokens: NumberField

        private enum CodingKeys: String, CodingKey {
            case inputTokens = "input_tokens"
            case cachedInputTokens = "cached_input_tokens"
            case cacheReadInputTokens = "cache_read_input_tokens"
            case cacheWriteInputTokens = "cache_write_input_tokens"
            case outputTokens = "output_tokens"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            inputTokens = Self.field(.inputTokens, in: container)
            cachedInputTokens = Self.field(.cachedInputTokens, in: container)
            cacheReadInputTokens = Self.field(.cacheReadInputTokens, in: container)
            cacheWriteInputTokens = Self.field(.cacheWriteInputTokens, in: container)
            outputTokens = Self.field(.outputTokens, in: container)
        }

        private static func field(
            _ key: CodingKeys,
            in container: KeyedDecodingContainer<CodingKeys>
        ) -> NumberField {
            guard container.contains(key) else { return .absent }
            guard let value = try? container.decode(NumberOrString.self, forKey: key) else {
                return .invalid
            }
            return .value(value)
        }
    }

    let claudeRoot: URL
    let codexRoot: URL
    private let fileLimit: Int
    private let providerBodyReadSoftBudget: Int

    private struct FileDescriptor {
        let url: URL
        let fileKey: String
        let snapshotSize: UInt64
        let modificationDate: Date?
    }

    private struct ProviderScanOutcome {
        let completedFullCycle: Bool
        let hasDrainableBacklog: Bool
        let waitingForWriterTail: Bool
    }

    private struct FileScanOutcome {
        let transaction: FileTransaction
        let bytesRead: Int
        let hasDrainableBacklog: Bool
        let waitingForWriterTail: Bool
    }

    private struct LineReadOutcome {
        let consumedOffset: UInt64
        let bytesRead: Int
        let discardingOversizedLine: Bool
        let hasDrainableBacklog: Bool
        let waitingForWriterTail: Bool
    }

    private struct ProviderOverlay {
        let provider: TokenProvider
        var files: [String: LocalUsageFileCursor] = [:]
        var maximums: [String: LocalUsageMaximum] = [:]
        var deltas: [(TokenProvider, String, LocalUsageCounts)] = []
        var resumeAfterFileKey: String?
        var quotaSnapshot: ProviderQuotaSnapshot?

        func cursor(for key: String, base: LocalUsageCache) -> LocalUsageFileCursor? {
            files[key] ?? base.files[key]
        }

        func maximum(for key: String, base: LocalUsageCache) -> LocalUsageMaximum? {
            if let maximum = maximums[key] { return maximum }
            switch provider {
            case .claude:
                return base.claudeMaximums[key]
            case .codex:
                return base.codexMaximums[key]
            case .attendance, .reward:
                return nil
            }
        }

        mutating func commit(_ transaction: FileTransaction) {
            files[transaction.fileKey] = transaction.cursor
            for (key, maximum) in transaction.maximums {
                maximums[key] = maximum
            }
            deltas.append(contentsOf: transaction.deltas)
            if let candidate = transaction.quotaSnapshot,
               quotaSnapshot == nil || candidate.observedAt >= quotaSnapshot!.observedAt {
                quotaSnapshot = candidate
            }
        }

        func apply(to cache: inout LocalUsageCache) {
            for (key, cursor) in files {
                cache.files[key] = cursor
            }
            switch provider {
            case .claude:
                for (key, maximum) in maximums {
                    cache.claudeMaximums[key] = maximum
                }
            case .codex:
                for (key, maximum) in maximums {
                    cache.codexMaximums[key] = maximum
                }
            case .attendance, .reward:
                break
            }
            var markers = cache.resumeAfterFileKeys ?? [:]
            if let resumeAfterFileKey {
                markers[provider] = resumeAfterFileKey
            } else {
                markers.removeValue(forKey: provider)
            }
            cache.resumeAfterFileKeys = markers.isEmpty ? nil : markers
            if let quotaSnapshot {
                var snapshots = cache.quotaSnapshots ?? [:]
                // Only move the reading forward in time. A pass reads whatever slice of the log
                // rotation its byte budget reaches, so most passes surface a rate-limit record from
                // some older session; without this guard those overwrite the newest reading and the
                // displayed percentage jumps around the last few days of history. Comparing observed
                // time rather than percentage is what lets a weekly reset through, since the record
                // that reports the drop to zero is also the newest one.
                if snapshots[provider].map({ quotaSnapshot.observedAt >= $0.observedAt }) ?? true {
                    snapshots[provider] = quotaSnapshot
                    cache.quotaSnapshots = snapshots
                }
            }
        }
    }

    private struct FileTransaction {
        let fileKey: String
        var cursor: LocalUsageFileCursor
        var maximums: [String: LocalUsageMaximum] = [:]
        var deltas: [(TokenProvider, String, LocalUsageCounts)] = []
        var quotaSnapshot: ProviderQuotaSnapshot?

        func maximum(
            for key: String,
            providerOverlay: ProviderOverlay,
            base: LocalUsageCache
        ) -> LocalUsageMaximum? {
            maximums[key] ?? providerOverlay.maximum(for: key, base: base)
        }
    }

    init(
        claudeRoot: URL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude/projects"),
        codexRoot: URL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".codex/sessions"),
        fileLimit: Int = Self.maximumFilesPerRoot,
        providerBodyReadSoftBudget: Int = Self.defaultProviderBodyReadSoftBudget
    ) {
        self.claudeRoot = claudeRoot
        self.codexRoot = codexRoot
        self.fileLimit = fileLimit
        self.providerBodyReadSoftBudget = max(1, providerBodyReadSoftBudget)
    }

    func scan(cache original: LocalUsageCache, now: Date = .now) throws -> LocalUsageScanResult {
        try Task.checkCancellation()
        try original.validate()
        var cache = original
        var deltas: [(TokenProvider, String, LocalUsageCounts)] = []
        let baselineCompletedProviders = original.baselineCompletedProviders
            ?? (original.baselineCompleted ? [.claude, .codex] : [])
        var completedProviders = baselineCompletedProviders
        var successfulProviders: [TokenProvider] = []
        var failedProviders: [TokenProvider] = []
        var hasDrainableBacklog = false
        var firstProviderError: Error?
        for (root, provider) in [(claudeRoot, TokenProvider.claude), (codexRoot, .codex)] {
            try Task.checkCancellation()
            var providerOverlay = ProviderOverlay(provider: provider)
            do {
                let outcome = try scan(
                    root: root, provider: provider,
                    baseCache: cache, overlay: &providerOverlay
                )
                providerOverlay.apply(to: &cache)
                deltas.append(contentsOf: providerOverlay.deltas)
                if outcome.completedFullCycle, !completedProviders.contains(provider) {
                    completedProviders.append(provider)
                }
                hasDrainableBacklog = hasDrainableBacklog || outcome.hasDrainableBacklog
                successfulProviders.append(provider)
            } catch {
                if error is CancellationError { throw error }
                firstProviderError = firstProviderError ?? error
                failedProviders.append(provider)
            }
        }
        try Task.checkCancellation()
        if successfulProviders.isEmpty, let firstProviderError {
            throw firstProviderError
        }

        let observed = try observedTotals(cache)
        let weeklyBreakdown = try observedWeeklyBreakdown(cache, now: now)
        let weekly = weeklyBreakdown.mapValues(\.totalTokens)
        if let claudeQuota = try? readClaudeQuotaSnapshot() {
            var snapshots = cache.quotaSnapshots ?? [:]
            snapshots[.claude] = claudeQuota
            cache.quotaSnapshots = snapshots
        }
        let creditEvents = try deltas
            .filter { provider, _, _ in baselineCompletedProviders.contains(provider) }
            .flatMap { provider, key, counts in
                try Self.events(provider: provider, sourceKey: key, counts: counts, occurredAt: now)
            }
        cache.baselineCompletedProviders = completedProviders
        cache.baselineCompleted = completedProviders.contains(.claude)
            && completedProviders.contains(.codex)
        try cache.validate()
        return LocalUsageScanResult(
            cache: cache, observedTotals: observed,
            observedWeeklyTotals: weekly, observedWeeklyBreakdown: weeklyBreakdown,
            quotaSnapshots: cache.quotaSnapshots ?? [:],
            creditEvents: creditEvents, successfulProviders: successfulProviders,
            failedProviders: failedProviders, hasDrainableBacklog: hasDrainableBacklog
        )
    }

    private func scan(
        root: URL,
        provider: TokenProvider,
        baseCache: LocalUsageCache,
        overlay: inout ProviderOverlay
    ) throws -> ProviderScanOutcome {
        guard FileManager.default.fileExists(atPath: root.path) else {
            overlay.resumeAfterFileKey = nil
            return ProviderScanOutcome(
                completedFullCycle: true, hasDrainableBacklog: false,
                waitingForWriterTail: false
            )
        }
        // URL resource values can stay cached across a file-to-directory recovery.
        // Read fresh filesystem attributes on every scan so a repaired root reconnects.
        let rootAttributes = try FileManager.default.attributesOfItem(atPath: root.path)
        guard rootAttributes[.type] as? FileAttributeType == .typeDirectory else {
            throw CollectorError.invalidPayload
        }
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [
                .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey,
            ],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { throw CollectorError.invalidPayload }

        var descriptors: [FileDescriptor] = []
        for case let fileURL as URL in enumerator {
            try Task.checkCancellation()
            let values: URLResourceValues
            do {
                values = try fileURL.resourceValues(forKeys: [
                    .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
                    .contentModificationDateKey,
                ])
            } catch {
                // A file can disappear while the directory enumerator is running.
                continue
            }
            if values.isSymbolicLink == true {
                enumerator.skipDescendants()
                continue
            }
            guard values.isRegularFile == true, fileURL.pathExtension == "jsonl" else { continue }
            guard descriptors.count < fileLimit else {
                throw CollectorError.invalidPayload
            }
            let size = UInt64(max(0, values.fileSize ?? 0))
            let fileKey = Self.hash("file:\(provider.rawValue):\(fileURL.path)")
            descriptors.append(FileDescriptor(
                url: fileURL, fileKey: fileKey, snapshotSize: size,
                modificationDate: values.contentModificationDate
            ))
        }
        try Task.checkCancellation()
        descriptors.sort { $0.fileKey < $1.fileKey }
        guard !descriptors.isEmpty else {
            overlay.resumeAfterFileKey = nil
            return ProviderScanOutcome(
                completedFullCycle: true, hasDrainableBacklog: false,
                waitingForWriterTail: false
            )
        }
        let newestModification = descriptors.compactMap(\.modificationDate).max()
        let quotaNeedsRefresh = baseCache.quotaSnapshots?[.codex].map { snapshot in
            newestModification.map { snapshot.observedAt.addingTimeInterval(5) < $0 } ?? false
        } ?? true
        if provider == .codex, quotaNeedsRefresh {
            let recent = descriptors.sorted {
                ($0.modificationDate ?? .distantPast) > ($1.modificationDate ?? .distantPast)
            }.prefix(32)
            let snapshots = try recent.compactMap {
                try readLatestCodexQuota(from: $0.url, size: $0.snapshotSize)
            }
            overlay.quotaSnapshot = snapshots.max { $0.observedAt < $1.observedAt }
        }

        let marker = baseCache.resumeAfterFileKeys?[provider]
        let start = marker.map { upperBound(of: $0, in: descriptors) } ?? 0
        let ordered = Array(descriptors[start...]) + Array(descriptors[..<start])
        var bodyBytesRead = 0
        var hasDrainableBacklog = false
        var waitingForWriterTail = false
        for descriptor in ordered {
            try Task.checkCancellation()
            let prior = overlay.cursor(for: descriptor.fileKey, base: baseCache)
            let metadataChanged = prior?.fileSize != descriptor.snapshotSize
                || prior?.lastModifiedAt != descriptor.modificationDate
            let hasUnreadBody = prior == nil
                || prior?.byteOffset != descriptor.snapshotSize
                || prior?.discardingOversizedLine == true
                || metadataChanged
            guard hasUnreadBody else {
                overlay.resumeAfterFileKey = descriptor.fileKey
                continue
            }
            guard bodyBytesRead < providerBodyReadSoftBudget else {
                hasDrainableBacklog = true
                break
            }
            overlay.resumeAfterFileKey = descriptor.fileKey
            do {
                let outcome = try scanFile(
                    descriptor.url, fileKey: descriptor.fileKey,
                    size: descriptor.snapshotSize,
                    modificationDate: descriptor.modificationDate,
                    provider: provider, baseCache: baseCache,
                    providerOverlay: overlay,
                    providerBytesRead: bodyBytesRead
                )
                bodyBytesRead += outcome.bytesRead
                hasDrainableBacklog = hasDrainableBacklog || outcome.hasDrainableBacklog
                waitingForWriterTail = waitingForWriterTail || outcome.waitingForWriterTail
                overlay.commit(outcome.transaction)
            } catch {
                if error is CancellationError { throw error }
                // Preserve file-level rollback and let later descriptors progress.
                hasDrainableBacklog = true
            }
        }
        try Task.checkCancellation()

        let fullyDrained = descriptors.allSatisfy { descriptor in
            guard let cursor = overlay.cursor(for: descriptor.fileKey, base: baseCache) else {
                return descriptor.snapshotSize == 0
            }
            return cursor.byteOffset == descriptor.snapshotSize
                && cursor.discardingOversizedLine != true
        }
        if fullyDrained {
            overlay.resumeAfterFileKey = nil
        }
        return ProviderScanOutcome(
            completedFullCycle: fullyDrained,
            hasDrainableBacklog: hasDrainableBacklog,
            waitingForWriterTail: waitingForWriterTail
        )
    }

    private func upperBound(of key: String, in descriptors: [FileDescriptor]) -> Int {
        var lower = 0
        var upper = descriptors.count
        while lower < upper {
            let middle = lower + (upper - lower) / 2
            if descriptors[middle].fileKey <= key {
                lower = middle + 1
            } else {
                upper = middle
            }
        }
        return lower == descriptors.count ? 0 : lower
    }

    private func scanFile(
        _ fileURL: URL,
        fileKey: String,
        size: UInt64,
        modificationDate: Date?,
        provider: TokenProvider,
        baseCache: LocalUsageCache,
        providerOverlay: ProviderOverlay,
        providerBytesRead: Int
    ) throws -> FileScanOutcome {
        let priorCursor = providerOverlay.cursor(for: fileKey, base: baseCache)
        var transaction = FileTransaction(
            fileKey: fileKey,
            cursor: priorCursor ?? LocalUsageFileCursor(
                byteOffset: 0, fileSize: size, contentPrefixHash: nil,
                contentPrefixByteCount: 0, lastModifiedAt: nil,
                codexSessionKey: nil, codexTurnKey: nil,
                codexForkedAt: nil, codexReplayBaseline: nil,
                discardingOversizedLine: nil
            )
        )
        var cursor = transaction.cursor
        let comparisonCount = cursor.contentPrefixHash == nil
            ? min(Int(size), 4_096)
            : cursor.contentPrefixByteCount
        let prefixHash = try contentPrefixHash(fileURL, byteCount: comparisonCount)
        let sameSizeWasRewritten = size == cursor.fileSize
            && cursor.lastModifiedAt != nil
            && cursor.lastModifiedAt != modificationDate
        if size < cursor.byteOffset || sameSizeWasRewritten
            || (cursor.contentPrefixHash != nil && cursor.contentPrefixHash != prefixHash) {
            cursor.byteOffset = 0
            cursor.codexSessionKey = nil
            cursor.codexTurnKey = nil
            cursor.codexForkedAt = nil
            cursor.codexReplayBaseline = nil
            cursor.discardingOversizedLine = nil
            cursor.contentPrefixByteCount = min(Int(size), 4_096)
            cursor.contentPrefixHash = try contentPrefixHash(
                fileURL, byteCount: cursor.contentPrefixByteCount
            )
        } else if cursor.contentPrefixHash == nil {
            cursor.contentPrefixByteCount = comparisonCount
            cursor.contentPrefixHash = prefixHash
        }
        if size > cursor.byteOffset {
            let lineOutcome = try readLines(
                fileURL, from: cursor.byteOffset, through: size,
                providerBytesRead: providerBytesRead,
                discardingOversizedLine: cursor.discardingOversizedLine == true
            ) { line in
                do {
                    switch provider {
                    case .claude:
                        try parseClaude(
                            line, baseCache: baseCache, providerOverlay: providerOverlay,
                            transaction: &transaction
                        )
                    case .codex:
                        try parseCodex(
                            line, cursor: &cursor, baseCache: baseCache,
                            providerOverlay: providerOverlay, transaction: &transaction
                        )
                    case .attendance, .reward:
                        break
                    }
                } catch CollectorError.invalidPayload {
                    // A corrupt record must not stall later valid append-only records.
                }
            }
            cursor.byteOffset = lineOutcome.consumedOffset
            cursor.discardingOversizedLine = lineOutcome.discardingOversizedLine ? true : nil
            cursor.fileSize = size
            cursor.lastModifiedAt = modificationDate
            transaction.cursor = cursor
            return FileScanOutcome(
                transaction: transaction, bytesRead: lineOutcome.bytesRead,
                hasDrainableBacklog: lineOutcome.hasDrainableBacklog,
                waitingForWriterTail: lineOutcome.waitingForWriterTail
            )
        }
        cursor.fileSize = size
        cursor.lastModifiedAt = modificationDate
        transaction.cursor = cursor
        return FileScanOutcome(
            transaction: transaction, bytesRead: 0, hasDrainableBacklog: false,
            waitingForWriterTail: false
        )
    }

    private func parseClaude(
        _ line: Data,
        baseCache: LocalUsageCache,
        providerOverlay: ProviderOverlay,
        transaction: inout FileTransaction
    ) throws {
        guard Self.containsJSONType(line, values: Self.claudeRelevantTypes) else { return }
        let projection = Self.projectClaudeRecord(line)
        let projectedRecord = try? Self.jsonDecoder.decode(ClaudeRecord.self, from: projection)
        let usableProjection = projectedRecord.flatMap { record in
            record.type == "assistant"
                && record.requestID?.isEmpty == false
                && record.message?.id?.isEmpty == false
                && record.message?.usage != nil
                ? record : nil
        }
        let record = usableProjection ?? (projection.count == line.count
            ? nil
            : try? Self.jsonDecoder.decode(ClaudeRecord.self, from: line))
        guard let root = record,
              root.type == "assistant",
              let message = root.message,
              let messageID = message.id, !messageID.isEmpty,
              let requestID = root.requestID, !requestID.isEmpty,
              let usage = message.usage else { return }
        let input = try boundedInt(usage.inputTokens)
        let cacheCreation = try boundedInt(usage.cacheCreationInputTokens, defaultValue: 0)
        let cacheRead = try boundedInt(usage.cacheReadInputTokens, defaultValue: 0)
        let output = try boundedInt(usage.outputTokens)
        let cached = cacheCreation.addingReportingOverflow(cacheRead)
        guard !cached.overflow else { throw CollectorError.invalidPayload }
        let counts = LocalUsageCounts(inputTokens: input, cachedTokens: cached.partialValue, outputTokens: output)
        let occurredAt = parseDate(root.timestamp) ?? .distantPast
        let key = Self.hash("claude-message:\(messageID):request:\(requestID)")
        let prior = transaction.maximum(
            for: key, providerOverlay: providerOverlay, base: baseCache
        )
        try reconcile(
            key: key, counts: counts, occurredAt: occurredAt, provider: .claude,
            prior: prior, maximums: &transaction.maximums, deltas: &transaction.deltas
        )
    }

    private func parseCodex(
        _ line: Data,
        cursor: inout LocalUsageFileCursor,
        baseCache: LocalUsageCache,
        providerOverlay: ProviderOverlay,
        transaction: inout FileTransaction
    ) throws {
        guard Self.containsJSONType(line, values: Self.codexRelevantTypes) else { return }
        guard let root = try? Self.jsonDecoder.decode(CodexRecord.self, from: line),
              let type = root.type,
              let payload = root.payload else { return }

        if type == "session_meta", let sessionID = payload.id ?? payload.sessionID {
            let isForkMetadata = payload.isForkMetadata
            // Forked rollouts can replay the parent's session_meta after the child's.
            // Keep the first child identity instead of merging child totals into the parent.
            if cursor.codexSessionKey == nil || isForkMetadata {
                cursor.codexSessionKey = Self.hash("codex-session:\(sessionID)")
            }
            if isForkMetadata {
                cursor.codexForkedAt = parseDate(payload.timestamp)
                    ?? parseDate(root.timestamp)
                cursor.codexReplayBaseline = .zero
            }
            return
        }
        if type == "event_msg", payload.type == "task_started", let turnID = payload.turnID {
            let turnKey = Self.hash("codex-turn:\(turnID)")
            if let forkedAt = cursor.codexForkedAt {
                guard let startedAt = parseCodexTaskStart(payload.startedAt),
                      startedAt >= Date(timeIntervalSince1970: floor(forkedAt.timeIntervalSince1970)) else {
                    cursor.codexTurnKey = nil
                    return
                }
                cursor.codexForkedAt = nil
            }
            cursor.codexTurnKey = turnKey
            return
        }
        guard type == "event_msg", payload.type == "token_count",
              let info = payload.info else { return }
        let timestamp = root.timestamp ?? "unknown"
        let occurredAt = parseDate(timestamp) ?? .distantPast
        if let primary = payload.rateLimits?.primary,
           primary.usedPercent >= 0, primary.usedPercent <= 100 {
            transaction.quotaSnapshot = ProviderQuotaSnapshot(
                usedPercent: primary.usedPercent,
                resetsAt: primary.resetsAt.map(Date.init(timeIntervalSince1970:)),
                observedAt: occurredAt
            )
        }

        let session = cursor.codexSessionKey ?? "unknown"
        if let usage = info.totalTokenUsage {
            let cumulative = try parseCodexCounts(usage)
            if cursor.codexForkedAt != nil {
                cursor.codexReplayBaseline = (cursor.codexReplayBaseline ?? .zero)
                    .componentwiseMaximum(with: cumulative)
                return
            }
            let relative = try cumulative.subtracting(cursor.codexReplayBaseline ?? .zero)
            let key = Self.hash("codex-session-total:\(session)")
            let prior = transaction.maximum(
                for: key, providerOverlay: providerOverlay, base: baseCache
            )
            try reconcile(
                key: key,
                counts: relative, occurredAt: occurredAt,
                provider: .codex, prior: prior,
                maximums: &transaction.maximums, deltas: &transaction.deltas
            )
            return
        }

        guard cursor.codexForkedAt == nil,
              let usage = info.lastTokenUsage else { return }
        let counts = try parseCodexCounts(usage)
        let turn = cursor.codexTurnKey ?? "unknown"
        let key = Self.hash("codex-turn-fallback:\(session):\(turn)")
        let prior = transaction.maximum(
            for: key, providerOverlay: providerOverlay, base: baseCache
        )
        try reconcileFallbackSnapshot(
            key: key, counts: counts, occurredAt: occurredAt, prior: prior,
            maximums: &transaction.maximums, deltas: &transaction.deltas
        )
    }

    private func parseCodexCounts(_ usage: CodexUsage) throws -> LocalUsageCounts {
        let reportedInput = try boundedInt(usage.inputTokens)
        let cacheReadField = usage.cachedInputTokens.isAbsent
            ? usage.cacheReadInputTokens
            : usage.cachedInputTokens
        let cacheRead = try boundedInt(
            cacheReadField, defaultValue: 0
        )
        let cacheWrite = try boundedInt(usage.cacheWriteInputTokens, defaultValue: 0)
        let output = try boundedInt(usage.outputTokens)
        let cached = cacheRead.addingReportingOverflow(cacheWrite)
        guard !cached.overflow else { throw CollectorError.invalidPayload }
        let input = max(0, reportedInput - min(reportedInput, cached.partialValue))
        return LocalUsageCounts(
            inputTokens: input, cachedTokens: cached.partialValue, outputTokens: output
        )
    }

    private struct ClaudeQuotaCache: Decodable {
        let timestamp: TimeInterval?
        let lastSuccessAt: TimeInterval?
        let data: ClaudeQuotaData?
    }

    private func readLatestCodexQuota(from url: URL, size: UInt64) throws -> ProviderQuotaSnapshot? {
        let maximumTail = UInt64(1024 * 1024)
        let offset = size > maximumTail ? size - maximumTail : 0
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        let data = try handle.readToEnd() ?? Data()
        let lines = data.split(separator: 0x0A, omittingEmptySubsequences: true)
        for rawLine in lines.reversed() {
            guard let root = try? Self.jsonDecoder.decode(CodexRecord.self, from: Data(rawLine)),
                  root.type == "event_msg", root.payload?.type == "token_count",
                  let primary = root.payload?.rateLimits?.primary,
                  primary.usedPercent >= 0, primary.usedPercent <= 100 else { continue }
            let observedAt = root.timestamp.flatMap(parseDate) ?? .distantPast
            return ProviderQuotaSnapshot(
                usedPercent: primary.usedPercent,
                resetsAt: primary.resetsAt.map(Date.init(timeIntervalSince1970:)),
                observedAt: observedAt
            )
        }
        return nil
    }

    private struct ClaudeQuotaData: Decodable {
        let weeklyPercent: Double
        let weeklyResetsAt: String?
    }

    private func readClaudeQuotaSnapshot() throws -> ProviderQuotaSnapshot? {
        let url = claudeRoot.deletingLastPathComponent()
            .appending(path: "plugins/oh-my-claudecode/.usage-cache-anthropic.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        let cache = try Self.jsonDecoder.decode(ClaudeQuotaCache.self, from: data)
        guard let quota = cache.data, quota.weeklyPercent >= 0, quota.weeklyPercent <= 100 else {
            return nil
        }
        let milliseconds = cache.lastSuccessAt ?? cache.timestamp ?? 0
        return ProviderQuotaSnapshot(
            usedPercent: quota.weeklyPercent,
            resetsAt: quota.weeklyResetsAt.flatMap(parseDate),
            observedAt: Date(timeIntervalSince1970: milliseconds / 1_000)
        )
    }

    private func reconcileFallbackSnapshot(
        key: String,
        counts: LocalUsageCounts,
        occurredAt: Date,
        prior: LocalUsageMaximum?,
        maximums: inout [String: LocalUsageMaximum],
        deltas: inout [(TokenProvider, String, LocalUsageCounts)]
    ) throws {
        try counts.validate()
        guard counts.totalTokens > (prior?.counts.totalTokens ?? 0) else { return }
        let growth = counts.totalTokens - (prior?.counts.totalTokens ?? 0)
        let previous = prior?.counts ?? .zero
        var remaining = growth
        let input = min(max(0, counts.inputTokens - previous.inputTokens), remaining)
        remaining -= input
        let cached = min(max(0, counts.cachedTokens - previous.cachedTokens), remaining)
        remaining -= cached
        let output = min(max(0, counts.outputTokens - previous.outputTokens), remaining)
        maximums[key] = LocalUsageMaximum(
            counts: counts, occurredAt: min(prior?.occurredAt ?? occurredAt, occurredAt)
        )
        let delta = LocalUsageCounts(inputTokens: input, cachedTokens: cached, outputTokens: output)
        guard delta.totalTokens > 0 else { return }
        let deltaKey = Self.hash("local-fallback-delta:\(key):\(counts.totalTokens)")
        deltas.append((.codex, deltaKey, delta))
    }

    private func reconcile(
        key: String,
        counts: LocalUsageCounts,
        occurredAt: Date,
        provider: TokenProvider,
        prior: LocalUsageMaximum?,
        maximums: inout [String: LocalUsageMaximum],
        deltas: inout [(TokenProvider, String, LocalUsageCounts)]
    ) throws {
        try counts.validate()
        let maximum = (prior?.counts ?? .zero).componentwiseMaximum(with: counts)
        let delta = try maximum.subtracting(prior?.counts ?? .zero)
        maximums[key] = LocalUsageMaximum(
            counts: maximum, occurredAt: min(prior?.occurredAt ?? occurredAt, occurredAt)
        )
        if delta.totalTokens > 0 {
            let deltaKey = Self.hash(
                "local-delta:\(key):\(maximum.inputTokens):\(maximum.cachedTokens):\(maximum.outputTokens)"
            )
            deltas.append((provider, deltaKey, delta))
        }
    }

    private func observedTotals(_ cache: LocalUsageCache) throws -> [TokenProvider: Int] {
        var result: [TokenProvider: Int] = [:]
        for maximum in cache.claudeMaximums.values {
            result[.claude] = try safeAdd(result[.claude, default: 0], maximum.counts.totalTokens)
        }
        for maximum in cache.codexMaximums.values {
            result[.codex] = try safeAdd(result[.codex, default: 0], maximum.counts.totalTokens)
        }
        return result
    }

    private func observedWeeklyBreakdown(
        _ cache: LocalUsageCache,
        now: Date
    ) throws -> [TokenProvider: LocalUsageCounts] {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .current
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: now) else { return [:] }
        var result: [TokenProvider: LocalUsageCounts] = [:]
        for maximum in cache.claudeMaximums.values where interval.contains(maximum.occurredAt) {
            result[.claude] = try result[.claude, default: .zero].adding(maximum.counts)
        }
        for maximum in cache.codexMaximums.values where interval.contains(maximum.occurredAt) {
            result[.codex] = try result[.codex, default: .zero].adding(maximum.counts)
        }
        return result
    }

    private func readLines(
        _ url: URL,
        from offset: UInt64,
        through endOffset: UInt64,
        providerBytesRead: Int,
        discardingOversizedLine initialDiscardState: Bool,
        body: (Data) throws -> Void
    ) throws -> LineReadOutcome {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        var pending = Data()
        var consumed = offset
        var readOffset = offset
        var bytesRead = 0
        var discardingOversizedLine = initialDiscardState
        var stoppedAtSoftBoundary = false
        let hardLimit = providerBodyReadSoftBudget
            + Self.maximumLineSize + Self.readChunkSize
        while readOffset < endOffset {
            try Task.checkCancellation()
            if providerBytesRead + bytesRead >= providerBodyReadSoftBudget,
               pending.isEmpty || discardingOversizedLine {
                stoppedAtSoftBoundary = true
                break
            }
            let hardRemaining = hardLimit - providerBytesRead - bytesRead
            guard hardRemaining > 0 else {
                stoppedAtSoftBoundary = true
                break
            }
            let remaining = endOffset - readOffset
            let requestedCount = min(
                Self.readChunkSize, hardRemaining, Int(min(UInt64(Int.max), remaining))
            )
            guard let chunk = try handle.read(upToCount: requestedCount), !chunk.isEmpty else {
                break
            }
            let chunkStartOffset = readOffset
            readOffset += UInt64(chunk.count)
            let bytesBeforeChunk = bytesRead
            bytesRead += chunk.count
            var segmentStart = chunk.startIndex

            while segmentStart < chunk.endIndex {
                try Task.checkCancellation()
                let lineStartInChunk = chunk.distance(
                    from: chunk.startIndex, to: segmentStart
                )
                if !discardingOversizedLine, pending.isEmpty,
                   providerBytesRead + bytesBeforeChunk + lineStartInChunk
                    >= providerBodyReadSoftBudget {
                    stoppedAtSoftBoundary = true
                    break
                }
                let newline = chunk[segmentStart...].firstIndex(of: 0x0A)
                let segmentEnd = newline ?? chunk.endIndex
                let segment = chunk[segmentStart..<segmentEnd]

                if !discardingOversizedLine {
                    if pending.count <= Self.maximumLineSize - segment.count {
                        pending.append(contentsOf: segment)
                    } else {
                        // The record is too large to parse without retaining its raw content.
                        // Drop bytes until its newline, then resume with the next record.
                        pending.removeAll(keepingCapacity: false)
                        discardingOversizedLine = true
                    }
                }

                guard let newline else {
                    if discardingOversizedLine {
                        consumed = readOffset
                    }
                    break
                }
                if !discardingOversizedLine, !pending.isEmpty {
                    try autoreleasepool {
                        try body(pending)
                    }
                }
                pending.removeAll(keepingCapacity: false)
                discardingOversizedLine = false
                let bytesThroughNewline = chunk.distance(
                    from: chunk.startIndex, to: chunk.index(after: newline)
                )
                consumed = chunkStartOffset + UInt64(bytesThroughNewline)
                segmentStart = chunk.index(after: newline)
            }
            malloc_zone_pressure_relief(malloc_default_zone(), 0)
            if stoppedAtSoftBoundary { break }
        }
        let hasUnreadSnapshotBytes = consumed < endOffset
        let waitingForWriterTail = !discardingOversizedLine
            && !stoppedAtSoftBoundary
            && readOffset == endOffset
            && !pending.isEmpty
        return LineReadOutcome(
            consumedOffset: consumed,
            bytesRead: bytesRead,
            discardingOversizedLine: discardingOversizedLine,
            hasDrainableBacklog: hasUnreadSnapshotBytes
                && !waitingForWriterTail
                && (stoppedAtSoftBoundary || readOffset < endOffset),
            waitingForWriterTail: waitingForWriterTail
        )
    }

    private func contentPrefixHash(_ url: URL, byteCount: Int) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let prefix = try handle.read(upToCount: byteCount) ?? Data()
        return Self.hash(prefix.base64EncodedString())
    }

    private func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        return Self.dateParser.parse(value)
    }

    private func parseCodexTaskStart(_ value: NumberOrString?) -> Date? {
        switch value {
        case let .number(seconds):
            guard seconds.isFinite, seconds >= 0 else { return nil }
            return Date(timeIntervalSince1970: seconds)
        case let .string(string):
            if let seconds = Double(string), seconds.isFinite, seconds >= 0 {
                return Date(timeIntervalSince1970: seconds)
            }
            return parseDate(string)
        case nil:
            return nil
        }
    }

    private func boundedInt(
        _ field: NumberField,
        defaultValue: Int? = nil
    ) throws -> Int {
        let parsed: Int
        switch field {
        case .absent:
            guard let defaultValue else { throw CollectorError.invalidPayload }
            parsed = defaultValue
        case let .value(.number(number)):
            guard number.isFinite,
                  number >= 0,
                  number <= Double(CodexCheckpoint.maximumCumulativeTokens) else {
                throw CollectorError.invalidPayload
            }
            parsed = Int(number)
        case let .value(.string(string)):
            guard let value = Int(string) else { throw CollectorError.invalidPayload }
            parsed = value
        case .invalid:
            throw CollectorError.invalidPayload
        }
        guard parsed >= 0, parsed <= CodexCheckpoint.maximumCumulativeTokens else {
            throw CollectorError.invalidPayload
        }
        return parsed
    }

    private static func containsJSONType(_ data: Data, values: [Data]) -> Bool {
        var searchStart = data.startIndex
        while searchStart < data.endIndex,
              let keyRange = data.range(
                  of: jsonTypeKey, in: searchStart..<data.endIndex
              ) {
            var index = keyRange.upperBound
            while index < data.endIndex, isJSONWhitespace(data[index]) {
                data.formIndex(after: &index)
            }
            guard index < data.endIndex, data[index] == 0x3A else {
                searchStart = keyRange.upperBound
                continue
            }
            data.formIndex(after: &index)
            while index < data.endIndex, isJSONWhitespace(data[index]) {
                data.formIndex(after: &index)
            }
            if values.contains(where: { data[index...].starts(with: $0) }) {
                return true
            }
            searchStart = keyRange.upperBound
        }
        return false
    }

    private static func projectClaudeRecord(_ data: Data) -> Data {
        guard data.count >= 64 * 1024,
              let contentRange = data.range(of: jsonContentKey),
              let usageRange = data.range(of: jsonUsageKey, options: .backwards),
              contentRange.upperBound < usageRange.lowerBound,
              let valueStart = jsonValueStart(after: contentRange, in: data) else {
            return data
        }
        var projected = Data()
        projected.reserveCapacity(valueStart + 5 + data.distance(
            from: usageRange.lowerBound, to: data.endIndex
        ))
        projected.append(data[..<valueStart])
        projected.append(contentsOf: "null,".utf8)
        projected.append(data[usageRange.lowerBound...])
        return projected
    }

    private static func jsonValueStart(after keyRange: Range<Data.Index>, in data: Data) -> Data.Index? {
        var index = keyRange.upperBound
        while index < data.endIndex, isJSONWhitespace(data[index]) {
            data.formIndex(after: &index)
        }
        guard index < data.endIndex, data[index] == 0x3A else { return nil }
        data.formIndex(after: &index)
        while index < data.endIndex, isJSONWhitespace(data[index]) {
            data.formIndex(after: &index)
        }
        return index
    }

    private static func isJSONWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
    }

    private func safeAdd(_ lhs: Int, _ rhs: Int) throws -> Int {
        let result = lhs.addingReportingOverflow(rhs)
        guard !result.overflow else { throw CollectorError.invalidPayload }
        return result.partialValue
    }

    private static func events(
        provider: TokenProvider,
        sourceKey: String,
        counts: LocalUsageCounts,
        occurredAt: Date
    ) throws -> [TokenUsageEvent] {
        var input = counts.inputTokens
        var cached = counts.cachedTokens
        var output = counts.outputTokens
        var events: [TokenUsageEvent] = []
        var index = 0
        while input > 0 || cached > 0 || output > 0 {
            var remaining = TokenUsageEvent.maximumTokensPerEvent
            let inputChunk = min(input, remaining)
            input -= inputChunk
            remaining -= inputChunk
            let cachedChunk = min(cached, remaining)
            cached -= cachedChunk
            remaining -= cachedChunk
            let outputChunk = min(output, remaining)
            output -= outputChunk
            let event = TokenUsageEvent(
                id: UUID(), provider: provider,
                sourceEventID: "local:\(sourceKey):\(index)", occurredAt: occurredAt,
                inputTokens: inputChunk, cachedTokens: cachedChunk, outputTokens: outputChunk
            )
            try event.validate(now: occurredAt)
            events.append(event)
            index += 1
        }
        return events
    }

    static func hash(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        var encoded = [UInt8]()
        encoded.reserveCapacity(SHA256.byteCount * 2)
        for byte in digest {
            encoded.append(hexDigits[Int(byte >> 4)])
            encoded.append(hexDigits[Int(byte & 0x0F)])
        }
        return String(decoding: encoded, as: UTF8.self)
    }
}
