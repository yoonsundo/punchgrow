import Foundation

struct LocalUsageCounts: Codable, Equatable, Sendable {
    static let zero = LocalUsageCounts(inputTokens: 0, cachedTokens: 0, outputTokens: 0)

    let inputTokens: Int
    let cachedTokens: Int
    let outputTokens: Int

    var totalTokens: Int {
        inputTokens + cachedTokens + outputTokens
    }

    func componentwiseMaximum(with other: Self) -> Self {
        Self(
            inputTokens: max(inputTokens, other.inputTokens),
            cachedTokens: max(cachedTokens, other.cachedTokens),
            outputTokens: max(outputTokens, other.outputTokens)
        )
    }

    func subtracting(_ prior: Self) throws -> Self {
        let input = inputTokens.subtractingReportingOverflow(prior.inputTokens)
        let cached = cachedTokens.subtractingReportingOverflow(prior.cachedTokens)
        let output = outputTokens.subtractingReportingOverflow(prior.outputTokens)
        guard !input.overflow, !cached.overflow, !output.overflow,
              input.partialValue >= 0, cached.partialValue >= 0, output.partialValue >= 0 else {
            throw CollectorError.invalidPayload
        }
        return Self(
            inputTokens: input.partialValue,
            cachedTokens: cached.partialValue,
            outputTokens: output.partialValue
        )
    }

    func adding(_ other: Self) throws -> Self {
        let input = inputTokens.addingReportingOverflow(other.inputTokens)
        let cached = cachedTokens.addingReportingOverflow(other.cachedTokens)
        let output = outputTokens.addingReportingOverflow(other.outputTokens)
        guard !input.overflow, !cached.overflow, !output.overflow else {
            throw CollectorError.invalidPayload
        }
        return Self(
            inputTokens: input.partialValue,
            cachedTokens: cached.partialValue,
            outputTokens: output.partialValue
        )
    }

    func validate() throws {
        guard inputTokens >= 0, cachedTokens >= 0, outputTokens >= 0,
              inputTokens <= CodexCheckpoint.maximumCumulativeTokens,
              cachedTokens <= CodexCheckpoint.maximumCumulativeTokens,
              outputTokens <= CodexCheckpoint.maximumCumulativeTokens else {
            throw CollectorError.invalidPayload
        }
    }
}

struct LocalUsageFileCursor: Codable, Equatable, Sendable {
    var byteOffset: UInt64
    var fileSize: UInt64
    var contentPrefixHash: String?
    var contentPrefixByteCount: Int
    var lastModifiedAt: Date?
    var codexSessionKey: String?
    var codexTurnKey: String?
    var codexForkedAt: Date?
    var codexReplayBaseline: LocalUsageCounts?
    // Optional so schema v3 caches written before resumable oversized-line disposal
    // continue to decode without migration.
    var discardingOversizedLine: Bool?
}

struct LocalUsageMaximum: Codable, Equatable, Sendable {
    let counts: LocalUsageCounts
    let occurredAt: Date
}

struct ProviderQuotaSnapshot: Codable, Equatable, Sendable {
    let usedPercent: Double
    let resetsAt: Date?
    let observedAt: Date

    func validate() throws {
        guard usedPercent >= 0, usedPercent <= 100 else { throw CollectorError.invalidPayload }
    }
}

struct LocalUsageCache: Codable, Equatable, Sendable {
    static let schemaVersion = 3
    private static let maximumTrackedFiles = 100_000
    private static let maximumTrackedClaudeRequests = 250_000
    private static let maximumTrackedCodexFrames = 500_000

    var schemaVersion = Self.schemaVersion
    var baselineCompleted = false
    // Optional for backward-compatible decoding of caches written before provider isolation.
    var baselineCompletedProviders: [TokenProvider]?
    // Opaque provider-local rotation markers. Optional for backward-compatible decode.
    var resumeAfterFileKeys: [TokenProvider: String]?
    var files: [String: LocalUsageFileCursor] = [:]
    var claudeMaximums: [String: LocalUsageMaximum] = [:]
    var codexMaximums: [String: LocalUsageMaximum] = [:]
    var quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot]?

    func validate() throws {
        guard schemaVersion == Self.schemaVersion,
              files.count <= Self.maximumTrackedFiles,
              claudeMaximums.count <= Self.maximumTrackedClaudeRequests,
              codexMaximums.count <= Self.maximumTrackedCodexFrames,
              baselineCompletedProviders.map({ providers in
                  providers.count <= 2
                      && providers.allSatisfy { $0 == .claude || $0 == .codex }
                      && providers.filter { $0 == .claude }.count <= 1
                      && providers.filter { $0 == .codex }.count <= 1
              }) ?? true,
              resumeAfterFileKeys.map({ markers in
                  markers.count <= 2
                      && markers.allSatisfy { provider, key in
                          (provider == .claude || provider == .codex) && Self.isOpaqueKey(key)
                      }
              }) ?? true,
              files.allSatisfy({ key, cursor in
                  Self.isOpaqueKey(key) && cursor.byteOffset <= cursor.fileSize
                      && (cursor.contentPrefixHash.map(Self.isOpaqueKey) ?? true)
                      && cursor.contentPrefixByteCount >= 0
                      && cursor.contentPrefixByteCount <= 4_096
                      && UInt64(cursor.contentPrefixByteCount) <= cursor.fileSize
                      && (cursor.codexSessionKey.map(Self.isOpaqueKey) ?? true)
                      && (cursor.codexTurnKey.map(Self.isOpaqueKey) ?? true)
              }),
              claudeMaximums.allSatisfy({ Self.isOpaqueKey($0.key) }),
              codexMaximums.allSatisfy({ Self.isOpaqueKey($0.key) }) else {
            throw CollectorError.invalidPayload
        }
        try claudeMaximums.values.forEach { try $0.counts.validate() }
        try codexMaximums.values.forEach { try $0.counts.validate() }
        try quotaSnapshots?.values.forEach { try $0.validate() }
        try files.values.compactMap(\.codexReplayBaseline).forEach { try $0.validate() }
    }

    private static func isOpaqueKey(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

struct LocalUsageScanResult: Sendable {
    let cache: LocalUsageCache
    let observedTotals: [TokenProvider: Int]
    let observedWeeklyTotals: [TokenProvider: Int]
    let observedWeeklyBreakdown: [TokenProvider: LocalUsageCounts]
    let quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot]
    let creditEvents: [TokenUsageEvent]
    let successfulProviders: [TokenProvider]
    let failedProviders: [TokenProvider]
    let hasDrainableBacklog: Bool
}
