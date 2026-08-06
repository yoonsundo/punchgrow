import Combine
import Foundation

enum TokenIngestionResult: Equatable {
    case credited
    case duplicate
    case failed

    static let persistenceFailureMessage = "사용량을 안전하게 저장하지 못했습니다. Data & Settings에서 저장 상태를 확인해 주세요."
}

@MainActor
final class GameStore: ObservableObject {
    @Published private(set) var state: GameState
    @Published private(set) var catalog: [CreatureSpecies]
    @Published private(set) var currentCreatureID: UUID?
    @Published var errorMessage: String?
    @Published private(set) var evolutionFeedback: EvolutionFeedback?
    @Published private(set) var observedLocalUsage: [TokenProvider: Int] = [:]
    @Published private(set) var observedLocalWeeklyUsage: [TokenProvider: Int] = [:]
    @Published private(set) var observedLocalWeeklyBreakdown: [TokenProvider: LocalUsageCounts] = [:]
    @Published private(set) var observedQuotaSnapshots: [TokenProvider: ProviderQuotaSnapshot] = [:]

    private let persistence: GamePersistence
    private let now: () -> Date
    private let onCreditedEvent: (TokenProvider, Date, Int) -> Void
    private var persistenceLocked = false

    init(
        persistence: GamePersistence = GamePersistence(),
        catalog catalogOverride: [CreatureSpecies]? = nil,
        now: @escaping () -> Date = { .now },
        onCreditedEvent: @escaping (TokenProvider, Date, Int) -> Void = { _, _, _ in }
    ) {
        self.persistence = persistence
        self.now = now
        self.onCreditedEvent = onCreditedEvent
        var startupErrors: [String] = []
        if let catalogOverride {
            self.catalog = catalogOverride
        } else {
            do {
                self.catalog = try CreatureCatalog.load()
            } catch {
                self.catalog = []
                startupErrors.append("카탈로그 로드 실패: \(error.localizedDescription)")
            }
        }
        do {
            self.state = try persistence.load()
            try self.state.validate(catalogIDs: Set(self.catalog.map(\.id)))
            if try persistence.requiresMigrationCommit() { try persistence.save(self.state) }
        } catch {
            self.state = GameState()
            self.persistenceLocked = true
            startupErrors.append("저장 데이터를 읽지 못했습니다. 원본 파일은 덮어쓰지 않습니다. Data & Settings에서 백업을 복원해 주세요.")
        }
        self.currentCreatureID = Self.initialCurrentCreatureID(in: state, catalog: catalog)
        self.errorMessage = startupErrors.isEmpty ? nil : startupErrors.joined(separator: "\n")
    }

    var currentCreature: OwnedCreature? {
        guard let id = resolvedCurrentCreatureID else { return nil }
        return state.ownedCreatures.first(where: { $0.id == id })
    }

    var currentSpecies: CreatureSpecies? {
        guard let currentCreature else { return nil }
        return catalog.first(where: { $0.id == currentCreature.speciesID })
    }

    var representativeCreature: OwnedCreature? {
        guard let id = resolvedRepresentativeCreatureID else { return nil }
        return state.ownedCreatures.first(where: { $0.id == id })
    }

    var currentCreatureIndex: Int? {
        guard let id = resolvedCurrentCreatureID else { return nil }
        return visibleOwnedCreatures.firstIndex(where: { $0.id == id })
    }

    var currentCreatureCount: Int { visibleOwnedCreatures.count }
    var currentCreaturePosition: Int? { currentCreatureIndex.map { $0 + 1 } }
    var canNavigateCreatures: Bool { currentCreatureCount > 1 }

    private var visibleOwnedCreatures: [OwnedCreature] {
        GameEngine.visibleOwnedCreatures(in: state, catalog: catalog)
    }

    private var resolvedCurrentCreatureID: UUID? {
        if let currentCreatureID {
            if visibleOwnedCreatures.contains(where: { $0.id == currentCreatureID }) {
                return currentCreatureID
            }
            if let resolved = visibleCreatureID(forOwnedCreatureID: currentCreatureID) {
                return resolved
            }
        }
        return Self.initialCurrentCreatureID(in: state, catalog: catalog)
    }

