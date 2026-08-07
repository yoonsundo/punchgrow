import Foundation

struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed == 0 ? 0x9E3779B97F4A7C15 : seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58476D1CE4E5B9
        value = (value ^ (value >> 27)) &* 0x94D049BB133111EB
        return value ^ (value >> 31)
    }
}

/// 주입된 난수원을 값 타입으로 감싸 `inout some RandomNumberGenerator` 자리에 넘길 수 있게 한다.
/// 실존 타입(`any RandomNumberGenerator`)은 그대로는 `inout` 제네릭 인자로 열리지 않는다.
struct AnyRandomNumberGenerator: RandomNumberGenerator {
    private var base: any RandomNumberGenerator

    init(_ base: any RandomNumberGenerator) { self.base = base }

    mutating func next() -> UInt64 { base.next() }
}

enum EvolutionCatalog {
    static let mutantCategory = "mutant"

    private static let categoryPriority = [
        "normal_evolution": 0, "branch": 1, "mixed": 2, "special": 3, "mutant": 4,
    ]

    static func candidates(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        let lineageReference = "\(current.lineageId):S\(current.stage)"
        return catalog
            .filter {
                $0.stage == current.stage + 1
                    && ($0.evolutionFrom.contains(current.id)
                        || (!current.lineageId.isEmpty
                            && $0.evolutionFrom.contains(lineageReference)))
            }
            .sorted {
                let left = categoryPriority[$0.category, default: Int.max]
                let right = categoryPriority[$1.category, default: Int.max]
                return left == right ? $0.id < $1.id : left < right
            }
    }

    static func selectableCandidates(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        candidates(after: current, in: catalog).filter { $0.category != mutantCategory }
    }

