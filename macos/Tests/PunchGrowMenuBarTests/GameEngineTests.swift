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

  func testSeededPullsUseTheExactSixtySpeciesStartPool() throws {
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

    XCTAssertEqual(expected.count, 60)
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
    try GameEngine.feed(creatureID: creature.id, state: &state)
    XCTAssertTrue(state.inventory.food == 4)
    XCTAssertTrue(state.ownedCreatures[0].level == 2)
    XCTAssertTrue(state.ownedCreatures[0].experience == 15)
  }

  func testFoodPurchaseSpendsTokensAndAddsOneFood() throws {
    var state = GameState()
    state.tokenBalance = GameState.foodCost
    state.inventory.food = 0

    try GameEngine.purchaseFood(state: &state)

    XCTAssertEqual(state.tokenBalance, 0)
    XCTAssertEqual(state.inventory.food, 1)
  }

  func testFoodPurchaseFailsAtomicallyWhenTokensAreInsufficient() {
    var state = GameState()
    state.tokenBalance = GameState.foodCost - 1
    state.inventory.food = 2
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .insufficientTokens)
    }
    XCTAssertEqual(state, before)
  }

  func testFoodPurchaseRejectsInventoryOverflowWithoutSpendingTokens() {
    var state = GameState()
    state.tokenBalance = GameState.foodCost
    state.inventory.food = Int.max
    let before = state

    XCTAssertThrowsError(try GameEngine.purchaseFood(state: &state)) { error in
      XCTAssertEqual(error as? GameError, .inventoryFull)
    }
    XCTAssertEqual(state, before)
  }

  func testLargeFoodConsumesSeparateInventoryAndGrantsAcceleratedGrowth() throws {
    var state = GameState()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 90,
      affection: 95, nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 1

    try GameEngine.feedLarge(creatureID: creature.id, state: &state)

    XCTAssertEqual(state.inventory.largeFood, 0)
    XCTAssertEqual(state.ownedCreatures[0].level, 2)
    XCTAssertEqual(state.ownedCreatures[0].experience, 190)
    XCTAssertEqual(state.ownedCreatures[0].affection, 100)
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

    var generator = SeededGenerator(seed: mutationFreeSeed)
    let stageOne = try GameEngine.feed(
      creatureID: id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(stageOne.mutationOffer)
    var chain = stageOne.evolutions
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-117"])
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))

    state.ownedCreatures[0].level = 24
    state.ownedCreatures[0].experience = 2_390
    chain = try GameEngine.feed(creatureID: id, state: &state, catalog: catalog)
    XCTAssertTrue(chain.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-117")
    let pending = try XCTUnwrap(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertEqual(pending.candidates.map(\.id), ["PG-118", "PG-205"])
    chain = try GameEngine.chooseEvolution(
      creatureID: id, toSpeciesID: "PG-118", state: &state, catalog: catalog)
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-118"])
    XCTAssertNil(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID)

    state.ownedCreatures[0].level = 39
    state.ownedCreatures[0].experience = 3_990
    chain = try GameEngine.feed(creatureID: id, state: &state, catalog: catalog)
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

      let chain = try GameEngine.feed(
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
    let outcome = try GameEngine.feed(
      creatureID: creature.id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(outcome.mutationOffer)
    let chain = outcome.evolutions

    XCTAssertEqual(chain.map(\.fromSpeciesID), ["PG-034"])
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-117"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-117")
    XCTAssertEqual(state.ownedCreatures[0].level, 40)
    XCTAssertEqual(state.ownedCreatures[0].experience, 925)
    let pending = try XCTUnwrap(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertEqual(pending.creatureID, creature.id)
    XCTAssertEqual(pending.fromSpecies.id, "PG-117")
    XCTAssertEqual(pending.candidates.map(\.id), ["PG-118", "PG-205"])

    let resumed = try GameEngine.chooseEvolution(
      creatureID: creature.id, toSpeciesID: "PG-118", state: &state, catalog: catalog)

    XCTAssertEqual(resumed.map(\.toSpeciesID), ["PG-118", "PG-119"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-119")
  }

  func testLevelCapAndLegacyAboveCapConsumeFoodGainAffectionAndDiscardXP() throws {
    for level in [50, 51, 100] {
      let creature = OwnedCreature(
        id: UUID(), speciesID: "PG-999", level: level, experience: 123,
        affection: 7, nickname: nil, uniqueColor: false, acquiredAt: .now)
      var state = GameState()
      state.ownedCreatures = [creature]
      let chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: [])
      XCTAssertTrue(chain.isEmpty)
      XCTAssertEqual(state.inventory.food, 4)
      XCTAssertEqual(state.ownedCreatures[0].level, level)
      XCTAssertEqual(state.ownedCreatures[0].experience, 0)
      XCTAssertEqual(state.ownedCreatures[0].affection, 10)
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
    let catalog = [branch, mutant, normalB, start, normalA]

    XCTAssertEqual(
      EvolutionCatalog.candidates(after: start, in: catalog).map(\.id),
      ["PG-008", "PG-009", "PG-010", "PG-011"])
    XCTAssertEqual(
      EvolutionCatalog.selectableCandidates(after: start, in: catalog).map(\.id),
      ["PG-008", "PG-009", "PG-010"])
    XCTAssertEqual(EvolutionCatalog.mutationCandidate(after: start, in: catalog)?.id, "PG-011")
  }

  func testStageOneBranchStopsEvolutionAndReportsPendingChoice() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002", level: 14, experience: 1_390,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    let chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: catalog)

    XCTAssertTrue(chain.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-002")
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
    let pending = try XCTUnwrap(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertEqual(pending.candidates.map(\.id), ["PG-062", "PG-182"])
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-062"))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-182"))
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
    let outcome = try GameEngine.feed(
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
      }.count, 17)
  }

  func testEvolutionPreferenceRejectsMutationTargetsWithoutChangingState() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-034", originSpeciesID: "PG-034", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    let before = state

    XCTAssertThrowsError(
      try GameEngine.setEvolutionPreference(
        creatureID: creature.id, toSpeciesID: "PG-240", state: &state, catalog: catalog)
    ) { error in
      XCTAssertEqual(error as? GameError, .invalidEvolutionChoice)
    }

    XCTAssertEqual(state, before)
    XCTAssertNil(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID)
  }

  func testDescendantPreferenceSurvivesAutomaticStagesAndResolvesAtTheBranch() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-034", originSpeciesID: "PG-034", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.food = 10

    try GameEngine.setEvolutionPreference(
      creatureID: creature.id, toSpeciesID: "PG-205", state: &state, catalog: catalog)
    XCTAssertEqual(
      GameEngine.resolvedPreference(for: state.ownedCreatures[0], catalog: catalog),
      .pendingDescendant)

    state.ownedCreatures[0].level = 14
    state.ownedCreatures[0].experience = 1_390
    var generator = SeededGenerator(seed: mutationFreeSeed)
    let stageOne = try GameEngine.feed(
      creatureID: creature.id, state: &state, catalog: catalog, generator: &generator)
    XCTAssertNil(stageOne.mutationOffer)
    var chain = stageOne.evolutions
    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-117"])
    XCTAssertEqual(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID, "PG-205")
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))

    state.ownedCreatures[0].level = 24
    state.ownedCreatures[0].experience = 2_390
    chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: catalog)

    // PG-205는 종착이라 예약만으로 조용히 성장을 끝내지 않고 진화 직전 확인을 한 번 받는다.
    XCTAssertTrue(chain.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-117")
    XCTAssertEqual(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID, "PG-205")
    let confirmation = try XCTUnwrap(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
    XCTAssertEqual(confirmation.preferredTargetID, "PG-205")

    let confirmed = try GameEngine.chooseEvolution(
      creatureID: creature.id, toSpeciesID: "PG-205", state: &state, catalog: catalog)

    XCTAssertEqual(confirmed.map(\.toSpeciesID), ["PG-205"])
    XCTAssertNil(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID)
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
  }

  func testNonTerminalReservationEvolvesWithoutAnyConfirmationStop() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-117", originSpeciesID: "PG-034", level: 24, experience: 2_390,
      affection: 0, nickname: nil, preferredEvolutionTargetSpeciesID: "PG-118",
      uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.food = 10

    let chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: catalog)

    XCTAssertEqual(chain.map(\.toSpeciesID), ["PG-118"])
    XCTAssertNil(GameEngine.pendingEvolutionChoice(
      for: state.ownedCreatures[0], catalog: catalog))
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
        creatureID: creature.id, toSpeciesID: "PG-119", state: &state, catalog: catalog)
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

  func testInvalidStoredPreferenceWaitsAndIsClearedByTheNextRealMutation() throws {
    let catalog = try CreatureCatalog.load()
    for invalidTarget in ["PG-XXX", "PG-062", "PG-041"] {
      let creature = OwnedCreature(
        id: UUID(), speciesID: "PG-117", originSpeciesID: "PG-034", level: 25, experience: 0,
        affection: 0, nickname: nil, preferredEvolutionTargetSpeciesID: invalidTarget,
        uniqueColor: false, acquiredAt: .now)
      var state = GameState()
      state.ownedCreatures = [creature]

      XCTAssertNoThrow(try state.validate(catalogIDs: Set(catalog.map(\.id))))
      XCTAssertEqual(
        GameEngine.resolvedPreference(for: state.ownedCreatures[0], catalog: catalog), .invalid)
      XCTAssertNotNil(GameEngine.pendingEvolutionChoice(
        for: state.ownedCreatures[0], catalog: catalog))
      XCTAssertEqual(
        state.ownedCreatures[0].preferredEvolutionTargetSpeciesID, invalidTarget)

      let chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: catalog)

      XCTAssertTrue(chain.isEmpty)
      XCTAssertNil(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID)
    }
  }

  func testUnavailableCatalogNeverClearsAStoredPreference() throws {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-117", originSpeciesID: "PG-034", level: 25, experience: 0,
      affection: 0, nickname: nil, preferredEvolutionTargetSpeciesID: "PG-205",
      uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]

    _ = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: [])

    XCTAssertEqual(state.ownedCreatures[0].preferredEvolutionTargetSpeciesID, "PG-205")
  }

  func testMaximumLevelPendingChoiceBlocksFeedingWithoutConsumingFood() throws {
    let catalog = try CreatureCatalog.load()
    let waiting = OwnedCreature(
      id: UUID(), speciesID: "PG-117", originSpeciesID: "PG-034",
      level: GameState.maximumCreatureLevel, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [waiting]
    state.inventory.largeFood = 1
    let before = state

    XCTAssertThrowsError(
      try GameEngine.feed(creatureID: waiting.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .evolutionChoiceRequired) }
    XCTAssertEqual(state, before)
    XCTAssertThrowsError(
      try GameEngine.feedLarge(creatureID: waiting.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .evolutionChoiceRequired) }
    XCTAssertEqual(state, before)

    state.ownedCreatures[0].level = 25
    _ = try GameEngine.feed(creatureID: waiting.id, state: &state, catalog: catalog)
    XCTAssertEqual(state.inventory.food, 4)
    XCTAssertEqual(state.ownedCreatures[0].experience, 25)
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

    XCTAssertEqual(starts.count, 60)
    XCTAssertEqual(noChoice, 32)
    XCTAssertEqual(choiceAtStageOne, 10)
    XCTAssertEqual(choiceAtStageTwo, 18)
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

    let chain = try GameEngine.feed(creatureID: creature.id, state: &state, catalog: [])

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

    store.feedCurrent()

    let feedback = try XCTUnwrap(store.evolutionFeedback)
    XCTAssertEqual(feedback.fromSpeciesID, "PG-041")
    XCTAssertEqual(feedback.toSpeciesID, "PG-211")
    XCTAssertEqual(feedback.stagesCrossed, 3)
    store.clearEvolutionFeedback(id: UUID())
    XCTAssertEqual(store.evolutionFeedback, feedback)
    store.clearEvolutionFeedback(id: feedback.id)
    XCTAssertNil(store.evolutionFeedback)
  }

  @MainActor
  func testStorePersistenceFailureChangesNeitherStateNorFeedback() throws {
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

    store.feedCurrent()

    XCTAssertEqual(store.state, before)
    XCTAssertNil(store.evolutionFeedback)
  }

  func testLargeFoodPurchaseSpendsTokensAndAddsOneLargeFood() throws {
    var state = GameState()
    state.tokenBalance = GameState.largeFoodCost
    state.inventory.largeFood = 0

    try GameEngine.purchaseLargeFood(state: &state)

    XCTAssertEqual(state.tokenBalance, 0)
    XCTAssertEqual(state.inventory.largeFood, 1)
  }

  func testBackupRejectsUnexpectedFormat() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appending(path: "bad.pgrow")
    try Data("{}".utf8).write(to: file)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    XCTAssertThrowsError(try persistence.restore(from: file))
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

  func testRestoreRejectsNegativeInventory() throws {
    var state = GameState()
    state.inventory.food = -1
    XCTAssertThrowsError(try state.validate()) { error in
      XCTAssertEqual(error as? GameError, .invalidBackup)
    }
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
    XCTAssertTrue(state.schemaVersion == 2)
    XCTAssertTrue(state.ownedCreatures[0].uniqueColor == false)
    XCTAssertTrue(state.lifetimeUsage[.claude] == 10)
    XCTAssertTrue(state.creditedUsageEventKeys.contains("claude:legacy-event"))
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