    private var resolvedRepresentativeCreatureID: UUID? {
        guard let representativeCreatureID = state.representativeCreatureID else { return nil }
        if visibleOwnedCreatures.contains(where: { $0.id == representativeCreatureID }) {
            return representativeCreatureID
        }
        return visibleCreatureID(forOwnedCreatureID: representativeCreatureID)
    }

    private func visibleCreatureID(forOwnedCreatureID id: UUID) -> UUID? {
        guard let owned = state.ownedCreatures.first(where: { $0.id == id }) else { return nil }
        let origin = GameEngine.originSpeciesID(for: owned, catalog: catalog)
        return visibleOwnedCreatures.first {
            GameEngine.originSpeciesID(for: $0, catalog: catalog) == origin
        }?.id
    }

    @discardableResult
    func pull() -> OwnedCreature? {
        guard !persistenceLocked else { return nil }
        guard let creature: OwnedCreature = performMutation({ state in
            var generator = SystemRandomNumberGenerator()
            return try GameEngine.pull(state: &state, catalog: catalog, generator: &generator)
        }) else { return nil }
        let originSpeciesID = GameEngine.originSpeciesID(for: creature, catalog: catalog)
        currentCreatureID = visibleOwnedCreatures.first {
            GameEngine.originSpeciesID(for: $0, catalog: catalog) == originSpeciesID
        }?.id
        return creature
    }

    func feedCurrent() {
        guard !persistenceLocked else { return }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let evolutions = performMutation({ state in
            try GameEngine.feed(creatureID: creatureID, state: &state, catalog: catalog)
        }) else { return }
        publishEvolutionFeedback(evolutions)
    }

    func purchaseFood() {
        guard !persistenceLocked else { return }
        performMutation { state in try GameEngine.purchaseFood(state: &state) }
    }

    func feedLargeCurrent() {
        guard !persistenceLocked else { return }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let evolutions = performMutation({ state in
            try GameEngine.feedLarge(creatureID: creatureID, state: &state, catalog: catalog)
        }) else { return }
        publishEvolutionFeedback(evolutions)
    }

    func purchaseLargeFood() {
        guard !persistenceLocked else { return }
        performMutation { state in try GameEngine.purchaseLargeFood(state: &state) }
    }

    func selectPreviousCreature() { moveCurrent(by: -1) }
    func selectNextCreature() { moveCurrent(by: 1) }

    func setCurrentAsRepresentative() {
        guard let creatureID = resolvedCurrentCreatureID else { return }
        performMutation { state in state.representativeCreatureID = creatureID }
    }

    func addDemoUsage() {
#if DEBUG
        guard !persistenceLocked else { return }
        let event = TokenUsageEvent(
            id: UUID(), provider: .claude, sourceEventID: UUID().uuidString,
            occurredAt: .now, inputTokens: 42_000, cachedTokens: 12_000, outputTokens: 8_000
        )
        performMutation { state in try GameEngine.ingest(event, into: &state) }
#endif
    }

