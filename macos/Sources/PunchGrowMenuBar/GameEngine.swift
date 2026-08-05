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
        guard !catalog.isEmpty else { throw GameError.emptyCatalog }

        let guaranteedOrigin = state.pullsSinceOrigin >= GameState.originPityThreshold
        let weeklyTotal = weeklyUsage(from: state, now: now).reduce(0) { $0 + $1.value }
        let activityBoost = min(1, Double(weeklyTotal) / Double(GameState.weeklyUsageForMaximumActivityBonus))
        let rarity = guaranteedOrigin ? "ORIGIN" : rollRarity(activityBoost: activityBoost, using: &generator)
        let candidates = catalog.filter { $0.rarity == rarity }
        guard !candidates.isEmpty else { throw GameError.emptyCatalog }
        let species = candidates[Int.random(in: candidates.indices, using: &generator)]
        state.tokenBalance -= GameState.gachaCost
        let creature = OwnedCreature(
            id: UUID(), speciesID: species.id, level: 1, experience: 0,
            affection: 0, nickname: nil,
            uniqueColor: Double.random(in: 0..<1, using: &generator) < 0.001,
            acquiredAt: now
        )
        state.ownedCreatures.append(creature)
        state.discoveredSpeciesIDs.insert(species.id)
        state.pullsSinceOrigin = rarity == "ORIGIN" ? 0 : state.pullsSinceOrigin + 1
        return creature
    }

    static func feed(creatureID: UUID, state: inout GameState) throws {
        guard state.inventory.food > 0 else { throw GameError.noFood }
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        state.inventory.food -= 1
        state.ownedCreatures[index].experience += 25
        state.ownedCreatures[index].affection = min(100, state.ownedCreatures[index].affection + 3)
        while state.ownedCreatures[index].experience >= state.ownedCreatures[index].level * 100 {
            state.ownedCreatures[index].experience -= state.ownedCreatures[index].level * 100
            state.ownedCreatures[index].level += 1
        }
    }

    static func purchaseFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.foodCost else { throw GameError.insufficientTokens }
        let nextFood = state.inventory.food.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.foodCost
        state.inventory.food = nextFood.partialValue
    }

    static func feedLarge(creatureID: UUID, state: inout GameState) throws {
        guard state.inventory.largeFood > 0 else { throw GameError.noLargeFood }
        guard let index = state.ownedCreatures.firstIndex(where: { $0.id == creatureID }) else {
            throw GameError.creatureNotFound
        }
        state.inventory.largeFood -= 1
        state.ownedCreatures[index].experience += 200
        state.ownedCreatures[index].affection = min(100, state.ownedCreatures[index].affection + 10)
        while state.ownedCreatures[index].experience >= state.ownedCreatures[index].level * 100 {
            state.ownedCreatures[index].experience -= state.ownedCreatures[index].level * 100
            state.ownedCreatures[index].level += 1
        }
    }

    static func purchaseLargeFood(state: inout GameState) throws {
        guard state.tokenBalance >= GameState.largeFoodCost else { throw GameError.insufficientTokens }
        let nextFood = state.inventory.largeFood.addingReportingOverflow(1)
        guard !nextFood.overflow else { throw GameError.inventoryFull }
        state.tokenBalance -= GameState.largeFoodCost
        state.inventory.largeFood = nextFood.partialValue
    }

    private static func rollRarity(activityBoost: Double, using generator: inout some RandomNumberGenerator) -> String {
        let roll = Double.random(in: 0..<100, using: &generator)
        let boost = max(0, min(1, activityBoost))
        return switch roll {
        case ..<(55 - 15 * boost): "PROCESS"
        case ..<(80 - 14 * boost): "AGENT"
        case ..<(92 - 10 * boost): "DAEMON"
        case ..<(98 - 5 * boost): "ORACLE"
        case ..<(99.8 - 0.8 * boost): "ARCHITECT"
        default: "ORIGIN"
        }
    }
}
