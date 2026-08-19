import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 첫 판정이 10%를 넘겨 변이가 발동하지 않는 시드. US-4로 S1→S2 진화 경로에 확률
/// 판정이 들어왔으므로, 변이와 무관한 진화 계약은 이 시드를 주입해 결정론적으로 본다.
/// 시드가 어긋나면 각 호출부의 `XCTAssertNil(_.mutationOffer)`가 즉시 실패한다.
private let mutationFreeSeed: UInt64 = 1

final class GameEngineTests: XCTestCase {

  func testUsageIngestionIsIdempotent() throws {
    var state = GameState()
    let startingBalance = state.tokenBalance
    let event = TokenUsageEvent(
      id: UUID(), provider: .claude, sourceEventID: "evt-1", occurredAt: .now,
      inputTokens: 10, cachedTokens: 5, outputTokens: 2
    )
    try GameEngine.ingest(event, into: &state)
    XCTAssertTrue(state.tokenBalance == startingBalance + 17)
    XCTAssertThrowsError(try GameEngine.ingest(event, into: &state)) { error in
      XCTAssertEqual(error as? GameError, .duplicateUsageEvent)
    }
  }

  func testInvalidUsageIsRejected() {
    var state = GameState()
    let event = TokenUsageEvent(
      id: UUID(), provider: .codex, sourceEventID: "evt-invalid", occurredAt: .now,
      inputTokens: -1, cachedTokens: 0, outputTokens: 2
    )
    XCTAssertThrowsError(try GameEngine.ingest(event, into: &state)) { error in
      XCTAssertEqual(error as? GameError, .invalidUsageEvent)
    }
  }

  func testPullSelectsOnlyStageOneAndLeavesLegacyPityUnchanged() throws {
    var state = GameState()
    state.pullsSinceOrigin = GameState.originPityThreshold
    let start = testSpecies(id: "PG-001", stage: 1, category: "start")
    let evolved = testSpecies(
      id: "PG-002", stage: 2, category: "normal_evolution", evolutionFrom: ["PG-001"])
    var generator = SeededGenerator(seed: 42)
    let creature = try GameEngine.pull(
      state: &state, catalog: [evolved, start], generator: &generator)
    XCTAssertEqual(creature.speciesID, start.id)
    XCTAssertEqual(state.pullsSinceOrigin, GameState.originPityThreshold)
  }

  func testSeededPullsUseTheExactSixtyFourSpeciesStartPool() throws {
    let catalog = try CreatureCatalog.load()
    let expected = Set(catalog.filter { $0.category == "start" && $0.stage == 1 }.map(\.id))
    var state = GameState()
    state.tokenBalance = GameState.gachaCost * 6_000
    var generator = SeededGenerator(seed: 15_25_40)
    var drawn: Set<String> = []

    for _ in 0..<6_000 {
      drawn.insert(try GameEngine.pull(
        state: &state, catalog: catalog, generator: &generator).speciesID)
    }

    XCTAssertEqual(expected.count, 64)
    XCTAssertEqual(drawn, expected)
  }