    func updateObservedLocalUsage(
        total: [TokenProvider: Int],
        weekly: [TokenProvider: Int],
        weeklyBreakdown: [TokenProvider: LocalUsageCounts],
        quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot]
    ) {
        observedLocalUsage = total
        observedLocalWeeklyUsage = weekly
        observedLocalWeeklyBreakdown = weeklyBreakdown
        observedQuotaSnapshots = quotaSnapshots
    }

    @discardableResult
    func ingestCollectedEvents(_ events: [TokenUsageEvent]) -> TokenIngestionResult {
        guard !persistenceLocked else {
            errorMessage = TokenIngestionResult.persistenceFailureMessage
            return .failed
        }
        let credited: [(TokenProvider, Date, Int)]? = performMutation { state in
            var credited: [(TokenProvider, Date, Int)] = []
            for event in events {
                do {
                    let creditedAt = now()
                    try GameEngine.ingest(event, into: &state, now: creditedAt)
                    credited.append((event.provider, creditedAt, event.totalTokens))
                } catch GameError.duplicateUsageEvent {
                    continue
                }
            }
            return credited
        }
        guard let credited else {
            errorMessage = TokenIngestionResult.persistenceFailureMessage
            return .failed
        }
        credited.forEach { onCreditedEvent($0.0, $0.1, $0.2) }
        return credited.isEmpty ? .duplicate : .credited
    }

    @discardableResult
    func ingestCodexSnapshot(_ snapshot: CodexTokenSnapshot) -> TokenIngestionResult {
        guard !persistenceLocked else {
            errorMessage = TokenIngestionResult.persistenceFailureMessage
            return .failed
        }
        let credited: (Date, Int)? = performMutation { state in
            let before = state.lifetimeUsage[.codex, default: 0]
            let creditedAt = now()
            try GameEngine.ingestCodexSnapshot(snapshot, into: &state, now: creditedAt)
            let amount = state.lifetimeUsage[.codex, default: 0] - before
            return (creditedAt, amount)
        }
        guard let credited else {
            errorMessage = TokenIngestionResult.persistenceFailureMessage
            return .failed
        }
        if credited.1 > 0 {
            onCreditedEvent(.codex, credited.0, credited.1)
            return .credited
        }
        return .duplicate
    }

    func exportBackup(to url: URL) {
        do {
            try persistence.export(state, to: url)
            if !persistenceLocked { errorMessage = nil }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func restoreBackup(from url: URL) {
        do {
            let restored = try persistence.restore(from: url)
            try restored.validate(catalogIDs: Set(catalog.map(\.id)))
            try persistence.save(restored)
            state = restored
            currentCreatureID = Self.initialCurrentCreatureID(in: restored, catalog: catalog)
            persistenceLocked = false
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearEvolutionFeedback(id: UUID) {
        guard evolutionFeedback?.id == id else { return }
        evolutionFeedback = nil
    }

    @discardableResult
    private func performMutation<Result>(_ mutation: (inout GameState) throws -> Result) -> Result? {
        guard !persistenceLocked else { return nil }
        do {
            var next = state
            let result = try mutation(&next)
            try persistence.save(next)
            state = next
            reconcileCurrentCreature()
            errorMessage = nil
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func moveCurrent(by offset: Int) {
        let creatures = visibleOwnedCreatures
        guard creatures.count > 1, let currentID = resolvedCurrentCreatureID,
              let index = creatures.firstIndex(where: { $0.id == currentID }) else { return }
        currentCreatureID = creatures[(index + offset + creatures.count) % creatures.count].id
    }

    private func reconcileCurrentCreature() {
        currentCreatureID = resolvedCurrentCreatureID
    }

    private func publishEvolutionFeedback(_ evolutions: [EvolutionResult]) {
        guard let first = evolutions.first,
              let last = evolutions.last,
              let from = catalog.first(where: { $0.id == first.fromSpeciesID }),
              let to = catalog.first(where: { $0.id == last.toSpeciesID })
        else { return }
        evolutionFeedback = EvolutionFeedback(
            id: UUID(),
            creatureID: first.creatureID,
            fromSpeciesID: from.id,
            toSpeciesID: to.id,
            fromName: from.koName,
            toName: to.koName,
            rarity: to.rarity,
            stagesCrossed: evolutions.count
        )
    }

    private static func initialCurrentCreatureID(
        in state: GameState,
        catalog: [CreatureSpecies]
    ) -> UUID? {
        let visibleCreatures = GameEngine.visibleOwnedCreatures(in: state, catalog: catalog)
        if let representativeID = state.representativeCreatureID {
            if visibleCreatures.contains(where: { $0.id == representativeID }) {
                return representativeID
            }
            if let representative = state.ownedCreatures.first(where: { $0.id == representativeID }) {
                let origin = GameEngine.originSpeciesID(for: representative, catalog: catalog)
                if let resolved = visibleCreatures.first(where: {
                    GameEngine.originSpeciesID(for: $0, catalog: catalog) == origin
                }) {
                    return resolved.id
                }
            }
        }
        return visibleCreatures.first?.id
    }
}
