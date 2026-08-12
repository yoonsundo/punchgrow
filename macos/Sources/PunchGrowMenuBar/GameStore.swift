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
    static let persistenceLockedActionMessage =
        "저장이 잠겨 있어 진화 선택을 적용할 수 없습니다. Data & Settings에서 백업을 복원해 주세요."

    @Published private(set) var state: GameState
    @Published private(set) var catalog: [CreatureSpecies]
    @Published private(set) var currentCreatureID: UUID?
    @Published var errorMessage: String?
    @Published private(set) var evolutionFeedback: EvolutionFeedback?
    @Published private(set) var grantFeedback: CreatureGrantFeedback?
    /// 세션 한정. 저장하지 않으므로 앱을 다시 켜면 같은 지점에서 다시 판정된다.
    @Published private(set) var pendingMutationOffer: PendingMutationOffer?
    @Published private(set) var observedLocalUsage: [TokenProvider: Int] = [:]
    @Published private(set) var observedLocalWeeklyUsage: [TokenProvider: Int] = [:]
    @Published private(set) var observedLocalWeeklyBreakdown: [TokenProvider: LocalUsageCounts] = [:]
    @Published private(set) var observedQuotaSnapshots: [TokenProvider: ProviderQuotaSnapshot] = [:]
    /// 뷰가 버튼을 비활성화하고 사유를 표시할 수 있도록 잠금 상태를 공개한다.
    @Published private(set) var isPersistenceLocked = false

    private let persistence: GamePersistence
    private let now: () -> Date
    private let onCreditedEvent: (TokenProvider, Date, Int) -> Void
    /// 확률 판정에 쓰는 유일한 난수원. 한 번 만들어 계속 이어 쓰므로 테스트가
    /// `SeededGenerator`를 주입하면 호출 순서 전체가 결정론적으로 재현된다.
    private var generator: AnyRandomNumberGenerator

    init(
        persistence: GamePersistence = GamePersistence(),
        catalog catalogOverride: [CreatureSpecies]? = nil,
        now: @escaping () -> Date = { .now },
        onCreditedEvent: @escaping (TokenProvider, Date, Int) -> Void = { _, _, _ in },
        makeGenerator: () -> any RandomNumberGenerator = { SystemRandomNumberGenerator() }
    ) {
        self.persistence = persistence
        self.now = now
        self.onCreditedEvent = onCreditedEvent
        self.generator = AnyRandomNumberGenerator(makeGenerator())
        var startupErrors: [String] = []
        // @Published 프로퍼티는 모든 저장 프로퍼티가 초기화된 뒤에야 대입할 수 있어
        // 지역 변수로 받아 두었다가 init 마지막에 옮긴다.
        var locked = false
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
            locked = true
            startupErrors.append("저장 데이터를 읽지 못했습니다. 원본 파일은 덮어쓰지 않습니다. Data & Settings에서 백업을 복원해 주세요.")
        }
        self.currentCreatureID = Self.initialCurrentCreatureID(in: state, catalog: catalog)
        self.errorMessage = startupErrors.isEmpty ? nil : startupErrors.joined(separator: "\n")
        self.isPersistenceLocked = locked
    }

    var currentCreature: OwnedCreature? {
        guard let id = resolvedCurrentCreatureID else { return nil }
        return state.ownedCreatures.first(where: { $0.id == id })
    }

    var currentSpecies: CreatureSpecies? {
        guard let currentCreature else { return nil }
        return catalog.first(where: { $0.id == currentCreature.speciesID })
    }

    /// 화면에 그릴 현재 개체의 모습. 고정해 둔 모습이 있으면 그것을 쓴다.
    var currentDisplaySpecies: CreatureSpecies? {
        guard let currentCreature else { return nil }
        return GameEngine.displaySpecies(for: currentCreature, catalog: catalog)
    }

    var representativeCreature: OwnedCreature? {
        guard let id = resolvedRepresentativeCreatureID else { return nil }
        return state.ownedCreatures.first(where: { $0.id == id })
    }

    var currentCreatureIndex: Int? {
        guard let id = resolvedCurrentCreatureID else { return nil }
        return visibleGroupIndex(forOwnedCreatureID: id)
    }

    var currentCreatureCount: Int { visibleOwnedCreatures.count }
    var currentCreaturePosition: Int? { currentCreatureIndex.map { $0 + 1 } }
    var canNavigateCreatures: Bool { currentCreatureCount > 1 }

    var groupMemberPosition: Int? {
        guard let id = resolvedCurrentCreatureID,
              let index = currentOriginGroup.firstIndex(where: { $0.id == id }) else { return nil }
        return index + 1
    }

    var pendingEvolutionChoice: PendingEvolutionChoice? {
        guard let currentCreature else { return nil }
        return GameEngine.pendingEvolutionChoice(for: currentCreature, catalog: catalog)
    }

    var pendingEvolutionChoices: [PendingEvolutionChoice] {
        state.ownedCreatures.compactMap {
            GameEngine.pendingEvolutionChoice(for: $0, catalog: catalog)
        }
    }

    private var visibleOwnedCreatures: [OwnedCreature] {
        GameEngine.visibleOwnedCreatures(in: state, catalog: catalog)
    }

    private var currentOriginGroup: [OwnedCreature] {
        guard let id = resolvedCurrentCreatureID else { return [] }
        return GameEngine.ownedCreatures(inOriginGroupOf: id, state: state, catalog: catalog)
    }

    private var resolvedCurrentCreatureID: UUID? {
        if let currentCreatureID,
           state.ownedCreatures.contains(where: { $0.id == currentCreatureID }) {
            return currentCreatureID
        }
        return Self.initialCurrentCreatureID(in: state, catalog: catalog)
    }

    private var resolvedRepresentativeCreatureID: UUID? {
        guard let representativeCreatureID = state.representativeCreatureID,
              state.ownedCreatures.contains(where: { $0.id == representativeCreatureID })
        else { return nil }
        return representativeCreatureID
    }

    private func visibleGroupIndex(forOwnedCreatureID id: UUID) -> Int? {
        guard let owned = state.ownedCreatures.first(where: { $0.id == id }) else { return nil }
        let origin = GameEngine.originSpeciesID(for: owned, catalog: catalog)
        return visibleOwnedCreatures.firstIndex {
            GameEngine.originSpeciesID(for: $0, catalog: catalog) == origin
        }
    }

    @discardableResult
    func pull() -> OwnedCreature? {
        guard !isPersistenceLocked else { return nil }
        guard let creature: OwnedCreature = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.pull(state: &state, catalog: self.catalog, generator: &generator)
            }
        }) else { return nil }
        currentCreatureID = creature.id
        return creature
    }

    func feedCurrent() {
        guard !isPersistenceLocked else { return }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let outcome = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.feed(
                    creatureID: creatureID, state: &state, catalog: self.catalog,
                    generator: &generator,
                    deferringEvolution: self.pendingMutationOffer?.creatureID == creatureID)
            }
        }) else { return }
        apply(outcome)
    }

    func purchaseFood() {
        guard !isPersistenceLocked else { return }
        performMutation { state in try GameEngine.purchaseFood(state: &state) }
    }

    func feedLargeCurrent() {
        guard !isPersistenceLocked else { return }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let outcome = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.feedLarge(
                    creatureID: creatureID, state: &state, catalog: self.catalog,
                    generator: &generator,
                    deferringEvolution: self.pendingMutationOffer?.creatureID == creatureID)
            }
        }) else { return }
        apply(outcome)
    }

    func purchaseLargeFood() {
        guard !isPersistenceLocked else { return }
        performMutation { state in try GameEngine.purchaseLargeFood(state: &state) }
    }

    /// 대기 배지에서 해당 개체로 포커스를 옮긴다. 대기 개체가 지금 보고 있는 개체가
    /// 아닐 수 있으므로 선택 시트를 열기 전에 먼저 부른다.
    func focusCreature(id: UUID) {
        guard state.ownedCreatures.contains(where: { $0.id == id }) else { return }
        currentCreatureID = id
    }

    func chooseEvolutionCurrent(toSpeciesID speciesID: String) {
        guard let creatureID = resolvedCurrentCreatureID else { return }
        chooseEvolution(creatureID: creatureID, toSpeciesID: speciesID)
    }

    func chooseEvolution(creatureID: UUID, toSpeciesID speciesID: String) {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let outcome = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.chooseEvolution(
                    creatureID: creatureID, toSpeciesID: speciesID, state: &state,
                    catalog: self.catalog, generator: &generator)
            }
        }) else { return }
        apply(outcome)
    }

    func resolveMutationOfferCurrent(accept: Bool) {
        guard let creatureID = resolvedCurrentCreatureID else { return }
        resolveMutationOffer(creatureID: creatureID, accept: accept)
    }

    func resolveMutationOffer(creatureID: UUID, accept: Bool) {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let offer = pendingMutationOffer, offer.creatureID == creatureID else { return }
        guard let evolutions = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.resolveMutationOffer(
                    offer, accept: accept, state: &state, catalog: self.catalog,
                    generator: &generator)
            }
        }) else { return }
        pendingMutationOffer = nil
        publishEvolutionFeedback(evolutions)
    }

    /// 지나친 변이를 토큰으로 다시 노린다. 성공·실패 모두 토큰을 쓰므로 어느 쪽이든 저장한다.
    func retryMutationCurrent() {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let outcome = performMutation({ state in
            try self.advancingGenerator { generator in
                try GameEngine.retryMutation(
                    fromCreatureID: creatureID, state: &state, catalog: self.catalog,
                    generator: &generator, now: self.now())
            }
        }) else { return }
        grantFeedback = CreatureGrantFeedback(
            id: UUID(),
            kind: .mutationRetry,
            succeeded: outcome.succeeded,
            grantedSpeciesID: outcome.creatureID
                .flatMap { id in state.ownedCreatures.first { $0.id == id }?.speciesID },
            tokensSpent: outcome.tokensSpent,
            failureCount: outcome.failureCount
        )
    }

    func inheritCurrent() {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        guard let offspring = performMutation({ state in
            try GameEngine.inherit(
                fromCreatureID: creatureID, state: &state, catalog: self.catalog, now: self.now())
        }) else { return }
        grantFeedback = CreatureGrantFeedback(
            id: UUID(),
            kind: .inheritance,
            // 계승은 확률 판정이 없어 반환되었다는 사실 자체가 성공이다.
            succeeded: true,
            grantedSpeciesID: offspring.speciesID,
            tokensSpent: GameState.inheritCost,
            failureCount: 0
        )
    }


    /// 도감에서 고른 모습을 현재 개체의 표시 모습으로 고정한다. 실제 종과 성장은 그대로다.
    func setDisplayForm(toSpeciesID speciesID: String) {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        performMutation { state in
            try GameEngine.setDisplayForm(
                creatureID: creatureID, toSpeciesID: speciesID, state: &state,
                catalog: self.catalog)
        }
    }

    func clearDisplayForm() {
        guard !isPersistenceLocked else {
            errorMessage = Self.persistenceLockedActionMessage
            return
        }
        guard let creatureID = resolvedCurrentCreatureID else { return }
        performMutation { state in
            try GameEngine.clearDisplayForm(creatureID: creatureID, state: &state)
        }
    }

    func selectPreviousCreature() { moveCurrent(by: -1) }
    func selectNextCreature() { moveCurrent(by: 1) }

    func selectPreviousInGroup() { moveWithinGroup(by: -1) }
    func selectNextInGroup() { moveWithinGroup(by: 1) }

    func setCurrentAsRepresentative() {
        guard let creatureID = resolvedCurrentCreatureID else { return }
        performMutation { state in state.representativeCreatureID = creatureID }
    }

    func addDemoUsage() {
#if DEBUG
        guard !isPersistenceLocked else { return }
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
        guard !isPersistenceLocked else {
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
        guard !isPersistenceLocked else {
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
            if !isPersistenceLocked { errorMessage = nil }
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
            pendingMutationOffer = nil
            isPersistenceLocked = false
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearEvolutionFeedback(id: UUID) {
        guard evolutionFeedback?.id == id else { return }
        evolutionFeedback = nil
    }

    func clearGrantFeedback(id: UUID) {
        guard grantFeedback?.id == id else { return }
        grantFeedback = nil
    }

    @discardableResult
    private func performMutation<Result>(_ mutation: (inout GameState) throws -> Result) -> Result? {
        guard !isPersistenceLocked else { return nil }
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
              let index = visibleGroupIndex(forOwnedCreatureID: currentID) else { return }
        currentCreatureID = creatures[(index + offset + creatures.count) % creatures.count].id
    }

    private func moveWithinGroup(by offset: Int) {
        let group = currentOriginGroup
        guard group.count > 1, let currentID = resolvedCurrentCreatureID,
              let index = group.firstIndex(where: { $0.id == currentID }) else { return }
        currentCreatureID = group[(index + offset + group.count) % group.count].id
    }

    private func reconcileCurrentCreature() {
        currentCreatureID = resolvedCurrentCreatureID
        // 개체가 사라졌거나 이미 다른 종이 됐으면 오퍼는 더 이상 성립하지 않는다.
        if let offer = pendingMutationOffer,
           state.ownedCreatures.first(where: { $0.id == offer.creatureID })?.speciesID
               != offer.fromSpeciesID {
            pendingMutationOffer = nil
        }
    }

    private func apply(_ outcome: FeedOutcome) {
        if let offer = outcome.mutationOffer { pendingMutationOffer = offer }
        publishEvolutionFeedback(outcome.evolutions)
    }

    /// 난수원을 꺼내 쓰고 진행된 상태를 되돌려 놓는다. 클래스 프로퍼티를 직접
    /// `inout`으로 넘기지 않아 중첩 호출에서도 배타 접근 문제가 생기지 않는다.
    private func advancingGenerator<Result>(
        _ body: (inout AnyRandomNumberGenerator) throws -> Result
    ) rethrows -> Result {
        var local = generator
        defer { generator = local }
        return try body(&local)
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
        if let representativeID = state.representativeCreatureID,
           state.ownedCreatures.contains(where: { $0.id == representativeID }) {
            return representativeID
        }
        return GameEngine.visibleOwnedCreatures(in: state, catalog: catalog).first?.id
    }
}