  func testPullFailsAtomicallyWithoutStageOneCatalogEntry() {
    var state = GameState()
    state.pullsSinceOrigin = GameState.originPityThreshold
    let before = state
    let evolved = testSpecies(
      id: "PG-002", stage: 2, category: "normal_evolution", evolutionFrom: ["PG-001"])
    var generator = SeededGenerator(seed: 42)
    XCTAssertThrowsError(
      try GameEngine.pull(state: &state, catalog: [evolved], generator: &generator)
    ) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog)
    }
    XCTAssertEqual(state, before)
  }

  func testRepeatedSpeciesAcquisitionsRemainDistinctOwnedInstances() throws {
    var state = GameState()
    state.tokenBalance = GameState.gachaCost * 2
    state.pullsSinceOrigin = GameState.originPityThreshold
    let origin = testSpecies(id: "PG-999", stage: 1, category: "start", rarity: "ORIGIN")
    var generator = SeededGenerator(seed: 42)

    let first = try GameEngine.pull(state: &state, catalog: [origin], generator: &generator)
    state.pullsSinceOrigin = GameState.originPityThreshold
    let second = try GameEngine.pull(state: &state, catalog: [origin], generator: &generator)

    XCTAssertTrue(first.speciesID == second.speciesID)
    XCTAssertEqual(first.originSpeciesID, origin.id)
    XCTAssertEqual(second.originSpeciesID, origin.id)
    XCTAssertTrue(first.id != second.id)
    XCTAssertTrue(Set(state.ownedCreatures.map(\.id)).count == 2)
  }

  func testVisibleCreaturesKeepEarliestInstancePerOriginalGachaSpecies() {
    let start = testSpecies(id: "PG-001", stage: 1, category: "start", lineageId: "PG-L001")
    let evolved = testSpecies(
      id: "PG-061", stage: 2, category: "normal_evolution", lineageId: "PG-L001",
      evolutionFrom: ["PG-001"])
    let first = OwnedCreature(
      id: UUID(), speciesID: evolved.id, originSpeciesID: start.id, level: 15, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 1))
    let duplicate = OwnedCreature(
      id: UUID(), speciesID: start.id, originSpeciesID: start.id, level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 2))
    var state = GameState()
    state.ownedCreatures = [duplicate, first]

    let visible = GameEngine.visibleOwnedCreatures(in: state, catalog: [evolved, start])

    XCTAssertEqual(visible.map(\.id), [first.id])
    XCTAssertEqual(state.ownedCreatures.count, 2)
  }

  func testLegacyOriginResolutionTraversesCatalogWhenLineageIDChanges() {
    let start = testSpecies(id: "PG-001", stage: 1, category: "start", lineageId: "PG-L001")
    let second = testSpecies(
      id: "PG-061", stage: 2, category: "normal_evolution", lineageId: "PG-L001",
      evolutionFrom: ["PG-L001:S1"])
    let third = testSpecies(
      id: "PG-181", stage: 3, category: "normal_evolution", lineageId: "PG-L099",
      evolutionFrom: ["PG-061"])
    let legacy = OwnedCreature(
      id: UUID(), speciesID: third.id, level: 25, experience: 0, affection: 0,
      nickname: nil, uniqueColor: false, acquiredAt: .now)

    XCTAssertNil(legacy.originSpeciesID)
    XCTAssertEqual(
      GameEngine.originSpeciesID(for: legacy, catalog: [third, start, second]),
      start.id)
  }

  func testInvalidExplicitOriginFallsBackToCatalogStartAncestor() {
    let start = testSpecies(id: "PG-001", stage: 1, category: "start", lineageId: "PG-L001")
    let evolved = testSpecies(
      id: "PG-061", stage: 2, category: "normal_evolution", lineageId: "PG-L001",
      evolutionFrom: [start.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: evolved.id, originSpeciesID: evolved.id,
      level: 15, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: .now)

    XCTAssertEqual(
      GameEngine.originSpeciesID(for: creature, catalog: [evolved, start]),
      start.id)
  }

  func testAmbiguousLegacyOriginDoesNotChooseAnArbitraryStart() {
    let firstRoot = testSpecies(id: "PG-A01", stage: 1, category: "start")
    let secondRoot = testSpecies(id: "PG-A02", stage: 1, category: "start")
    let shared = testSpecies(
      id: "PG-A03", stage: 2, category: "normal_evolution",
      evolutionFrom: [firstRoot.id, secondRoot.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: shared.id, level: 15, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    XCTAssertEqual(
      GameEngine.originSpeciesID(for: creature, catalog: [firstRoot, secondRoot, shared]),
      shared.id)
    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(
        for: creature, catalog: [firstRoot, secondRoot, shared]),
      [shared.id])
  }

  func testLegacyMixedCreatureUsesItsOwnStandaloneGroupInsteadOfStoredOrigin() {
    let start = testSpecies(id: "PG-001", stage: 1, category: "start", lineageId: "PG-L001")
    let mixed = testSpecies(
      id: "PG-201", stage: 3, category: "mixed", lineageId: "PG-MIX",
      evolutionFrom: [start.id])
    let original = OwnedCreature(
      id: UUID(), speciesID: start.id, originSpeciesID: start.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1))
    let legacyMixed = OwnedCreature(
      id: UUID(), speciesID: mixed.id, originSpeciesID: start.id,
      level: 40, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 2))
    var state = GameState()
    state.ownedCreatures = [original, legacyMixed]

    XCTAssertEqual(
      GameEngine.originSpeciesID(for: legacyMixed, catalog: [start, mixed]),
      mixed.id)
    XCTAssertEqual(
      GameEngine.visibleOwnedCreatures(in: state, catalog: [start, mixed]).map(\.id),
      [original.id, legacyMixed.id])
    XCTAssertEqual(
      GameEngine.ownedCreatures(
        inOriginGroupOf: legacyMixed.id, state: state, catalog: [start, mixed]
      ).map(\.id),
      [legacyMixed.id])
  }

  func testUsageHistoryRetentionIsBounded() throws {
    var state = GameState()
    let now = Date()
    for index in 0...GameState.maximumRetainedUsageEvents {
      let event = TokenUsageEvent(
        id: UUID(), provider: .claude, sourceEventID: "event-\(index)", occurredAt: now,
        inputTokens: 1, cachedTokens: 0, outputTokens: 0
      )
      try GameEngine.ingest(event, into: &state, now: now)
    }
    XCTAssertTrue(state.usageEvents.count == GameState.maximumRetainedUsageEvents)
    XCTAssertTrue(state.usageEvents.first?.sourceEventID == "event-1")
  }

  func testFeedingConsumesInventoryAndGrowsCreature() throws {
    var state = GameState()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 90,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    state.ownedCreatures = [creature]
    try GameEngine.feedLarge(creatureID: creature.id, state: &state)
    XCTAssertEqual(state.inventory.largeFood, 0)
    XCTAssertEqual(state.ownedCreatures[0].level, 2)
    XCTAssertEqual(state.ownedCreatures[0].experience, 190)
    XCTAssertEqual(state.ownedCreatures[0].affection, 10)
  }

  func testLargeFoodPurchaseSpendsFiveHundredThousandTokensAndAddsOneFood() throws {
    var state = GameState()
    state.tokenBalance = 500_000
    state.inventory.largeFood = 0

    try GameEngine.purchaseLargeFood(state: &state)

    XCTAssertEqual(state.tokenBalance, 0)
    XCTAssertEqual(state.inventory.largeFood, 1)
  }

  func testLargeFoodPurchaseFailsAtomicallyWhenTokensAreInsufficient() {
    var state = GameState()
    state.tokenBalance = GameState.largeFoodCost - 1
    state.inventory.largeFood = 2
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseLargeFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .insufficientTokens)
    }
    XCTAssertEqual(state, before)
  }

  func testLargeFoodPurchaseRejectsInventoryOverflowWithoutSpendingTokens() {
    var state = GameState()
    state.tokenBalance = GameState.largeFoodCost
    state.inventory.largeFood = Int.max
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseLargeFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .inventoryFull)
    }
    XCTAssertEqual(state, before)
  }

  func testExtraLargeFoodConsumesSeparateInventoryAndGrantsOneThousandXPAndFiftyAffection() throws {
    var state = GameState()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 90,
      affection: 10, nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    state.ownedCreatures = [creature]
    state.inventory.extraLargeFood = 1

    try GameEngine.feedExtraLarge(creatureID: creature.id, state: &state)

    XCTAssertEqual(state.inventory.extraLargeFood, 0)
    XCTAssertEqual(state.ownedCreatures[0].level, 5)
    XCTAssertEqual(state.ownedCreatures[0].experience, 90)
    XCTAssertEqual(state.ownedCreatures[0].affection, 60)
  }

  func testJephirakEvolvesAtEveryThresholdAndPreservesMetadata() throws {
    let catalog = try CreatureCatalog.load()
    let id = UUID()
    let acquiredAt = Date(timeIntervalSince1970: 123)
    var state = GameState()
    state.ownedCreatures = [OwnedCreature(
      id: id, speciesID: "PG-034", originSpeciesID: "PG-034",
      level: 14, experience: 1_390,
      affection: 40, nickname: "바람이", uniqueColor: true, acquiredAt: acquiredAt
    )]
    state.representativeCreatureID = id
    state.inventory.largeFood = 3

    var generator = SeededGenerator(seed: mutationFreeSeed)
    let stageOne = try GameEngine.feedLarge(
      creatureID: id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(stageOne.mutationOffer)
    var chain = stageOne.evolutions
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-117"])
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))

    state.ownedCreatures[0].level = 24
    state.ownedCreatures[0].experience = 2_390
    chain = try GameEngine.feedLarge(creatureID: id, state: &state, catalog: catalog)
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-118"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-118")
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-205"))

    state.ownedCreatures[0].level = 39
    state.ownedCreatures[0].experience = 3_990
    chain = try GameEngine.feedLarge(creatureID: id, state: &state, catalog: catalog)
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-119"])
    let evolved = state.ownedCreatures[0]
    XCTAssertEqual(evolved.id, id)
    XCTAssertEqual(evolved.nickname, "바람이")
    XCTAssertTrue(evolved.uniqueColor)
    XCTAssertEqual(evolved.originSpeciesID, "PG-034")
    XCTAssertEqual(evolved.acquiredAt, acquiredAt)
    XCTAssertEqual(state.representativeCreatureID, id)
    XCTAssertTrue(state.discoveredSpeciesIDs.isSuperset(of: ["PG-117", "PG-118", "PG-119"]))
  }

  func testEvolutionDoesNotRunImmediatelyBelowEachThreshold() throws {
    let catalog = try CreatureCatalog.load()
    for (speciesID, level) in [("PG-034", 14), ("PG-117", 24), ("PG-118", 39)] {
      let creature = OwnedCreature(
        id: UUID(), speciesID: speciesID, level: level, experience: 0,
        affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
      var state = GameState()
      state.ownedCreatures = [creature]

      let chain = try GameEngine.feedLarge(
        creatureID: creature.id, state: &state, catalog: catalog)

      XCTAssertTrue(chain.isEmpty)
      XCTAssertEqual(state.ownedCreatures[0].speciesID, speciesID)
      XCTAssertEqual(state.ownedCreatures[0].level, level)
    }
  }

  func testLegacyCreatureCatchesUpAcrossAllEligibleStagesInOrder() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-034", level: 40, experience: 900,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    var generator = SeededGenerator(seed: mutationFreeSeed)
    let outcome = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(outcome.mutationOffer)
    let chain = outcome.evolutions

    XCTAssertEqual(chain.map(\.fromSpeciesID), ["PG-034", "PG-117", "PG-118"])
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-117", "PG-118", "PG-119"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-119")
    XCTAssertEqual(state.ownedCreatures[0].level, 40)
    XCTAssertEqual(state.ownedCreatures[0].experience, 1_100)
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-205"))
  }

  func testLevelCapAndLegacyAboveCapConsumeFoodGainAffectionAndDiscardXP() throws {
    for level in [50, 51, 100] {
      let creature = OwnedCreature(
        id: UUID(), speciesID: "PG-999", level: level, experience: 123,
        affection: 7, nickname: nil, uniqueColor: false, acquiredAt: .now)
      var state = GameState()
      state.ownedCreatures = [creature]
      var generator = SystemRandomNumberGenerator()
      let outcome = try GameEngine.feedLarge(
        creatureID: creature.id, state: &state, catalog: [], generator: &generator)
      XCTAssertTrue(outcome.evolutions.isEmpty)
      // 이미 만렙이거나 그 위의 레거시 개체는 축전 신호를 다시 받지 않는다.
      XCTAssertNil(outcome.reachedMaximumLevelCreatureID)
      XCTAssertEqual(state.inventory.largeFood, 0)
      XCTAssertEqual(state.ownedCreatures[0].level, level)
      XCTAssertEqual(state.ownedCreatures[0].experience, 0)
      XCTAssertEqual(state.ownedCreatures[0].affection, 17)
    }
  }

  func testLargeFoodCannotGrowPastLevelFifty() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: 49, experience: 4_899,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 1

    _ = try GameEngine.feedLarge(creatureID: creature.id, state: &state, catalog: [])

    XCTAssertEqual(state.ownedCreatures[0].level, GameState.maximumCreatureLevel)
    XCTAssertEqual(state.ownedCreatures[0].experience, 0)
  }

  func testLargeFoodRejectsFullySatisfiedMaximumLevelCreatureWithoutConsumingInventory() {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: GameState.maximumCreatureLevel,
      experience: 0, affection: 100, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 1
    let before = state

    XCTAssertThrowsError(
      try GameEngine.feedLarge(creatureID: creature.id, state: &state, catalog: [])
    ) { error in
      XCTAssertEqual(error as? GameError, .creatureActionUnavailable)
    }
    XCTAssertEqual(state, before)
  }

  func testExtraLargeFoodRejectsFullySatisfiedMaximumLevelCreatureWithoutConsumingInventory() {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: GameState.maximumCreatureLevel,
      experience: 0, affection: 100, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.extraLargeFood = 1
    let before = state

    XCTAssertThrowsError(
      try GameEngine.feedExtraLarge(creatureID: creature.id, state: &state, catalog: [])
    ) { error in
      XCTAssertEqual(error as? GameError, .creatureActionUnavailable)
    }
    XCTAssertEqual(state, before)
  }

  func testFeedReportsMaximumLevelOnlyAtTheCrossingMoment() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: 49, experience: 4_899,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 2

    var generator = SystemRandomNumberGenerator()
    let crossing = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: [], generator: &generator)
    XCTAssertEqual(crossing.reachedMaximumLevelCreatureID, creature.id)
    XCTAssertEqual(state.ownedCreatures[0].level, GameState.maximumCreatureLevel)

    // 이미 만렙인 개체를 다시 먹여도 축전 신호는 반복되지 않는다.
    let alreadyMax = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: [], generator: &generator)
    XCTAssertNil(alreadyMax.reachedMaximumLevelCreatureID)
  }

  func testDeferredEvolutionFeedStillReportsMaximumLevelCrossing() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: 49, experience: 4_899,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 1

    var generator = SystemRandomNumberGenerator()
    let outcome = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: [], generator: &generator,
      deferringEvolution: true)

    XCTAssertTrue(outcome.evolutions.isEmpty)
    XCTAssertEqual(outcome.reachedMaximumLevelCreatureID, creature.id)
    XCTAssertEqual(state.ownedCreatures[0].level, GameState.maximumCreatureLevel)
  }

  func testFeedBelowMaximumLevelDoesNotReportMaximumLevel() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-999", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    var generator = SystemRandomNumberGenerator()
    let outcome = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: [], generator: &generator)

    XCTAssertNil(outcome.reachedMaximumLevelCreatureID)
  }

  func testEvolutionResolutionPrefersCategoryThenStableID() throws {
    let start = testSpecies(id: "PG-001", stage: 1, category: "start", lineageId: "PG-L001")
    let branch = testSpecies(
      id: "PG-010", stage: 2, category: "branch", evolutionFrom: ["PG-L001:S1"])
    let normalB = testSpecies(
      id: "PG-009", stage: 2, category: "normal_evolution", evolutionFrom: ["PG-001"])
    let normalA = testSpecies(
      id: "PG-008", stage: 2, category: "normal_evolution", evolutionFrom: ["PG-001"])
    let mutant = testSpecies(
      id: "PG-011", stage: 2, category: "mutant", evolutionFrom: ["PG-001"])
    let mixed = testSpecies(
      id: "PG-012", stage: 2, category: "mixed", evolutionFrom: ["PG-001"])
    let catalog = [branch, mutant, mixed, normalB, start, normalA]

    XCTAssertEqual(
      EvolutionCatalog.candidates(after: start, in: catalog).map(\.id),
      ["PG-008", "PG-009", "PG-010", "PG-012", "PG-011"])
    XCTAssertEqual(
      EvolutionCatalog.lineageCandidates(after: start, in: catalog).map(\.id),
      ["PG-008", "PG-009", "PG-010", "PG-011"])
    XCTAssertEqual(
      EvolutionCatalog.selectableCandidates(after: start, in: catalog).map(\.id),
      ["PG-008", "PG-009", "PG-010"])
    XCTAssertEqual(EvolutionCatalog.mutationCandidate(after: start, in: catalog)?.id, "PG-011")
    XCTAssertTrue(EvolutionCatalog.lineageCandidates(after: mixed, in: catalog).isEmpty)
  }

  func testStageOneBranchStopsEvolutionAndReportsPendingChoice() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002", level: 14, experience: 1_390,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    let chain = try GameEngine.feedLarge(creatureID: creature.id, state: &state, catalog: catalog)

    XCTAssertTrue(chain.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-002")
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
    let pending = try XCTUnwrap(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertEqual(pending.candidates.map(\.id), ["PG-062", "PG-182"])
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-062"))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-182"))
  }

  func testMixedSpeciesCanNeverBecomePendingExplicitOrAutomaticEvolutionTargets() throws {
    let start = testSpecies(
      id: "PG-Q01", stage: 1, category: "start", lineageId: "PG-Q")
    let normal = testSpecies(
      id: "PG-Q02", stage: 2, category: "normal_evolution", lineageId: "PG-Q",
      rarity: "AGENT", evolutionFrom: [start.id])
    let mixed = testSpecies(
      id: "PG-Q99", stage: 2, category: "mixed", lineageId: "PG-QX",
      rarity: "ORIGIN", evolutionFrom: [start.id])
    let catalog = [start, normal, mixed]
    let creature = OwnedCreature(
      id: UUID(), speciesID: start.id, originSpeciesID: start.id,
      level: 15, experience: 0, affection: 0, nickname: nil,
      uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    XCTAssertNil(GameEngine.pendingEvolutionChoice(for: creature, catalog: catalog))
    XCTAssertEqual(EvolutionCatalog.automaticPath(from: start, in: catalog).map(\.id), [
      start.id, normal.id,
    ])
    XCTAssertEqual(EvolutionCatalog.maxReachablePath(from: start, in: catalog).map(\.id), [
      start.id, normal.id,
    ])
    XCTAssertEqual(GameEngine.lineageSpeciesIDs(forOrigin: start.id, catalog: catalog), [
      start.id, normal.id,
    ])
    XCTAssertThrowsError(try GameEngine.chooseEvolution(
      creatureID: creature.id,
      toSpeciesID: mixed.id,
      state: &state,
      catalog: catalog
    )) { XCTAssertEqual($0 as? GameError, .invalidEvolutionChoice) }

    let evolutions = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: catalog)
    XCTAssertEqual(evolutions.map(\.toSpeciesID), [normal.id])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, normal.id)
    XCTAssertFalse(state.discoveredSpeciesIDs.contains(mixed.id))
  }

  func testMutationCandidateNeverCreatesAPendingChoice() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 14, experience: 1_390,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    let start = try XCTUnwrap(catalog.first { $0.id == "PG-001" })
    XCTAssertEqual(
      EvolutionCatalog.candidates(after: start, in: catalog).map(\.id), ["PG-061", "PG-216"])
    XCTAssertEqual(EvolutionCatalog.mutationCandidate(after: start, in: catalog)?.id, "PG-216")

    var generator = SeededGenerator(seed: mutationFreeSeed)
    let outcome = try GameEngine.feedLarge(
      creatureID: creature.id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(outcome.mutationOffer)
    let chain = outcome.evolutions

    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-061"])
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))

    let startsWithMutation = catalog.filter {
      $0.category == "start" && $0.stage == 1
        && EvolutionCatalog.mutationCandidate(after: $0, in: catalog) != nil
    }
    XCTAssertEqual(startsWithMutation.count, 25)
    XCTAssertEqual(
      startsWithMutation.filter {
        EvolutionCatalog.selectableCandidates(after: $0, in: catalog).count == 1
      }.count, 19)
  }




  func testChooseEvolutionFailsAtomicallyForUnknownLowLevelAndNonCandidateTargets() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-117", originSpeciesID: "PG-034", level: 25, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    let before = state

    XCTAssertThrowsError(
      try GameEngine.chooseEvolution(
        creatureID: UUID(), toSpeciesID: "PG-118", state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .creatureNotFound) }
    XCTAssertEqual(state, before)

    XCTAssertThrowsError(
      try GameEngine.chooseEvolution(
        creatureID: creature.id, toSpeciesID: "PG-205", state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .invalidEvolutionChoice) }
    XCTAssertEqual(state, before)

    state.ownedCreatures[0].level = 24
    let belowLevel = state
    XCTAssertThrowsError(
      try GameEngine.chooseEvolution(
        creatureID: creature.id, toSpeciesID: "PG-118", state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .invalidEvolutionChoice) }
    XCTAssertEqual(state, belowLevel)
  }



  func testMaximumLevelPendingChoiceBlocksFeedingWithoutConsumingFood() throws {
    let catalog = try CreatureCatalog.load()
    let waiting = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002",
      level: GameState.maximumCreatureLevel, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [waiting]
    state.inventory.largeFood = 1
    let before = state

    state.inventory.extraLargeFood = 1
    let beforeExtraLarge = state
    XCTAssertThrowsError(
      try GameEngine.feedExtraLarge(creatureID: waiting.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .evolutionChoiceRequired) }
    XCTAssertEqual(state, beforeExtraLarge)
    state.inventory.extraLargeFood = 0
    XCTAssertThrowsError(
      try GameEngine.feedLarge(creatureID: waiting.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .evolutionChoiceRequired) }
    XCTAssertEqual(state, before)

    state.ownedCreatures[0].level = 25
    _ = try GameEngine.feedLarge(creatureID: waiting.id, state: &state, catalog: catalog)
    XCTAssertEqual(state.inventory.largeFood, 0)
    XCTAssertEqual(state.ownedCreatures[0].experience, 200)
  }

  func testProductionCatalogSplitsStartSpeciesIntoNoChoiceAndTwoBranchTiers() throws {
    let catalog = try CreatureCatalog.load()
    let starts = catalog.filter { $0.category == "start" && $0.stage == 1 }
    var noChoice = 0
    var choiceAtStageOne = 0
    var choiceAtStageTwo = 0
    var choiceBeyondStageTwo = 0

    for start in starts {
      var current = start
      var visited: Set<String> = [start.id]
      var branchStage: Int?
      while current.stage < 4 {
        let selectable = EvolutionCatalog.selectableCandidates(after: current, in: catalog)
        if selectable.count > 1 {
          branchStage = current.stage
          break
        }
        guard let next = selectable.first, visited.insert(next.id).inserted else { break }
        current = next
      }
      switch branchStage {
      case .none: noChoice += 1
      case .some(1): choiceAtStageOne += 1
      case .some(2): choiceAtStageTwo += 1
      default: choiceBeyondStageTwo += 1
      }
    }

    XCTAssertEqual(starts.count, 64)
    XCTAssertEqual(noChoice, 51)
    XCTAssertEqual(choiceAtStageOne, 6)
    XCTAssertEqual(choiceAtStageTwo, 7)
    XCTAssertEqual(choiceBeyondStageTwo, 0)
    XCTAssertEqual(
      catalog.map { EvolutionCatalog.selectableCandidates(after: $0, in: catalog).count }.max(), 2)
  }

  func testMissingSpeciesOrCandidateStillFeedsNormally() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-404", level: 14, experience: 1_390,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    let chain = try GameEngine.feedLarge(creatureID: creature.id, state: &state, catalog: [])

    XCTAssertTrue(chain.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
  }

  @MainActor
  func testStorePublishesEvolutionFeedbackAfterPersistenceAndClearsByIdentity() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-041", level: 40, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)

    store.feedLargeCurrent()

    let feedback = try XCTUnwrap(store.evolutionFeedback)
    XCTAssertEqual(feedback.fromSpeciesID, "PG-041")
    XCTAssertEqual(feedback.toSpeciesID, "PG-211")
    XCTAssertEqual(feedback.stagesCrossed, 3)
    store.clearEvolutionFeedback(id: UUID())
    XCTAssertEqual(store.evolutionFeedback, feedback)
    store.clearEvolutionFeedback(id: feedback.id)
    XCTAssertNil(store.evolutionFeedback)
  }

  func testDisplayFormAcceptsReachedSpeciesAndRejectsOtherLineages() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-215", originSpeciesID: "PG-045", level: 40, experience: 123,
      affection: 50, nickname: "테스트", uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    // 발견 목록 일부가 빠져 있어도 실제 경로는 현재 종에서 복원한다.
    state.discoveredSpeciesIDs = ["PG-045", "PG-142", "PG-215"]

    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(for: creature, catalog: catalog),
      ["PG-045", "PG-142", "PG-163", "PG-215"])

    XCTAssertEqual(
      GameEngine.displaySpecies(for: state.ownedCreatures[0], catalog: catalog)?.id, "PG-215")

    try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: "PG-045", state: &state, catalog: catalog)
    XCTAssertEqual(
      GameEngine.displaySpecies(for: state.ownedCreatures[0], catalog: catalog)?.id, "PG-045")

    // 표시만 바꾼다. 성장과 종은 그대로여야 한다.
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-215")
    XCTAssertEqual(state.ownedCreatures[0].level, 40)
    XCTAssertEqual(state.ownedCreatures[0].experience, 123)

    // 다른 계보의 종은 받지 않는다.
    XCTAssertThrowsError(try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: "PG-001", state: &state, catalog: catalog))
    XCTAssertEqual(state.ownedCreatures[0].displaySpeciesID, "PG-045")
  }

  func testDisplayFormAcceptsOnlyReachedEvolutionForms() throws {
    let root = testSpecies(id: "PG-R01", stage: 1, category: "start")
    let reachedStageTwo = testSpecies(
      id: "PG-R02", stage: 2, category: "normal_evolution", evolutionFrom: [root.id])
    let siblingStageTwo = testSpecies(
      id: "PG-R12", stage: 2, category: "branch", evolutionFrom: [root.id])
    let futureStageThree = testSpecies(
      id: "PG-R03", stage: 3, category: "normal_evolution",
      evolutionFrom: [reachedStageTwo.id])
    let catalog = [root, reachedStageTwo, siblingStageTwo, futureStageThree]
    let creature = OwnedCreature(
      id: UUID(), speciesID: reachedStageTwo.id, originSpeciesID: root.id, level: 15,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.discoveredSpeciesIDs = Set(catalog.map(\.id))

    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(for: creature, catalog: catalog),
      [root.id, reachedStageTwo.id])

    try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: root.id, state: &state, catalog: catalog)
    XCTAssertEqual(state.ownedCreatures[0].displaySpeciesID, root.id)

    XCTAssertThrowsError(try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: siblingStageTwo.id,
      state: &state, catalog: catalog))
    XCTAssertThrowsError(try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: futureStageThree.id,
      state: &state, catalog: catalog))
    XCTAssertEqual(state.ownedCreatures[0].displaySpeciesID, root.id)

    // 예전 버전에서 저장된 미래 고정값도 읽을 때 실제 현재 모습으로 안전하게 되돌린다.
    state.ownedCreatures[0].displaySpeciesID = futureStageThree.id
    XCTAssertEqual(
      GameEngine.displaySpecies(for: state.ownedCreatures[0], catalog: catalog)?.id,
      reachedStageTwo.id)
  }

  func testReachedEvolutionFormsTreatEveryExistingMixedCreatureAsStandalone() throws {
    let rootA = testSpecies(id: "PG-M01", stage: 1, category: "start", lineageId: "PG-MA")
    let rootB = testSpecies(id: "PG-M02", stage: 1, category: "start", lineageId: "PG-MB")
    let wrongRoot = testSpecies(
      id: "PG-M03", stage: 1, category: "start", lineageId: "PG-MC")
    let stageTwoA = testSpecies(
      id: "PG-M11", stage: 2, category: "normal_evolution", lineageId: "PG-MA",
      evolutionFrom: [rootA.id])
    let stageTwoB = testSpecies(
      id: "PG-M12", stage: 2, category: "normal_evolution", lineageId: "PG-MB",
      evolutionFrom: [rootB.id])
    let mixed = testSpecies(
      id: "PG-M20", stage: 3, category: "mixed", lineageId: "PG-MIX",
      evolutionFrom: [stageTwoA.id, stageTwoB.id])
    let catalog = [rootA, rootB, wrongRoot, stageTwoA, stageTwoB, mixed]
    let creatureID = UUID()
    let legacyMixed = OwnedCreature(
      id: creatureID, speciesID: mixed.id, originSpeciesID: nil, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let explicitA = OwnedCreature(
      id: UUID(), speciesID: mixed.id, originSpeciesID: rootA.id, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let badOrigin = OwnedCreature(
      id: creatureID, speciesID: mixed.id, originSpeciesID: wrongRoot.id, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(for: legacyMixed, catalog: catalog),
      [mixed.id])
    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(for: explicitA, catalog: catalog),
      [mixed.id])
    XCTAssertEqual(
      GameEngine.reachedEvolutionSpeciesIDs(for: badOrigin, catalog: catalog),
      [mixed.id])

    var state = GameState()
    state.ownedCreatures = [badOrigin]
    state.discoveredSpeciesIDs = [wrongRoot.id, mixed.id]
    XCTAssertThrowsError(try GameEngine.setDisplayForm(
      creatureID: creatureID,
      toSpeciesID: wrongRoot.id,
      state: &state,
      catalog: catalog))

    state.tokenBalance = max(GameState.inheritCost, GameState.mutationRetryCost)
    XCTAssertThrowsError(try GameEngine.inherit(
      fromCreatureID: creatureID, state: &state, catalog: catalog
    )) { XCTAssertEqual($0 as? GameError, .creatureActionUnavailable) }
    var generator = SeededGenerator(seed: 1)
    XCTAssertThrowsError(try GameEngine.retryMutation(
      fromCreatureID: creatureID,
      state: &state,
      catalog: catalog,
      generator: &generator
    )) { XCTAssertEqual($0 as? GameError, .creatureActionUnavailable) }
  }

  func testDisplayFormAcceptsReachedPastFormWithoutDiscoveryRecordAndClearsOnActualSpecies()
    throws
  {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-215", originSpeciesID: "PG-045", level: 40, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let reachedPast = try XCTUnwrap(
      GameEngine.reachedEvolutionSpeciesIDs(for: creature, catalog: catalog)
        .subtracting(["PG-045", "PG-215"])
        .sorted()
        .first)
    var state = GameState()
    state.ownedCreatures = [creature]
    // 과거 세이브의 발견 목록이 누락됐더라도 실제 현재 종까지의 경로가 보유 증거다.
    state.discoveredSpeciesIDs = ["PG-045", "PG-215"]

    try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: reachedPast, state: &state, catalog: catalog)
    XCTAssertEqual(state.ownedCreatures[0].displaySpeciesID, reachedPast)

    try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: "PG-045", state: &state, catalog: catalog)
    // 실제 종을 다시 지정하면 고정이 풀린다.
    try GameEngine.setDisplayForm(
      creatureID: creature.id, toSpeciesID: "PG-215", state: &state, catalog: catalog)
    XCTAssertNil(state.ownedCreatures[0].displaySpeciesID)
  }

  func testSavesWithoutTheDisplayFormKeyStillDecode() throws {
    let json = """
    {"id":"\(UUID().uuidString)","speciesID":"PG-215","level":40,"experience":0,
     "affection":0,"uniqueColor":false,"acquiredAt":0}
    """
    let decoded = try JSONDecoder().decode(OwnedCreature.self, from: Data(json.utf8))
    XCTAssertNil(decoded.displaySpeciesID)
    XCTAssertEqual(decoded.speciesID, "PG-215")
  }

  @MainActor
  func testLargeFeedReturnsFalseAndChangesNothingWhenPersistenceFails() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let stateDirectory = directory.appending(path: "state")
    let stateURL = stateDirectory.appending(path: "state.json")
    let persistence = GamePersistence(fileURL: stateURL)
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-034", level: 40, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)
    let before = store.state
    try FileManager.default.removeItem(at: stateDirectory)
    try Data("blocked".utf8).write(to: stateDirectory)

    let succeeded = store.feedLargeCurrent()

    XCTAssertFalse(succeeded)
    XCTAssertEqual(store.state, before)
    XCTAssertNil(store.evolutionFeedback)
  }

  @MainActor
  func testExtraLargeFeedReturnsFalseAndChangesNothingWhenPersistenceFails() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let stateDirectory = directory.appending(path: "state")
    let persistence = GamePersistence(fileURL: stateDirectory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-034", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.extraLargeFood = 1
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)
    let before = store.state
    try FileManager.default.removeItem(at: stateDirectory)
    try Data("blocked".utf8).write(to: stateDirectory)

    let succeeded = store.feedExtraLargeCurrent()

    XCTAssertFalse(succeeded)
    XCTAssertEqual(store.state, before)
  }

  @MainActor
  func testLargePurchaseReturnsFalseAndChangesNothingWhenPersistenceFails() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let stateDirectory = directory.appending(path: "state")
    let persistence = GamePersistence(fileURL: stateDirectory.appending(path: "state.json"))
    var initial = GameState()
    initial.tokenBalance = GameState.largeFoodCost
    initial.inventory.largeFood = 0
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)
    let before = store.state
    try FileManager.default.removeItem(at: stateDirectory)
    try Data("blocked".utf8).write(to: stateDirectory)

    let succeeded = store.purchaseLargeFood()

    XCTAssertFalse(succeeded)
    XCTAssertEqual(store.state, before)
  }

  @MainActor
  func testExtraLargePurchaseReturnsFalseAndChangesNothingWhenPersistenceFails() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let stateDirectory = directory.appending(path: "state")
    let persistence = GamePersistence(fileURL: stateDirectory.appending(path: "state.json"))
    var initial = GameState()
    initial.tokenBalance = GameState.extraLargeFoodCost
    initial.inventory.extraLargeFood = 0
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)
    let before = store.state
    try FileManager.default.removeItem(at: stateDirectory)
    try Data("blocked".utf8).write(to: stateDirectory)

    let succeeded = store.purchaseExtraLargeFood()

    XCTAssertFalse(succeeded)
    XCTAssertEqual(store.state, before)
  }

  @MainActor
  func testUnconfirmedRepeatSavePublishesCommittedStateThenLocksFurtherMutations() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.largeFood = 2
    try persistence.save(initial)
    let writer = ControlledGameStatePersistenceWriter()
    let store = GameStore(
      persistence: persistence, repeatPersistenceWriter: writer)

    let repeatTask = Task { await store.feedLargeCurrentForRepeat() }
    let becamePending = await writer.waitUntilSaveIsPending()
    XCTAssertTrue(becamePending)
    await writer.complete(
      with: .saved(.directorySyncUnconfirmed(errorCode: EIO)))
    let succeeded = await repeatTask.value
    XCTAssertTrue(succeeded)

    XCTAssertEqual(store.state.inventory.largeFood, 1)
    XCTAssertTrue(store.isPersistenceLocked)
    XCTAssertTrue(store.errorMessage?.contains("디스크 동기화를 확인하지 못했습니다") == true)
    let additionalMutationSucceeded = await store.feedLargeCurrentForRepeat()
    let saveCount = await writer.saveCount
    XCTAssertFalse(additionalMutationSucceeded)
    XCTAssertEqual(store.state.inventory.largeFood, 1)
    XCTAssertEqual(saveCount, 1)
  }

  @MainActor
  func testDelayedRepeatSaveKeepsMainActorResponsiveAndPublishesExactlyOnce() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.largeFood = 2
    try persistence.save(initial)
    let writer = ControlledGameStatePersistenceWriter()
    let store = GameStore(
      persistence: persistence, repeatPersistenceWriter: writer)

    let repeatTask = Task { await store.feedLargeCurrentForRepeat() }
    let becamePending = await writer.waitUntilSaveIsPending()
    XCTAssertTrue(becamePending)
    store.showActionNotice("main actor responsive")

    XCTAssertEqual(store.actionNotice?.message, "main actor responsive")
    XCTAssertEqual(store.state.inventory.largeFood, 2)

    await writer.complete(with: .saved(.confirmed))
    let succeeded = await repeatTask.value
    let saveCount = await writer.saveCount
    XCTAssertTrue(succeeded)

    XCTAssertEqual(store.state.inventory.largeFood, 1)
    XCTAssertEqual(saveCount, 1)
  }

  @MainActor
  func testFailedDelayedRepeatSaveLeavesStateUnchangedAndReturnsFalse() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.largeFood = 2
    try persistence.save(initial)
    let writer = ControlledGameStatePersistenceWriter()
    let store = GameStore(
      persistence: persistence, repeatPersistenceWriter: writer)
    let before = store.state

    let repeatTask = Task { await store.feedLargeCurrentForRepeat() }
    let becamePending = await writer.waitUntilSaveIsPending()
    XCTAssertTrue(becamePending)
    store.showActionNotice("still responsive")
    await writer.complete(with: .failed(message: "save failed"))

    let succeeded = await repeatTask.value
    let saveCount = await writer.saveCount
    XCTAssertFalse(succeeded)
    XCTAssertEqual(store.state, before)
    XCTAssertEqual(store.actionNotice?.message, "still responsive")
    XCTAssertEqual(store.errorMessage, "save failed")
    XCTAssertEqual(saveCount, 1)
  }

  @MainActor
  func testRestoreIsRejectedWhileRepeatSaveIsInFlightAndCommittedStateMatchesDisk() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let backup = directory.appending(path: "restore.pgrow")
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.largeFood = 2
    initial.tokenBalance = 2_000_000
    try persistence.save(initial)
    var backupState = initial
    backupState.inventory.largeFood = 9
    backupState.tokenBalance = 9_000_000
    try persistence.export(backupState, to: backup)
    let writer = ControlledGameStatePersistenceWriter()
    let store = GameStore(
      persistence: persistence, repeatPersistenceWriter: writer)

    let repeatTask = Task { await store.feedLargeCurrentForRepeat() }
    let becamePending = await writer.waitUntilSaveIsPending()
    XCTAssertTrue(becamePending)

    store.restoreBackup(from: backup)

    XCTAssertEqual(store.errorMessage, GameStore.persistenceBusyActionMessage)
    XCTAssertEqual(store.state, initial)
    XCTAssertEqual(try persistence.load(), initial)

    await writer.completeBySaving(to: persistence)
    let repeatSucceeded = await repeatTask.value

    XCTAssertTrue(repeatSucceeded)
    XCTAssertEqual(store.state.inventory.largeFood, 1)
    XCTAssertEqual(store.state.tokenBalance, initial.tokenBalance)
    XCTAssertEqual(try persistence.load(), store.state)
  }

  @MainActor
  func testExportIsRejectedWhileRepeatSaveIsInFlight() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let exportURL = directory.appending(path: "busy-export.pgrow")
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var initial = GameState()
    initial.ownedCreatures = [creature]
    initial.discoveredSpeciesIDs = [creature.speciesID]
    initial.inventory.largeFood = 2
    try persistence.save(initial)
    let writer = ControlledGameStatePersistenceWriter()
    let store = GameStore(
      persistence: persistence, repeatPersistenceWriter: writer)

    let repeatTask = Task { await store.feedLargeCurrentForRepeat() }
    let becamePending = await writer.waitUntilSaveIsPending()
    XCTAssertTrue(becamePending)

    store.exportBackup(to: exportURL)

    XCTAssertEqual(store.errorMessage, GameStore.persistenceBusyActionMessage)
    XCTAssertFalse(FileManager.default.fileExists(atPath: exportURL.path))

    await writer.completeBySaving(to: persistence)
    let repeatSucceeded = await repeatTask.value
    XCTAssertTrue(repeatSucceeded)
  }

  func testExtraLargeFoodPurchaseSpendsTwoPointFiveMillionTokensAndAddsOneFood() throws {
    var state = GameState()
    state.tokenBalance = 2_500_000
    state.inventory.extraLargeFood = 0

    try GameEngine.purchaseExtraLargeFood(state: &state)

    XCTAssertEqual(state.tokenBalance, 0)
    XCTAssertEqual(state.inventory.extraLargeFood, 1)
  }

  func testExtraLargeFoodPurchaseFailsAtomicallyWhenTokensAreInsufficient() {
    var state = GameState()
    state.tokenBalance = GameState.extraLargeFoodCost - 1
    state.inventory.extraLargeFood = 2
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseExtraLargeFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .insufficientTokens)
    }
    XCTAssertEqual(state, before)
  }

  func testExtraLargeFoodPurchaseRejectsInventoryOverflowWithoutSpendingTokens() {
    var state = GameState()
    state.tokenBalance = GameState.extraLargeFoodCost
    state.inventory.extraLargeFood = Int.max
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseExtraLargeFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .inventoryFull)
    }
    XCTAssertEqual(state, before)
  }

  func testBackupRejectsUnexpectedFormat() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appending(path: "bad.pgrow")
    try Data("{}".utf8).write(to: file)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    XCTAssertThrowsError(try persistence.restore(from: file))
  }

  func testSchemaOneBackupEnvelopeRestoresThroughLegacyMigrationAndConvertsFood() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let backup = directory.appending(path: "legacy.pgrow")
    let json = """
      {"format":"punchgrow-backup-v1","exportedAt":"2026-07-31T00:00:00Z","state":{
      "schemaVersion":1,"tokenBalance":1000000,"usageEvents":[],"ownedCreatures":[],
      "discoveredSpeciesIDs":[],"inventory":{"food":7,"trainingTools":1,
      "evolutionMaterials":0},"pullsSinceOrigin":0,"representativeCreatureID":null}}
      """
    try Data(json.utf8).write(to: backup)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))

    let restored = try persistence.restore(from: backup)

    XCTAssertEqual(restored.schemaVersion, GameState.schemaVersion)
    XCTAssertEqual(restored.inventory.largeFood, 1)
    XCTAssertEqual(restored.inventory.extraLargeFood, 0)
    XCTAssertEqual(restored.tokenBalance, 1_200_000)
  }

  func testClaudeDecoderAcceptsOnlyTokenMetric() throws {
    let payload = """
      {"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"claude_code.token.usage","sum":{"dataPoints":[{"attributes":[{"key":"type","value":{"stringValue":"input"}},{"key":"request.id","value":{"stringValue":"req-1"}}],"asInt":"123","timeUnixNano":"1"}]}}]}]}]}
      """
    let events = try ClaudeOTLPDecoder().decode(Data(payload.utf8))
    XCTAssertTrue(events.count == 1)
    XCTAssertTrue(events[0].inputTokens == 123)
    XCTAssertTrue(events[0].sourceEventID.count == 64)
    XCTAssertTrue(!events[0].sourceEventID.contains("req-1"))
  }

  func testCodexSnapshotsProduceOnlyPositiveDeltas() throws {
    var tracker = CodexDeltaTracker()
    let first = CodexTokenSnapshot(
      threadID: "thread-1", inputTokens: 100, cachedTokens: 20, outputTokens: 30)
    let second = CodexTokenSnapshot(
      threadID: "thread-1", inputTokens: 150, cachedTokens: 25, outputTokens: 45)
    let firstEvent = try tracker.event(from: first)
    let secondEvent = try tracker.event(from: second)
    XCTAssertTrue(firstEvent?.totalTokens == 150)
    XCTAssertTrue(secondEvent?.totalTokens == 70)
  }

  func testCodexCacheWritesAreIncludedInCumulativeCachedDelta() throws {
    let firstLine = Data("""
      {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-cache","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":20,"cacheWriteInputTokens":5,"outputTokens":30}}}}
      """.utf8)
    let secondLine = Data("""
      {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-cache","tokenUsage":{"total":{"inputTokens":110,"cachedInputTokens":24,"cacheWriteInputTokens":9,"outputTokens":35}}}}
      """.utf8)
    let decoder = CodexAppServerDecoder()
    var tracker = CodexDeltaTracker()
    let first = try tracker.event(from: XCTUnwrap(try decoder.decode(firstLine)))
    let second = try tracker.event(from: XCTUnwrap(try decoder.decode(secondLine)))

    XCTAssertEqual(first?.cachedTokens, 25)
    XCTAssertEqual(second?.cachedTokens, 8)
    XCTAssertEqual(second?.totalTokens, 23)
  }

  func testCodexDecoderAcceptsCurrentNestedTotalShape() throws {
    let line = """
      {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":20,"outputTokens":30,"reasoningOutputTokens":0,"totalTokens":150},"last":{"inputTokens":100,"cachedInputTokens":20,"outputTokens":30,"reasoningOutputTokens":0,"totalTokens":150}}}}
      """
    let snapshot = try CodexAppServerDecoder().decode(Data(line.utf8))
    XCTAssertTrue(snapshot?.inputTokens == 100)
    XCTAssertTrue(snapshot?.cachedTokens == 20)
    XCTAssertTrue(snapshot?.outputTokens == 30)
  }

  func testCodexCheckpointSurvivesStatePersistence() throws {
    var state = GameState()
    let snapshot = CodexTokenSnapshot(
      threadID: "opaque-thread", inputTokens: 100, cachedTokens: 20, outputTokens: 30)
    try GameEngine.ingestCodexSnapshot(snapshot, into: &state)
    let encoded = try JSONEncoder.punchGrow.encode(state)
    var restored = try JSONDecoder.punchGrow.decode(GameState.self, from: encoded)
    try GameEngine.ingestCodexSnapshot(
      CodexTokenSnapshot(
        threadID: "opaque-thread", inputTokens: 150, cachedTokens: 25, outputTokens: 45),
      into: &restored)
    XCTAssertTrue(restored.lifetimeUsage[.codex] == 220)
  }

  func testCollectorHTTPRequestRequiresExactLength() throws {
    let body = "{\"resourceMetrics\":[]}"
    let raw =
      "POST /v1/metrics HTTP/1.1\r\nAuthorization: Bearer test\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
    let request = try CollectorHTTPRequest.parse(Data(raw.utf8))
    XCTAssertTrue(request.path == "/v1/metrics")
    XCTAssertTrue(request.headers["authorization"] == "Bearer test")
    XCTAssertTrue(request.body == Data(body.utf8))
  }

  func testProtobufClaudeMetricDecodes() throws {
    let typeAttribute = protoMessageField(
      7, protoStringField(1, "type") + protoMessageField(2, protoStringField(1, "input")))
    let point = typeAttribute + protoFixed64Field(3, 42) + protoFixed64Field(6, 321)
    let metric =
      protoStringField(1, ClaudeOTLPDecoder.allowedMetric)
      + protoMessageField(7, protoMessageField(1, point))
    let scope = protoMessageField(2, metric)
    let resource = protoMessageField(2, scope)
    let payload = protoMessageField(1, resource)
    let events = try ClaudeOTLPDecoder().decodeProtobuf(payload)
    XCTAssertTrue(events.count == 1)
    XCTAssertTrue(events[0].inputTokens == 321)
  }

  func testValidationRejectsNegativeExtraLargeFoodInventory() throws {
    var state = GameState()
    state.inventory.extraLargeFood = -1
    XCTAssertThrowsError(try state.validate()) { error in
      XCTAssertEqual(error as? GameError, .invalidBackup)
    }
  }

  @MainActor
  func testSchemaTwoMigrationConvertsFiveToOneAndRefundsEachRemainderExactlyOnce() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "state.json")
    let json = """
      {"schemaVersion":2,"tokenBalance":1000000,"usageEvents":[],"creditedUsageEventKeys":[],
      "lifetimeUsage":{},"codexCheckpoints":{},"ownedCreatures":[],"discoveredSpeciesIDs":[],
      "inventory":{"food":12,"largeFood":3,"trainingTools":1,"evolutionMaterials":0},
      "pullsSinceOrigin":0,"representativeCreatureID":null}
      """
    try Data(json.utf8).write(to: file)
    let persistence = GamePersistence(fileURL: file)

    let migrated = GameStore(persistence: persistence, catalog: [])
    XCTAssertEqual(migrated.state.schemaVersion, GameState.schemaVersion)
    XCTAssertEqual(migrated.state.inventory.largeFood, 5)
    XCTAssertEqual(migrated.state.inventory.extraLargeFood, 0)
    XCTAssertEqual(migrated.state.tokenBalance, 1_200_000)

    let relaunched = GameStore(persistence: persistence, catalog: [])
    XCTAssertEqual(relaunched.state.inventory.largeFood, 5)
    XCTAssertEqual(relaunched.state.tokenBalance, 1_200_000)
  }

  func testCurrentSchemaEncodingOmitsTheRemovedFoodKey() throws {
    let data = try JSONEncoder.punchGrow.encode(GameState())
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let inventory = try XCTUnwrap(root["inventory"] as? [String: Any])

    XCTAssertNil(inventory["food"])
    XCTAssertEqual(inventory["largeFood"] as? Int, 1)
    XCTAssertEqual(inventory["extraLargeFood"] as? Int, 0)
  }

  func testVersionOneStateMigratesAtomically() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appending(path: "state.json")
    let eventID = UUID()
    let creatureID = UUID()
    let json = """
      {"schemaVersion":1,"tokenBalance":2000010,"usageEvents":[{"id":"\(eventID.uuidString)","provider":"claude","sourceEventID":"legacy-event","occurredAt":"2026-07-31T00:00:00Z","inputTokens":10,"cachedTokens":0,"outputTokens":0}],"ownedCreatures":[{"id":"\(creatureID.uuidString)","speciesID":"PG-001","level":1,"experience":0,"affection":0,"nickname":null,"acquiredAt":"2026-07-31T00:00:00Z"}],"discoveredSpeciesIDs":["PG-001"],"inventory":{"food":5,"trainingTools":1,"evolutionMaterials":0},"pullsSinceOrigin":0,"representativeCreatureID":"\(creatureID.uuidString)"}
      """
    try Data(json.utf8).write(to: file)
    let state = try GamePersistence(fileURL: file).load()
    XCTAssertTrue(state.schemaVersion == GameState.schemaVersion)
    XCTAssertTrue(state.ownedCreatures[0].uniqueColor == false)
    XCTAssertTrue(state.lifetimeUsage[.claude] == 10)
    XCTAssertTrue(state.creditedUsageEventKeys.contains("claude:legacy-event"))
    XCTAssertEqual(state.inventory.largeFood, 1)
    XCTAssertEqual(state.inventory.extraLargeFood, 0)
  }

  func testVersionOneStateRejectsOversizedUsageBeforeMigration() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appending(path: "state.json")
    let json = """
      {"schemaVersion":1,"tokenBalance":1,"usageEvents":[{"id":"\(UUID().uuidString)","provider":"claude","sourceEventID":"hostile","occurredAt":"2026-07-31T00:00:00Z","inputTokens":9223372036854775807,"cachedTokens":9223372036854775807,"outputTokens":9223372036854775807}],"ownedCreatures":[],"discoveredSpeciesIDs":[],"inventory":{"food":0,"trainingTools":0,"evolutionMaterials":0},"pullsSinceOrigin":0,"representativeCreatureID":null}
      """
    try Data(json.utf8).write(to: file)
    XCTAssertThrowsError(try GamePersistence(fileURL: file).load())
  }

  func testMalformedCodexCheckpointIsRejected() {
    var state = GameState()
    state.codexCheckpoints["bad"] = CodexCheckpoint(
      inputTokens: -1, cachedTokens: 0, outputTokens: 0)
    XCTAssertThrowsError(try state.validate()) { error in
      XCTAssertEqual(error as? GameError, .invalidBackup)
    }
  }

}