    static func mutationCandidate(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> CreatureSpecies? {
        candidates(after: current, in: catalog).first { $0.category == mutantCategory }
    }

    static func parents(
        of candidate: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        catalog
            .filter { parent in
                guard parent.stage == candidate.stage - 1 else { return false }
                let lineageReference = "\(parent.lineageId):S\(parent.stage)"
                return candidate.evolutionFrom.contains(parent.id)
                    || (!parent.lineageId.isEmpty
                        && candidate.evolutionFrom.contains(lineageReference))
            }
            .sorted { $0.id < $1.id }
    }

    /// 매 단계에서 **기본 후보(카테고리 우선순위 첫 번째)** 만 따라간 경로.
    /// 진화가 선택제가 된 뒤로 이 경로는 사용자가 실제로 걷는 길이 아니므로
    /// 표시 계층에서 호출하지 않는다. 잠재력·등급 안내는 `maxReachablePath`를 쓴다.
    static func automaticPath(
        from start: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        var path = [start]
        var current = start
        var visited: Set<String> = [start.id]

        while let next = candidates(after: current, in: catalog).first,
              visited.insert(next.id).inserted {
            path.append(next)
            current = next
        }
        return path
    }

    /// 선택 가능한 후손(변이 제외)만 따라갔을 때 닿을 수 있는 가장 높은 등급까지의 대표 경로.
    /// 진화가 선택제가 된 뒤로 "잠재력"은 규칙이 정해 주는 하나의 경로가 아니라 **사용자가
    /// 최선을 골랐을 때의 상한**이므로, 자동 경로가 아니라 도달 가능 집합에서 구한다.
    /// 변이는 확률로만 만나므로 상한 계산에서 제외한다(`selectableCandidates`).
    /// 같은 등급이 여러 곳에 있으면 더 짧은 경로 → id 사전순으로 하나를 고른다.
    static func maxReachablePath(
        from start: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        var speciesByID: [String: CreatureSpecies] = [start.id: start]
        var parentIDs: [String: String] = [:]
        var visited: Set<String> = [start.id]
        var frontier = [start]
        var best = start

        while !frontier.isEmpty {
            var next: [CreatureSpecies] = []
            for current in frontier {
                for candidate in selectableCandidates(after: current, in: catalog)
                where visited.insert(candidate.id).inserted {
                    parentIDs[candidate.id] = current.id
                    speciesByID[candidate.id] = candidate
                    next.append(candidate)
                }
            }
            next.sort { $0.id < $1.id }
            for candidate in next where rarityRank(candidate.rarity) > rarityRank(best.rarity) {
                best = candidate
            }
            frontier = next
        }

        var reversedPath = [best]
        var cursor = best.id
        while let parentID = parentIDs[cursor], let parent = speciesByID[parentID] {
            reversedPath.append(parent)
            cursor = parentID
        }
        return reversedPath.reversed()
    }

    /// 최대 도달 등급. 확률로만 닿는 변이 등급은 포함하지 않는다.
    static func maxReachableRarity(
        from start: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> String {
        maxReachablePath(from: start, in: catalog).last?.rarity ?? start.rarity
    }

    /// 매 분기에서 가장 낮은 쪽을 골라도 경로상 반드시 도달하는 등급(하한).
    /// 상한만 보여 주면 낙관 편향이 생기므로 화면에서 상한과 함께 든다.
    static func minGuaranteedRarity(
        from start: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> String {
        var memo: [String: Int] = [:]
        let rank = minGuaranteedRank(from: start, in: catalog, memo: &memo)
        return RarityVisualTier(rawValue: rank)?.label ?? start.rarity
    }

    /// 진화는 `stage`가 반드시 1씩 오르므로 순환이 없다. 다이아몬드(부모 2)만 겹치므로
    /// 메모만으로 충분하다.
    private static func minGuaranteedRank(
        from species: CreatureSpecies,
        in catalog: [CreatureSpecies],
        memo: inout [String: Int]
    ) -> Int {
        if let cached = memo[species.id] { return cached }
        let ownRank = rarityRank(species.rarity)
        let worstBranch = selectableCandidates(after: species, in: catalog)
            .map { minGuaranteedRank(from: $0, in: catalog, memo: &memo) }
            .min()
        let rank = worstBranch.map { max(ownRank, $0) } ?? ownRank
        memo[species.id] = rank
        return rank
    }

    /// 등급 서열의 단일 출처는 `RarityVisualTier`다. 순서를 여기서 다시 적으면
    /// 표시와 계산이 조용히 갈라진다.
    private static func rarityRank(_ rarity: String) -> Int {
        RarityVisualTier(rarity: rarity).rawValue
    }

    static func requiredLevel(for stage: Int) -> Int? {
        switch stage {
        case 2: 15
        case 3: 25
        case 4: 40
        default: nil
        }
    }
}

enum GameEngine {
    private struct OriginResolver {
        private let speciesByID: [String: CreatureSpecies]
        private let speciesIDsByLineageStage: [String: [String]]
        private var rootsBySpeciesID: [String: Set<String>] = [:]

        init(catalog: [CreatureSpecies]) {
            self.speciesByID = Dictionary(
                catalog.map { ($0.id, $0) },
                uniquingKeysWith: { first, _ in first }
            )
            self.speciesIDsByLineageStage = Dictionary(grouping: catalog, by: {
                "\($0.lineageId):S\($0.stage)"
            }).mapValues { $0.map(\.id).sorted() }
        }

        mutating func originSpeciesID(for creature: OwnedCreature) -> String {
            if let explicit = creature.originSpeciesID,
               let species = speciesByID[explicit],
               species.stage == 1,
               species.category == "start" {
                return explicit
            }
            var visiting: Set<String> = []
            return roots(for: creature.speciesID, visiting: &visiting).sorted().first
                ?? creature.speciesID
        }

        private mutating func roots(
            for speciesID: String,
            visiting: inout Set<String>
        ) -> Set<String> {
            if let cached = rootsBySpeciesID[speciesID] { return cached }
            guard visiting.insert(speciesID).inserted,
                  let species = speciesByID[speciesID] else { return [] }
            defer { visiting.remove(speciesID) }

            if species.stage == 1 && species.category == "start" {
                let result: Set<String> = [species.id]
                rootsBySpeciesID[speciesID] = result
                return result
            }

            var sourceIDs: Set<String> = []
            for source in species.evolutionFrom {
                if speciesByID[source] != nil {
                    sourceIDs.insert(source)
                } else {
                    sourceIDs.formUnion(speciesIDsByLineageStage[source] ?? [])
                }
            }
            var result: Set<String> = []
            for sourceID in sourceIDs.sorted() {
                result.formUnion(roots(for: sourceID, visiting: &visiting))
            }
            rootsBySpeciesID[speciesID] = result
            return result
        }
    }

    static func ingest(_ event: TokenUsageEvent, into state: inout GameState, now: Date = .now) throws {
        try event.validate(now: now)
        let eventKey = "\(event.provider.rawValue):\(event.sourceEventID)"
        guard !state.creditedUsageEventKeys.contains(eventKey) else {
            throw GameError.duplicateUsageEvent
        }
        state.creditedUsageEventKeys.insert(eventKey)
        state.usageEvents.append(event)
        if state.usageEvents.count > GameState.maximumRetainedUsageEvents {
            state.usageEvents.removeFirst(state.usageEvents.count - GameState.maximumRetainedUsageEvents)
        }
        let addition = state.tokenBalance.addingReportingOverflow(event.totalTokens)
        state.tokenBalance = addition.overflow ? Int.max : addition.partialValue
        let lifetime = state.lifetimeUsage[event.provider, default: 0].addingReportingOverflow(event.totalTokens)
        state.lifetimeUsage[event.provider] = lifetime.overflow ? Int.max : lifetime.partialValue
    }

    static func weeklyUsage(
        from state: GameState,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [TokenProvider: Int] {
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: now) else { return [:] }
        return state.usageEvents.reduce(into: [:]) { result, event in
            guard interval.contains(event.occurredAt) else { return }
            result[event.provider, default: 0] += event.totalTokens
        }
    }

    static func ingestCodexSnapshot(_ snapshot: CodexTokenSnapshot, into state: inout GameState, now: Date = .now) throws {
        let prior = state.codexCheckpoints[snapshot.threadID]
        let inputResult = snapshot.inputTokens.subtractingReportingOverflow(prior?.inputTokens ?? 0)
        let cachedResult = snapshot.cachedTokens.subtractingReportingOverflow(prior?.cachedTokens ?? 0)
        let outputResult = snapshot.outputTokens.subtractingReportingOverflow(prior?.outputTokens ?? 0)
        let input = inputResult.partialValue, cached = cachedResult.partialValue, output = outputResult.partialValue
        guard !inputResult.overflow, !cachedResult.overflow, !outputResult.overflow,
              input >= 0, cached >= 0, output >= 0 else { throw CollectorError.invalidPayload }
        let subtotal = input.addingReportingOverflow(cached)
        let total = subtotal.partialValue.addingReportingOverflow(output)
        guard !subtotal.overflow, !total.overflow, total.partialValue > 0,
              total.partialValue <= TokenUsageEvent.maximumTokensPerEvent else {
            if !subtotal.overflow, !total.overflow, total.partialValue == 0 { return }
            throw CollectorError.invalidPayload
        }
        state.codexCheckpoints[snapshot.threadID] = CodexCheckpoint(inputTokens: snapshot.inputTokens, cachedTokens: snapshot.cachedTokens, outputTokens: snapshot.outputTokens)
        try ingest(TokenUsageEvent(
            id: UUID(), provider: .codex,
            sourceEventID: "\(snapshot.threadID):\(snapshot.inputTokens):\(snapshot.cachedTokens):\(snapshot.outputTokens)",
            occurredAt: now, inputTokens: input, cachedTokens: cached, outputTokens: output
        ), into: &state, now: now)
    }

    static func pull(
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator,
        now: Date = .now
    ) throws -> OwnedCreature {
        guard state.tokenBalance >= GameState.gachaCost else { throw GameError.insufficientTokens }
        let candidates = catalog.filter { $0.category == "start" && $0.stage == 1 }
        guard !candidates.isEmpty else { throw GameError.emptyCatalog }
        let species = candidates[Int.random(in: candidates.indices, using: &generator)]
        state.tokenBalance -= GameState.gachaCost
        let creature = OwnedCreature(
            id: UUID(), speciesID: species.id, originSpeciesID: species.id,
            level: 1, experience: 0,
            affection: 0, nickname: nil,
            uniqueColor: Double.random(in: 0..<1, using: &generator) < 0.001,
            acquiredAt: now
        )
        state.ownedCreatures.append(creature)
        state.discoveredSpeciesIDs.insert(species.id)
        return creature
    }

    static func visibleOwnedCreatures(
        in state: GameState,
        catalog: [CreatureSpecies]
    ) -> [OwnedCreature] {
        var resolver = OriginResolver(catalog: catalog)
        var seenOrigins: Set<String> = []
        var visible: [OwnedCreature] = []
        for creature in acquisitionOrdered(state.ownedCreatures) {
            let origin = resolver.originSpeciesID(for: creature)
            if seenOrigins.insert(origin).inserted { visible.append(creature) }
        }
        return visible
    }

    static func ownedCreatures(
        inOriginGroupOf creatureID: UUID,
        state: GameState,
        catalog: [CreatureSpecies]
    ) -> [OwnedCreature] {
        guard let target = state.ownedCreatures.first(where: { $0.id == creatureID }) else {
            return []
        }
        var resolver = OriginResolver(catalog: catalog)
        let origin = resolver.originSpeciesID(for: target)
        var group: [OwnedCreature] = []
        for creature in acquisitionOrdered(state.ownedCreatures)
        where resolver.originSpeciesID(for: creature) == origin {
            group.append(creature)
        }
        return group
    }

    private static func acquisitionOrdered(_ creatures: [OwnedCreature]) -> [OwnedCreature] {
        creatures.enumerated().sorted {
            if $0.element.acquiredAt != $1.element.acquiredAt {
                return $0.element.acquiredAt < $1.element.acquiredAt
            }
            return $0.offset < $1.offset
        }.map(\.element)
    }

    static func originSpeciesID(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> String {
        var resolver = OriginResolver(catalog: catalog)
        return resolver.originSpeciesID(for: creature)
    }

    static func feed(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = [],
        generator: inout some RandomNumberGenerator,
        deferringEvolution: Bool = false
    ) throws -> FeedOutcome {
        try applyFood(
            creatureID: creatureID, state: &state, catalog: catalog,
            inventory: \Inventory.food, experience: 25, affection: 3, missingFood: .noFood,
            generator: &generator, deferringEvolution: deferringEvolution
        )
    }

    /// 난수와 무관한 호출부를 위한 편의 오버로드. 시스템 난수로 판정하므로
    /// 변이 발동을 통제해야 하는 곳에서는 `generator:` 버전을 쓴다.
    static func feed(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = []
    ) throws -> [EvolutionResult] {
        var generator = SystemRandomNumberGenerator()
        return try feed(
            creatureID: creatureID, state: &state, catalog: catalog, generator: &generator
        ).evolutions
    }

    static func purchaseFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.foodCost else { throw GameError.insufficientTokens }
        let nextFood = state.inventory.food.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.foodCost
        state.inventory.food = nextFood.partialValue
    }

    static func feedLarge(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = [],
        generator: inout some RandomNumberGenerator,
        deferringEvolution: Bool = false
    ) throws -> FeedOutcome {
        try applyFood(
            creatureID: creatureID, state: &state, catalog: catalog,
            inventory: \Inventory.largeFood, experience: 200, affection: 10,
            missingFood: .noLargeFood,
            generator: &generator, deferringEvolution: deferringEvolution
        )
    }

    /// 난수와 무관한 호출부를 위한 편의 오버로드. `feed`와 같은 이유로 남긴다.
    static func feedLarge(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = []
    ) throws -> [EvolutionResult] {
        var generator = SystemRandomNumberGenerator()
        return try feedLarge(
            creatureID: creatureID, state: &state, catalog: catalog, generator: &generator
        ).evolutions
    }

    static func purchaseLargeFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.largeFoodCost else { throw GameError.insufficientTokens }
        let nextFood = state.inventory.largeFood.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.largeFoodCost
        state.inventory.largeFood = nextFood.partialValue
    }

    static func resolvedPreference(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> PreferenceResolution {
        guard let preferredID = creature.preferredEvolutionTargetSpeciesID,
              let current = catalog.first(where: { $0.id == creature.speciesID }),
              let target = catalog.first(where: { $0.id == preferredID })
        else { return .invalid }
        if EvolutionCatalog.selectableCandidates(after: current, in: catalog)
            .contains(where: { $0.id == target.id }) {
            return .ready(target)
        }
        return selectableDescendantIDs(from: current, in: catalog).contains(target.id)
            ? .pendingDescendant : .invalid
    }

    /// 이 종 뒤로 갈 수 있는 곳이 전혀 없으면 종착이다. 변이는 선택할 수 없지만 확률로
    /// 도달할 수 있으므로 변이 후보가 하나라도 있으면 종착으로 보지 않는다.
    static func isTerminalSpecies(_ species: CreatureSpecies, catalog: [CreatureSpecies]) -> Bool {
        EvolutionCatalog.selectableCandidates(after: species, in: catalog).isEmpty
            && EvolutionCatalog.mutationCandidate(after: species, in: catalog) == nil
    }

    /// 지금 이 개체에 선호 대상으로 지정할 수 있는 종의 집합.
    /// `setEvolutionPreference`의 검증 범위와 같은 계산을 쓴다.
    static func selectablePreferenceTargetIDs(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> Set<String> {
        guard let current = catalog.first(where: { $0.id == creature.speciesID }) else { return [] }
        return selectableDescendantIDs(from: current, in: catalog)
    }

    static func pendingEvolutionChoice(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> PendingEvolutionChoice? {
        guard let current = catalog.first(where: { $0.id == creature.speciesID }),
              current.stage < 4,
              let requiredLevel = EvolutionCatalog.requiredLevel(for: current.stage + 1),
              creature.level >= requiredLevel
        else { return nil }
        let candidates = EvolutionCatalog.selectableCandidates(after: current, in: catalog)
        guard candidates.count > 1 else { return nil }
        if case .ready(let target) = resolvedPreference(for: creature, catalog: catalog) {
            // 비종착 예약은 조용히 진행한다. 종착 예약만 진화 직전에 한 번 확인을 받는다.
            guard isTerminalSpecies(target, catalog: catalog) else { return nil }
            return PendingEvolutionChoice(
                creatureID: creature.id, fromSpecies: current, candidates: candidates,
                preferredTargetID: target.id)
        }
        return PendingEvolutionChoice(
            creatureID: creature.id, fromSpecies: current, candidates: candidates,
            preferredTargetID: nil)
    }

    static func setEvolutionPreference(
        creatureID: UUID,
        toSpeciesID speciesID: String,
        state: inout GameState,
        catalog: [CreatureSpecies]
    ) throws {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        guard let current = catalog.first(where: { $0.id == state.ownedCreatures[index].speciesID }),
              selectableDescendantIDs(from: current, in: catalog).contains(speciesID)
        else { throw GameError.invalidEvolutionChoice }
        state.ownedCreatures[index].preferredEvolutionTargetSpeciesID = speciesID
    }

    static func clearEvolutionPreference(
        creatureID: UUID,
        state: inout GameState
    ) throws {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        state.ownedCreatures[index].preferredEvolutionTargetSpeciesID = nil
    }

    @discardableResult
    static func chooseEvolution(
        creatureID: UUID,
        toSpeciesID speciesID: String,
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator
    ) throws -> FeedOutcome {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        guard let current = catalog.first(where: { $0.id == state.ownedCreatures[index].speciesID }),
              current.stage < 4,
              let requiredLevel = EvolutionCatalog.requiredLevel(for: current.stage + 1),
              state.ownedCreatures[index].level >= requiredLevel,
              EvolutionCatalog.selectableCandidates(after: current, in: catalog)
                  .contains(where: { $0.id == speciesID })
        else { throw GameError.invalidEvolutionChoice }

        state.ownedCreatures[index].preferredEvolutionTargetSpeciesID = speciesID
        // 명시적 선택은 이미 시트에서 종착 확인을 마친 뒤 도착하므로 다시 멈추지 않는다.
        return evolveEligibleCreature(
            at: index, state: &state, catalog: catalog, generator: &generator,
            confirmedTerminalTargetID: speciesID)
    }

    /// 난수와 무관한 호출부를 위한 편의 오버로드.
    @discardableResult
    static func chooseEvolution(
        creatureID: UUID,
        toSpeciesID speciesID: String,
        state: inout GameState,
        catalog: [CreatureSpecies]
    ) throws -> [EvolutionResult] {
        var generator = SystemRandomNumberGenerator()
        return try chooseEvolution(
            creatureID: creatureID, toSpeciesID: speciesID, state: &state, catalog: catalog,
            generator: &generator
        ).evolutions
    }

    /// 발동한 변이를 수락하거나 거절해, 멈춰 있던 진화를 마저 진행한다.
    ///
    /// 거절 시 진행 대상은 발동 시점에 확정된 `offer.plannedTargetSpeciesID`를 그대로 쓴다 —
    /// 오퍼는 저장되지 않으므로 여기서 다시 계산하면 종착 예약 확인 같은 발동 시점의
    /// 맥락을 잃는다. 같은 해결 호출 안에서는 재판정이 없다.
    @discardableResult
    static func resolveMutationOffer(
        _ offer: PendingMutationOffer,
        accept: Bool,
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator
    ) throws -> [EvolutionResult] {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == offer.creatureID })
        else { throw GameError.creatureNotFound }
        guard let current = catalog.first(where: { $0.id == offer.fromSpeciesID }),
              state.ownedCreatures[index].speciesID == offer.fromSpeciesID,
              let requiredLevel = EvolutionCatalog.requiredLevel(for: current.stage + 1),
              state.ownedCreatures[index].level >= requiredLevel
        else { throw GameError.invalidEvolutionChoice }

        let target: CreatureSpecies? = accept
            ? EvolutionCatalog.mutationCandidate(after: current, in: catalog)
                .flatMap { $0.id == offer.mutationSpeciesID ? $0 : nil }
            : EvolutionCatalog.selectableCandidates(after: current, in: catalog)
                .first { $0.id == offer.plannedTargetSpeciesID }
        guard let target else { throw GameError.invalidEvolutionChoice }

        var results = [applyEvolution(at: index, from: current, to: target, state: &state)]
        // 변이는 S1→S2에서만 나오므로 이어지는 단계에는 애초에 후보가 없지만,
        // 재발동 금지를 구조로 못박기 위해 재개 루프에서 판정을 끈다.
        results.append(contentsOf: evolveEligibleCreature(
            at: index, state: &state, catalog: catalog, generator: &generator,
            offersMutation: false
        ).evolutions)
        return results
    }

    /// 이미 지나친 변이를 토큰으로 다시 노린다.
    ///
    /// 조건 검증을 모두 마친 뒤에만 상태를 건드린다 — 중간에 throw하면 잔액도 카운터도
    /// 그대로여야 한다. 원 개체는 어떤 필드도 바뀌지 않고, 성공 시 변이체가 **새 개체**로
    /// 추가될 뿐이라 `representativeCreatureID`도 움직이지 않는다.
    @discardableResult
    static func retryMutation(
        fromCreatureID creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator,
        now: Date = .now
    ) throws -> MutationRetryOutcome {
        guard let creature = state.ownedCreatures.first(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        let originID = originSpeciesID(for: creature, catalog: catalog)
        guard let current = catalog.first(where: { $0.id == creature.speciesID }),
              current.stage > 1,
              let origin = catalog.first(where: { $0.id == originID }),
              origin.stage == 1,
              let mutation = EvolutionCatalog.mutationCandidate(after: origin, in: catalog)
        else { throw GameError.creatureActionUnavailable }
        guard state.ownedCreatures.count < GameState.maximumOwnedCreatures else {
            throw GameError.creatureLimitReached
        }
        guard state.tokenBalance >= GameState.mutationRetryCost else {
            throw GameError.insufficientTokens
        }

        // 천장에 닿으면 난수를 소비조차 하지 않는다. 단축 평가가 그 계약을 구조로 지킨다.
        let succeeded =
            state.mutationRetryFailureCount(forOrigin: origin.id)
                >= GameState.mutationRetryPityThreshold
            || Double.random(in: 0..<1, using: &generator) < GameState.mutationTriggerRate

        state.tokenBalance -= GameState.mutationRetryCost
        guard succeeded else {
            state.recordMutationRetryFailure(forOrigin: origin.id)
            return MutationRetryOutcome(
                succeeded: false, creatureID: nil, tokensSpent: GameState.mutationRetryCost,
                failureCount: state.mutationRetryFailureCount(forOrigin: origin.id))
        }
        let offspring = OwnedCreature(
            id: UUID(), speciesID: mutation.id, originSpeciesID: origin.id,
            level: 1, experience: 0, affection: 0, nickname: nil,
            preferredEvolutionTargetSpeciesID: nil,
            // 가챠가 아니므로 유니크 컬러 판정을 하지 않는다.
            uniqueColor: false, acquiredAt: now)
        state.ownedCreatures.append(offspring)
        state.discoveredSpeciesIDs.insert(mutation.id)
        state.resetMutationRetryFailures(forOrigin: origin.id)
        return MutationRetryOutcome(
            succeeded: true, creatureID: offspring.id,
            tokensSpent: GameState.mutationRetryCost, failureCount: 0)
    }

    /// 종착까지 키운 개체를 발판 삼아 같은 계보의 시작종을 한 마리 더 받는다.
    /// 일반 분기를 다시 고르기 위한 경로다. 원 개체는 그대로 남는다.
    @discardableResult
    static func inherit(
        fromCreatureID creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies],
        now: Date = .now
    ) throws -> OwnedCreature {
        guard let creature = state.ownedCreatures.first(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        let originID = originSpeciesID(for: creature, catalog: catalog)
        guard let current = catalog.first(where: { $0.id == creature.speciesID }),
              isTerminalSpecies(current, catalog: catalog),
              let origin = catalog.first(where: { $0.id == originID }),
              origin.stage == 1
        else { throw GameError.creatureActionUnavailable }
        guard state.ownedCreatures.count < GameState.maximumOwnedCreatures else {
            throw GameError.creatureLimitReached
        }
        guard state.tokenBalance >= GameState.inheritCost else {
            throw GameError.insufficientTokens
        }

        state.tokenBalance -= GameState.inheritCost
        let offspring = OwnedCreature(
            id: UUID(), speciesID: origin.id, originSpeciesID: origin.id,
            level: 1, experience: 0, affection: 0, nickname: nil,
            preferredEvolutionTargetSpeciesID: nil,
            uniqueColor: false, acquiredAt: now)
        state.ownedCreatures.append(offspring)
        state.discoveredSpeciesIDs.insert(origin.id)
        return offspring
    }

    private static func selectableDescendantIDs(
        from start: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> Set<String> {
        var visited: Set<String> = [start.id]
        var frontier = [start]
        var descendants: Set<String> = []
        while let current = frontier.popLast() {
            for next in EvolutionCatalog.selectableCandidates(after: current, in: catalog)
            where visited.insert(next.id).inserted {
                descendants.insert(next.id)
                frontier.append(next)
            }
        }
        return descendants
    }

    private static func applyFood(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies],
        inventory: WritableKeyPath<Inventory, Int>,
        experience experienceGain: Int,
        affection affectionGain: Int,
        missingFood: GameError,
        generator: inout some RandomNumberGenerator,
        deferringEvolution: Bool
    ) throws -> FeedOutcome {
        guard state.inventory[keyPath: inventory] > 0 else { throw missingFood }
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        guard state.ownedCreatures[index].level < GameState.maximumCreatureLevel
                || pendingEvolutionChoice(
                    for: state.ownedCreatures[index], catalog: catalog) == nil
        else { throw GameError.evolutionChoiceRequired }

        state.inventory[keyPath: inventory] -= 1
        state.ownedCreatures[index].affection = min(
            100, state.ownedCreatures[index].affection + affectionGain)

        if state.ownedCreatures[index].level >= GameState.maximumCreatureLevel {
            state.ownedCreatures[index].experience = 0
        } else {
            let addition = state.ownedCreatures[index].experience.addingReportingOverflow(experienceGain)
            state.ownedCreatures[index].experience = addition.overflow ? Int.max : addition.partialValue
            while state.ownedCreatures[index].level < GameState.maximumCreatureLevel {
                let required = state.ownedCreatures[index].level * 100
                guard state.ownedCreatures[index].experience >= required else { break }
                state.ownedCreatures[index].experience -= required
                state.ownedCreatures[index].level += 1
            }
            if state.ownedCreatures[index].level == GameState.maximumCreatureLevel {
                state.ownedCreatures[index].experience = 0
            }
        }

        // 해결되지 않은 변이 오퍼가 걸린 개체는 레벨·경험치만 반영하고 진화를 보류한다.
        // 그대로 두면 같은 개체에 오퍼가 중복 생성되거나, 미해결 오퍼가 조용히 버려진 채
        // 원래 대상으로 진화해 버린다.
        guard !deferringEvolution else { return FeedOutcome() }

        return evolveEligibleCreature(
            at: index, state: &state, catalog: catalog, generator: &generator)
    }

    private static func evolveEligibleCreature(
        at index: Int,
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator,
        confirmedTerminalTargetID: String? = nil,
        offersMutation: Bool = true
    ) -> FeedOutcome {
        let speciesByID = Dictionary(
            catalog.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var results: [EvolutionResult] = []

        if speciesByID[state.ownedCreatures[index].speciesID] != nil,
           state.ownedCreatures[index].preferredEvolutionTargetSpeciesID != nil,
           resolvedPreference(for: state.ownedCreatures[index], catalog: catalog) == .invalid {
            state.ownedCreatures[index].preferredEvolutionTargetSpeciesID = nil
        }

        while let current = speciesByID[state.ownedCreatures[index].speciesID],
              current.stage < 4,
              let requiredLevel = EvolutionCatalog.requiredLevel(for: current.stage + 1),
              state.ownedCreatures[index].level >= requiredLevel,
              let next = chosenEvolutionTarget(
                  for: state.ownedCreatures[index], from: current, catalog: catalog,
                  confirmedTerminalTargetID: confirmedTerminalTargetID) {
            // 진행 대상이 확정된 뒤에만 판정한다. 변이 후보가 없는 계보에서는 난수를
            // 소비조차 하지 않아야 시드 재현성이 유지된다.
            if offersMutation, current.stage == 1,
               let mutation = EvolutionCatalog.mutationCandidate(after: current, in: catalog),
               Double.random(in: 0..<1, using: &generator) < GameState.mutationTriggerRate {
                return FeedOutcome(
                    evolutions: results,
                    mutationOffer: PendingMutationOffer(
                        creatureID: state.ownedCreatures[index].id,
                        fromSpeciesID: current.id,
                        mutationSpeciesID: mutation.id,
                        plannedTargetSpeciesID: next.id
                    )
                )
            }
            results.append(applyEvolution(at: index, from: current, to: next, state: &state))
        }
        return FeedOutcome(evolutions: results)
    }

    private static func applyEvolution(
        at index: Int,
        from current: CreatureSpecies,
        to next: CreatureSpecies,
        state: inout GameState
    ) -> EvolutionResult {
        state.ownedCreatures[index].speciesID = next.id
        if state.ownedCreatures[index].preferredEvolutionTargetSpeciesID == next.id {
            state.ownedCreatures[index].preferredEvolutionTargetSpeciesID = nil
        }
        state.discoveredSpeciesIDs.insert(next.id)
        return EvolutionResult(
            creatureID: state.ownedCreatures[index].id,
            fromSpeciesID: current.id,
            toSpeciesID: next.id,
            level: state.ownedCreatures[index].level
        )
    }

    private static func chosenEvolutionTarget(
        for creature: OwnedCreature,
        from current: CreatureSpecies,
        catalog: [CreatureSpecies],
        confirmedTerminalTargetID: String?
    ) -> CreatureSpecies? {
        let candidates = EvolutionCatalog.selectableCandidates(after: current, in: catalog)
        guard candidates.count > 1 else { return candidates.first }
        guard case .ready(let target) = resolvedPreference(for: creature, catalog: catalog) else {
            return nil
        }
        // 레벨 1에 찍어둔 예약이 수십 시간 뒤 조용히 성장을 끝내지 않도록, 종착 대상은
        // 사용자가 진화 직전에 한 번 확인한 뒤에만 적용한다.
        guard confirmedTerminalTargetID == target.id
                || !isTerminalSpecies(target, catalog: catalog)
        else { return nil }
        return target
    }

}
