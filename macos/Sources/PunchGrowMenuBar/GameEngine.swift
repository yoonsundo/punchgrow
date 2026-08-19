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
    static let mixedCategory = "mixed"
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
        lineageCandidates(after: current, in: catalog).filter {
            $0.category != mutantCategory
        }
    }

    /// macOS의 일반 진화 계보에 속하는 다음 단계다. `mixed`는 두 종의 결합으로 만든
    /// 별도 수집품이라 단일 개체의 성장 연속선에 넣지 않는다. 변이는 도감과 실제 도달
    /// 이력에 필요하므로 이 경계에는 남기고, 선택지만 `selectableCandidates`에서 제외한다.
    static func lineageCandidates(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> [CreatureSpecies] {
        guard current.category != mixedCategory else { return [] }
        return candidates(after: current, in: catalog).filter {
            $0.category != mixedCategory
        }
    }

    static func mutationCandidate(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> CreatureSpecies? {
        lineageCandidates(after: current, in: catalog).first { $0.category == mutantCategory }
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

        while let next = lineageCandidates(after: current, in: catalog).first,
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
            // 레거시 세이브의 혼합형은 예전 시작종을 origin으로 저장했을 수 있다. 이제
            // 일반 진화 계보 밖의 수집품이므로 그 origin으로 다시 접으면 메인 목록에서
            // 시작종 뒤에 숨는다. 현재 혼합 종 자체를 독립 그룹 키로 사용한다.
            if speciesByID[creature.speciesID]?.category == EvolutionCatalog.mixedCategory {
                return creature.speciesID
            }
            let possibleOrigins = possibleOriginSpeciesIDs(for: creature.speciesID)
            if let explicit = creature.originSpeciesID,
               let species = speciesByID[explicit],
               species.stage == 1,
               species.category == "start",
               possibleOrigins.contains(explicit) {
                return explicit
            }
            // 레거시 데이터에 origin이 없더라도 카탈로그가 유일한 시작종을 증명할 때만
            // 복원한다. 둘 이상이면 사전순 하나를 임의로 고르지 않고 현재 종을 독립 그룹으로 둔다.
            return possibleOrigins.count == 1 ? possibleOrigins.first! : creature.speciesID
        }

        mutating func possibleOriginSpeciesIDs(for speciesID: String) -> Set<String> {
            var visiting: Set<String> = []
            return roots(for: speciesID, visiting: &visiting)
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

    static func canBenefitFromFood(_ creature: OwnedCreature) -> Bool {
        creature.level < GameState.maximumCreatureLevel || creature.affection < 100
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
            inventory: \Inventory.largeFood,
            experience: GameState.largeFoodExperience,
            affection: GameState.largeFoodAffection,
            missingFood: .noLargeFood,
            generator: &generator, deferringEvolution: deferringEvolution
        )
    }

    /// 난수와 무관한 호출부를 위한 편의 오버로드. 시스템 난수로 판정하므로
    /// 변이 발동을 통제해야 하는 곳에서는 `generator:` 버전을 쓴다.
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

    static func feedExtraLarge(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = [],
        generator: inout some RandomNumberGenerator,
        deferringEvolution: Bool = false
    ) throws -> FeedOutcome {
        try applyFood(
            creatureID: creatureID, state: &state, catalog: catalog,
            inventory: \Inventory.extraLargeFood,
            experience: GameState.extraLargeFoodExperience,
            affection: GameState.extraLargeFoodAffection,
            missingFood: .noExtraLargeFood,
            generator: &generator, deferringEvolution: deferringEvolution
        )
    }

    /// 난수와 무관한 호출부를 위한 편의 오버로드. `feedLarge`와 같은 이유로 남긴다.
    static func feedExtraLarge(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies] = []
    ) throws -> [EvolutionResult] {
        var generator = SystemRandomNumberGenerator()
        return try feedExtraLarge(
            creatureID: creatureID, state: &state, catalog: catalog, generator: &generator
        ).evolutions
    }

    static func purchaseExtraLargeFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.extraLargeFoodCost else {
            throw GameError.insufficientTokens
        }
        let nextFood = state.inventory.extraLargeFood.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.extraLargeFoodCost
        state.inventory.extraLargeFood = nextFood.partialValue
    }

    /// 시작종에서 뻗어 나가는 모든 종. 변이도 포함한다 — 도감이 한 계보로 묶어 보여 주는
    /// 범위와 같아야 표시 모습으로 고를 수 있는 후보가 화면과 어긋나지 않는다.
    static func lineageSpeciesIDs(
        forOrigin originID: String,
        catalog: [CreatureSpecies]
    ) -> Set<String> {
        guard let origin = catalog.first(where: { $0.id == originID }) else { return [] }
        var visited: Set<String> = [origin.id]
        var frontier = [origin]
        while let current = frontier.popLast() {
            for next in EvolutionCatalog.lineageCandidates(after: current, in: catalog)
            where visited.insert(next.id).inserted {
                frontier.append(next)
            }
        }
        return visited
    }

    /// 이 개체가 시작형부터 현재 종까지 실제로 지나왔다고 증명할 수 있는 모습들이다.
    /// 세이브에는 단계별 이력을 중복 저장하지 않으므로 일반 계보 카탈로그 경로를 다시 찾는다.
    /// `mixed`는 그 경계에 들어오지 않으므로 레거시 세이브에 시작종이 있어도 현재 모습 하나만
    /// 반환한다. 그 밖에 시작종이 둘 이상 가능한 오류 데이터는 모든 경로의 교집합만 인정한다.
    static func reachedEvolutionSpeciesIDs(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> Set<String> {
        guard let actual = catalog.first(where: { $0.id == creature.speciesID }) else { return [] }
        let roots: [CreatureSpecies]
        if let explicitOriginID = creature.originSpeciesID {
            guard let explicit = catalog.first(where: { $0.id == explicitOriginID }),
                  explicit.stage == 1,
                  explicit.category == "start"
            else { return [actual.id] }
            roots = [explicit]
        } else {
            var resolver = OriginResolver(catalog: catalog)
            let possibleOriginIDs = resolver.possibleOriginSpeciesIDs(for: actual.id)
            roots = possibleOriginIDs.compactMap { id in catalog.first { $0.id == id } }
        }

        let possiblePaths = roots.flatMap {
            evolutionPaths(from: $0, to: actual, catalog: catalog)
        }
        guard let firstPath = possiblePaths.first else { return [actual.id] }
        return possiblePaths.dropFirst().reduce(into: Set(firstPath)) { common, path in
            common.formIntersection(path)
        }
    }

    private static func evolutionPaths(
        from origin: CreatureSpecies,
        to target: CreatureSpecies,
        catalog: [CreatureSpecies]
    ) -> [[String]] {
        var frontier: [(species: CreatureSpecies, path: [String])] = [(origin, [origin.id])]
        var cursor = 0
        var matches: [[String]] = []
        while cursor < frontier.count {
            let node = frontier[cursor]
            cursor += 1
            if node.species.id == target.id {
                matches.append(node.path)
                continue
            }
            guard node.species.stage < target.stage else { continue }
            for candidate in EvolutionCatalog.lineageCandidates(after: node.species, in: catalog)
            where candidate.stage <= target.stage && !node.path.contains(candidate.id) {
                frontier.append((candidate, node.path + [candidate.id]))
            }
        }
        return matches
    }

    /// 화면에 그릴 종. 고정해 둔 모습이 지금도 유효할 때만 그것을 쓰고, 아니면 실제 종으로
    /// 되돌아간다. 카탈로그가 바뀌어 고정값이 떠도 화면이 비지 않게 하기 위해서다.
    static func displaySpecies(
        for creature: OwnedCreature,
        catalog: [CreatureSpecies]
    ) -> CreatureSpecies? {
        let actual = catalog.first { $0.id == creature.speciesID }
        guard let displayID = creature.displaySpeciesID, displayID != creature.speciesID,
              let display = catalog.first(where: { $0.id == displayID }),
              reachedEvolutionSpeciesIDs(for: creature, catalog: catalog).contains(displayID)
        else { return actual }
        return display
    }

    /// 표시 모습을 고정한다. **개체의 종과 성장은 건드리지 않는다** — 이 함수가 바꾸는 것은
    /// `displaySpeciesID` 하나뿐이다.
    static func setDisplayForm(
        creatureID: UUID,
        toSpeciesID speciesID: String,
        state: inout GameState,
        catalog: [CreatureSpecies]
    ) throws {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        let creature = state.ownedCreatures[index]
        // 실제 모습으로 되돌리는 요청은 고정 해제와 같다.
        guard speciesID != creature.speciesID else {
            state.ownedCreatures[index].displaySpeciesID = nil
            return
        }
        guard reachedEvolutionSpeciesIDs(for: creature, catalog: catalog).contains(speciesID)
        else { throw GameError.invalidEvolutionChoice }
        state.ownedCreatures[index].displaySpeciesID = speciesID
    }

    static func clearDisplayForm(creatureID: UUID, state: inout GameState) throws {
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        state.ownedCreatures[index].displaySpeciesID = nil
    }

    /// 이 종 뒤로 갈 수 있는 곳이 전혀 없으면 종착이다. 변이는 선택할 수 없지만 확률로
    /// 도달할 수 있으므로 변이 후보가 하나라도 있으면 종착으로 보지 않는다.
    static func isTerminalSpecies(_ species: CreatureSpecies, catalog: [CreatureSpecies]) -> Bool {
        EvolutionCatalog.selectableCandidates(after: species, in: catalog).isEmpty
            && EvolutionCatalog.mutationCandidate(after: species, in: catalog) == nil
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
        return PendingEvolutionChoice(
            creatureID: creature.id, fromSpecies: current, candidates: candidates)
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

        // 시트에서 고른 결과는 이번 호출에만 쓰인다. 예약으로 남기지 않으므로 다음 갈림길은
        // 다시 사용자에게 묻는다.
        return evolveEligibleCreature(
            at: index, state: &state, catalog: catalog, generator: &generator,
            explicitTargetID: speciesID)
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
              current.category != EvolutionCatalog.mixedCategory,
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
              current.category != EvolutionCatalog.mixedCategory,
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
        guard canBenefitFromFood(state.ownedCreatures[index]) else {
            throw GameError.creatureActionUnavailable
        }
        guard state.ownedCreatures[index].level < GameState.maximumCreatureLevel
                || pendingEvolutionChoice(
                    for: state.ownedCreatures[index], catalog: catalog) == nil
        else { throw GameError.evolutionChoiceRequired }

        state.inventory[keyPath: inventory] -= 1
        state.ownedCreatures[index].affection = min(
            100, state.ownedCreatures[index].affection + affectionGain)

        // 축전은 만렙 미만이었다가 이번 급여로 도달한 전이 순간에만 알린다.
        var reachedMaximumLevel = false
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
                reachedMaximumLevel = true
            }
        }
        let reachedMaximumLevelCreatureID = reachedMaximumLevel ? creatureID : nil

        // 해결되지 않은 변이 오퍼가 걸린 개체는 레벨·경험치만 반영하고 진화를 보류한다.
        // 그대로 두면 같은 개체에 오퍼가 중복 생성되거나, 미해결 오퍼가 조용히 버려진 채
        // 원래 대상으로 진화해 버린다.
        guard !deferringEvolution else {
            return FeedOutcome(reachedMaximumLevelCreatureID: reachedMaximumLevelCreatureID)
        }

        let outcome = evolveEligibleCreature(
            at: index, state: &state, catalog: catalog, generator: &generator)
        // FeedOutcome에 필드를 새로 더하면 이 되싸기에도 반드시 실어야 한다.
        return FeedOutcome(
            evolutions: outcome.evolutions,
            mutationOffer: outcome.mutationOffer,
            reachedMaximumLevelCreatureID: reachedMaximumLevelCreatureID)
    }

    private static func evolveEligibleCreature(
        at index: Int,
        state: inout GameState,
        catalog: [CreatureSpecies],
        generator: inout some RandomNumberGenerator,
        explicitTargetID: String? = nil,
        offersMutation: Bool = true
    ) -> FeedOutcome {
        let speciesByID = Dictionary(
            catalog.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var results: [EvolutionResult] = []

        while let current = speciesByID[state.ownedCreatures[index].speciesID],
              current.stage < 4,
              let requiredLevel = EvolutionCatalog.requiredLevel(for: current.stage + 1),
              state.ownedCreatures[index].level >= requiredLevel,
              let next = chosenEvolutionTarget(
                  from: current, catalog: catalog, explicitTargetID: explicitTargetID) {
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
        state.discoveredSpeciesIDs.insert(next.id)
        return EvolutionResult(
            creatureID: state.ownedCreatures[index].id,
            fromSpeciesID: current.id,
            toSpeciesID: next.id,
            level: state.ownedCreatures[index].level
        )
    }

    /// 갈림길은 사용자가 고를 때까지 멈춘다. 이번 호출로 전달된 선택만 통과시키므로,
    /// 여러 단계를 연달아 오를 때 두 번째 갈림길은 다시 멈춘다.
    private static func chosenEvolutionTarget(
        from current: CreatureSpecies,
        catalog: [CreatureSpecies],
        explicitTargetID: String?
    ) -> CreatureSpecies? {
        let candidates = EvolutionCatalog.selectableCandidates(after: current, in: catalog)
        guard candidates.count > 1 else { return candidates.first }
        return explicitTargetID.flatMap { id in candidates.first { $0.id == id } }
    }

}
