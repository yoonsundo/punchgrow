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
        let ordered = state.ownedCreatures.enumerated().sorted {
            if $0.element.acquiredAt != $1.element.acquiredAt {
                return $0.element.acquiredAt < $1.element.acquiredAt
            }
            return $0.offset < $1.offset
        }
        for (_, creature) in ordered {
            let origin = resolver.originSpeciesID(for: creature)
            if seenOrigins.insert(origin).inserted { visible.append(creature) }
        }
        return visible
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
        catalog: [CreatureSpecies] = []
    ) throws -> [EvolutionResult] {
        try applyFood(
            creatureID: creatureID, state: &state, catalog: catalog,
            inventory: \Inventory.food, experience: 25, affection: 3, missingFood: .noFood
        )
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
        catalog: [CreatureSpecies] = []
    ) throws -> [EvolutionResult] {
        try applyFood(
            creatureID: creatureID, state: &state, catalog: catalog,
            inventory: \Inventory.largeFood, experience: 200, affection: 10,
            missingFood: .noLargeFood
        )
    }

    static func purchaseLargeFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.largeFoodCost else { throw GameError.insufficientTokens }
        let nextFood = state.inventory.largeFood.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.largeFoodCost
        state.inventory.largeFood = nextFood.partialValue
    }

    private static func applyFood(
        creatureID: UUID,
        state: inout GameState,
        catalog: [CreatureSpecies],
        inventory: WritableKeyPath<Inventory, Int>,
        experience experienceGain: Int,
        affection affectionGain: Int,
        missingFood: GameError
    ) throws -> [EvolutionResult] {
        guard state.inventory[keyPath: inventory] > 0 else { throw missingFood }
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }

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

        return evolveEligibleCreature(at: index, state: &state, catalog: catalog)
    }

    private static func evolveEligibleCreature(
        at index: Int,
        state: inout GameState,
        catalog: [CreatureSpecies]
    ) -> [EvolutionResult] {
        let speciesByID = Dictionary(
            catalog.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var results: [EvolutionResult] = []

        while let current = speciesByID[state.ownedCreatures[index].speciesID],
              current.stage < 4,
              state.ownedCreatures[index].level >= evolutionLevel(for: current.stage + 1),
              let next = nextEvolution(after: current, in: catalog) {
            state.ownedCreatures[index].speciesID = next.id
            state.discoveredSpeciesIDs.insert(next.id)
            results.append(EvolutionResult(
                creatureID: state.ownedCreatures[index].id,
                fromSpeciesID: current.id,
                toSpeciesID: next.id,
                level: state.ownedCreatures[index].level
            ))
        }
        return results
    }

    private static func nextEvolution(
        after current: CreatureSpecies,
        in catalog: [CreatureSpecies]
    ) -> CreatureSpecies? {
        let lineageReference = "\(current.lineageId):S\(current.stage)"
        let categoryPriority = [
            "normal_evolution": 0, "branch": 1, "mixed": 2, "special": 3, "mutant": 4,
        ]
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
            .first
    }

    private static func evolutionLevel(for stage: Int) -> Int {
        switch stage {
        case 2: 15
        case 3: 25
        case 4: 40
        default: .max
        }
    }
}