private actor ControlledGameStatePersistenceWriter: GameStatePersistenceWriting {
  private var pendingContinuation:
    CheckedContinuation<GameStatePersistenceWriteAttempt, Never>?
  private var pendingState: GameState?
  private(set) var saveCount = 0

  func save(_ state: GameState) async -> GameStatePersistenceWriteAttempt {
    saveCount += 1
    pendingState = state
    return await withCheckedContinuation { continuation in
      pendingContinuation = continuation
    }
  }

  func waitUntilSaveIsPending() async -> Bool {
    for _ in 0..<1_000 {
      if pendingContinuation != nil { return true }
      await Task.yield()
    }
    return pendingContinuation != nil
  }

  func complete(with attempt: GameStatePersistenceWriteAttempt) {
    let continuation = pendingContinuation
    pendingContinuation = nil
    pendingState = nil
    continuation?.resume(returning: attempt)
  }

  func completeBySaving(to persistence: GamePersistence) {
    guard let state = pendingState else { return }
    let attempt: GameStatePersistenceWriteAttempt
    do {
      attempt = .saved(try persistence.save(state))
    } catch {
      attempt = .failed(message: error.localizedDescription)
    }
    complete(with: attempt)
  }
}

private func protoStringField(_ number: UInt64, _ value: String) -> Data {
  protoMessageField(number, Data(value.utf8))
}

private func testSpecies(
  id: String,
  stage: Int,
  category: String,
  lineageId: String = "PG-L001",
  rarity: String = "PROCESS",
  evolutionFrom: [String] = []
) -> CreatureSpecies {
  CreatureSpecies(
    id: id, koName: id, enName: id, lineageId: lineageId, rarity: rarity, stage: stage,
    category: category, bodyForm: "test", identity: "test", lore: "test",
    evolutionFrom: evolutionFrom, imagePath: "test")
}

private func protoMessageField(_ number: UInt64, _ value: Data) -> Data {
  protoVarint(number << 3 | 2) + protoVarint(UInt64(value.count)) + value
}

private func protoFixed64Field(_ number: UInt64, _ value: UInt64) -> Data {
  var littleEndian = value.littleEndian
  return protoVarint(number << 3 | 1) + withUnsafeBytes(of: &littleEndian) { Data($0) }
}

private func protoVarint(_ value: UInt64) -> Data {
  var remaining = value
  var bytes: [UInt8] = []
  repeat {
    var byte = UInt8(remaining & 0x7f)
    remaining >>= 7
    if remaining > 0 { byte |= 0x80 }
    bytes.append(byte)
  } while remaining > 0
  return Data(bytes)
}
