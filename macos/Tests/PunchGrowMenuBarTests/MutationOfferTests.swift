import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// US-4. 진화 순간 변이 확률 발동.
///
/// 확률이 걸린 계약이므로 모든 판정은 주입된 `SeededGenerator`로만 본다. 시드는 하드코딩하지
/// 않고 `Double.random(in: 0..<1)` 첫 값으로 찾아, 상수(`mutationTriggerRate`)를 조정해도
/// 테스트가 따라오게 한다.
final class MutationOfferTests: XCTestCase {

  // MARK: - 시드

  private static func firstRoll(seed: UInt64) -> Double {
    var generator = SeededGenerator(seed: seed)
    return Double.random(in: 0..<1, using: &generator)
  }

  /// 첫 판정이 발동하는 시드.
  private lazy var triggerSeed: UInt64 = {
    (1...20_000).first { Self.firstRoll(seed: UInt64($0)) < GameState.mutationTriggerRate }
      .map(UInt64.init)!
  }()

  /// 첫 판정이 발동하지 않는 시드.
  private lazy var calmSeed: UInt64 = {
    (1...20_000).first { Self.firstRoll(seed: UInt64($0)) >= GameState.mutationTriggerRate }
      .map(UInt64.init)!
  }()

  // MARK: - 도우미

  private func creature(
    _ speciesID: String,
    level: Int,
    experience: Int = 0,
    origin: String? = nil,
    id: UUID = UUID()
  ) -> OwnedCreature {
    OwnedCreature(
      id: id, speciesID: speciesID, originSpeciesID: origin, level: level,
      experience: experience, affection: 0, nickname: nil,
      uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1))
  }

  private func state(with creatures: [OwnedCreature], largeFood: Int = 30) -> GameState {
    var state = GameState()
    state.ownedCreatures = creatures
    state.inventory.largeFood = largeFood
    return state
  }

  /// 연쇄 진화 제어 흐름을 실제 카탈로그 구성과 분리해 고정하는 최소 테스트 계보.
  /// 시작종에는 일반·변이 후보가 있고, 일반 2단계 뒤에는 사용자가 고를 두 후보가 있다.
  private func branchingMutationCatalog() -> (
    catalog: [CreatureSpecies], root: CreatureSpecies, normal: CreatureSpecies,
    mutant: CreatureSpecies, branches: [CreatureSpecies]
  ) {
    func species(
      _ id: String, stage: Int, category: String, evolutionFrom: [String] = []
    ) -> CreatureSpecies {
      CreatureSpecies(
        id: id, koName: id, enName: id, lineageId: "TEST-MUTATION",
        rarity: "PROCESS", stage: stage, category: category, bodyForm: "test",
        identity: "test", lore: "test", evolutionFrom: evolutionFrom, imagePath: "test")
    }

    let root = species("TEST-ROOT", stage: 1, category: "start")
    let normal = species(
      "TEST-NORMAL", stage: 2, category: "normal_evolution", evolutionFrom: [root.id])
    let mutant = species(
      "TEST-MUTANT", stage: 2, category: "mutant", evolutionFrom: [root.id])
    let branches = [
      species(
        "TEST-BRANCH-A", stage: 3, category: "normal_evolution",
        evolutionFrom: [normal.id]),
      species(
        "TEST-BRANCH-B", stage: 3, category: "branch", evolutionFrom: [normal.id]),
    ]
    return ([root, normal, mutant] + branches, root, normal, mutant, branches)
  }

  /// 난수원이 전혀 소비되지 않았는지 본다. 소비됐다면 다음 값이 새 난수원의 첫 값과 다르다.
  private func assertUntouched(
    _ generator: inout SeededGenerator,
    seed: UInt64,
    _ message: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    var fresh = SeededGenerator(seed: seed)
    XCTAssertEqual(generator.next(), fresh.next(), message, file: file, line: line)
  }

  // MARK: - 상수

  func testBalanceNumbersLiveInASingleNamedPlace() {
    XCTAssertEqual(GameState.mutationTriggerRate, 0.1)
    XCTAssertEqual(GameState.mutationRetryCost, 1_000_000)
    XCTAssertEqual(GameState.mutationRetryPityThreshold, 30)
  }

  // MARK: - 결정론

  func testSameSeedReproducesTheSameOutcomeAndTheRateConvergesToTenPercent() throws {
    let catalog = try CreatureCatalog.load()
    func run(seed: UInt64) throws -> (speciesID: String, fired: Bool) {
      let subject = creature("PG-001", level: 14, experience: 1_390, origin: "PG-001")
      var state = state(with: [subject])
      var generator = SeededGenerator(seed: seed)
      let outcome = try GameEngine.feedLarge(
        creatureID: subject.id, state: &state, catalog: catalog, generator: &generator)
      return (state.ownedCreatures[0].speciesID, outcome.mutationOffer != nil)
    }

    XCTAssertEqual(try run(seed: triggerSeed).speciesID, try run(seed: triggerSeed).speciesID)
    XCTAssertTrue(try run(seed: triggerSeed).fired)
    XCTAssertEqual(try run(seed: triggerSeed).speciesID, "PG-001")
    XCTAssertFalse(try run(seed: calmSeed).fired)
    XCTAssertEqual(try run(seed: calmSeed).speciesID, "PG-061")

    let samples = 20_000
    var fired = 0
    for seed in 1...samples where try run(seed: UInt64(seed)).fired { fired += 1 }
    let rate = Double(fired) / Double(samples)
    XCTAssertEqual(rate, GameState.mutationTriggerRate, accuracy: 0.01)
  }

  func testMutationFreeLineagesNeverJudgeAndNeverConsumeRandomness() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-041", level: 14, experience: 1_390, origin: "PG-041")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)

    let outcome = try GameEngine.feedLarge(
      creatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertNil(outcome.mutationOffer)
    XCTAssertEqual(outcome.evolutions.map(\.toSpeciesID), ["PG-149"])
    assertUntouched(&generator, seed: triggerSeed, "변이 후보가 없으면 난수를 소비하지 않는다")

    let roots = catalog.filter { $0.stage == 1 && $0.category == "start" }
    let withoutMutation = roots.filter {
      EvolutionCatalog.mutationCandidate(after: $0, in: catalog) == nil
    }
    XCTAssertEqual(withoutMutation.count, 39)
  }

  // MARK: - 발동 순간

  func testTriggeringStopsBeforeApplyingTheEvolutionAndReportsTheOffer() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-001", level: 14, experience: 1_390, origin: "PG-001")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)

    let outcome = try GameEngine.feedLarge(
      creatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertTrue(outcome.evolutions.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-001")
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-216"))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-061"))
    let offer = try XCTUnwrap(outcome.mutationOffer)
    XCTAssertEqual(offer.creatureID, subject.id)
    XCTAssertEqual(offer.fromSpeciesID, "PG-001")
    XCTAssertEqual(offer.mutationSpeciesID, "PG-216")
    XCTAssertEqual(offer.plannedTargetSpeciesID, "PG-061")
    // 진화만 멈춘다. 먹이와 레벨은 정상 반영된다.
    XCTAssertEqual(state.ownedCreatures[0].level, 15)
    XCTAssertEqual(state.inventory.largeFood, 29)
  }

  func testAcceptingAppliesTheMutantAndLeavesNoFurtherCandidates() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-001", level: 14, experience: 1_390, origin: "PG-001")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)
    let offer = try XCTUnwrap(
      try GameEngine.feedLarge(
        creatureID: subject.id, state: &state, catalog: catalog, generator: &generator
      ).mutationOffer)

    let results = try GameEngine.resolveMutationOffer(
      offer, accept: true, state: &state, catalog: catalog, generator: &generator)

    XCTAssertEqual(results.map(\.toSpeciesID), ["PG-216"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-216")
    XCTAssertTrue(state.discoveredSpeciesIDs.contains("PG-216"))
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-061"))
    let mutant = try XCTUnwrap(catalog.first { $0.id == "PG-216" })
    XCTAssertTrue(EvolutionCatalog.selectableCandidates(after: mutant, in: catalog).isEmpty)
    XCTAssertNil(EvolutionCatalog.mutationCandidate(after: mutant, in: catalog))
    XCTAssertTrue(GameEngine.isTerminalSpecies(mutant, catalog: catalog))
  }

  func testDecliningTakesThePlannedTargetAndNeverRejudgesInTheSameCall() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-001", level: 14, experience: 1_390, origin: "PG-001")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)
    let offer = try XCTUnwrap(
      try GameEngine.feedLarge(
        creatureID: subject.id, state: &state, catalog: catalog, generator: &generator
      ).mutationOffer)

    // 발동이 확정되는 시드를 다시 넣어도 해결 호출 안에서는 재판정이 없다.
    var resolveGenerator = SeededGenerator(seed: triggerSeed)
    let results = try GameEngine.resolveMutationOffer(
      offer, accept: false, state: &state, catalog: catalog, generator: &resolveGenerator)

    XCTAssertEqual(results.map(\.toSpeciesID), ["PG-061"])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-061")
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-216"))
    assertUntouched(&resolveGenerator, seed: triggerSeed, "해결 호출은 난수를 소비하지 않는다")
  }

  func testResolvedOfferCannotBeReplayed() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-001", level: 14, experience: 1_390, origin: "PG-001")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)
    let offer = try XCTUnwrap(
      try GameEngine.feedLarge(
        creatureID: subject.id, state: &state, catalog: catalog, generator: &generator
      ).mutationOffer)
    _ = try GameEngine.resolveMutationOffer(
      offer, accept: false, state: &state, catalog: catalog, generator: &generator)
    let settled = state

    XCTAssertThrowsError(
      try GameEngine.resolveMutationOffer(
        offer, accept: true, state: &state, catalog: catalog, generator: &generator)
    ) { XCTAssertEqual($0 as? GameError, .invalidEvolutionChoice) }
    XCTAssertEqual(state, settled)
  }

  // MARK: - 연쇄

  func testLevelFortyChainStopsAtTheCurrentBranchAfterMutationResolution() throws {
    let fixture = branchingMutationCatalog()
    let subject = creature(fixture.root.id, level: 40, origin: fixture.root.id)
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)

    let outcome = try GameEngine.feedLarge(
      creatureID: subject.id, state: &state, catalog: fixture.catalog, generator: &generator)

    XCTAssertTrue(outcome.evolutions.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, fixture.root.id)
    let offer = try XCTUnwrap(outcome.mutationOffer)
    XCTAssertEqual(offer.mutationSpeciesID, fixture.mutant.id)
    XCTAssertEqual(offer.plannedTargetSpeciesID, fixture.normal.id)

    let resumed = try GameEngine.resolveMutationOffer(
      offer, accept: false, state: &state, catalog: fixture.catalog, generator: &generator)

    XCTAssertEqual(resumed.map(\.toSpeciesID), [fixture.normal.id])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, fixture.normal.id)
    let pending = try XCTUnwrap(
      GameEngine.pendingEvolutionChoice(
        for: state.ownedCreatures[0], catalog: fixture.catalog))
    XCTAssertEqual(pending.candidates.map(\.id), fixture.branches.map(\.id))
  }

  func testWithoutATriggerASingleFeedClimbsUntilTheFirstBranch() throws {
    let fixture = branchingMutationCatalog()
    let subject = creature(fixture.root.id, level: 40, origin: fixture.root.id)
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: calmSeed)

    let outcome = try GameEngine.feedLarge(
      creatureID: subject.id, state: &state, catalog: fixture.catalog, generator: &generator)

    XCTAssertNil(outcome.mutationOffer)
    XCTAssertEqual(outcome.evolutions.map(\.toSpeciesID), [fixture.normal.id])
    XCTAssertEqual(state.ownedCreatures[0].speciesID, fixture.normal.id)
    let pending = try XCTUnwrap(
      GameEngine.pendingEvolutionChoice(
        for: state.ownedCreatures[0], catalog: fixture.catalog))
    XCTAssertEqual(pending.candidates.map(\.id), fixture.branches.map(\.id))
  }

  // MARK: - 발동하지 않는 자리

  func testLaterStagesNeverJudge() throws {
    let catalog = try CreatureCatalog.load()
    for (speciesID, level, expected) in [("PG-061", 24, "PG-181"), ("PG-118", 39, "PG-119")] {
      let subject = creature(speciesID, level: level, experience: 9_999, origin: "PG-001")
      var state = state(with: [subject])
      var generator = SeededGenerator(seed: triggerSeed)

      let outcome = try GameEngine.feedLarge(
        creatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

      XCTAssertNil(outcome.mutationOffer)
      XCTAssertEqual(outcome.evolutions.map(\.toSpeciesID), [expected])
      assertUntouched(&generator, seed: triggerSeed, "\(speciesID)는 난수를 소비하지 않는다")
    }
    let laterStagesWithMutation = catalog.filter { $0.stage >= 2 }
      .filter { EvolutionCatalog.mutationCandidate(after: $0, in: catalog) != nil }
    XCTAssertTrue(laterStagesWithMutation.isEmpty)
  }

  func testWaitingForABranchChoiceNeverJudges() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-002", level: 14, experience: 1_390, origin: "PG-002")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)

    let outcome = try GameEngine.feedLarge(
      creatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertNil(outcome.mutationOffer)
    XCTAssertTrue(outcome.evolutions.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-002")
    XCTAssertNotNil(
      GameEngine.pendingEvolutionChoice(for: state.ownedCreatures[0], catalog: catalog))
    assertUntouched(&generator, seed: triggerSeed, "대기 중에는 난수를 소비하지 않는다")
  }

  func testJudgementFollowsTheUsersChoiceNotTheDefaultCandidate() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-002", level: 15, origin: "PG-002")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: triggerSeed)

    let outcome = try GameEngine.chooseEvolution(
      creatureID: subject.id, toSpeciesID: "PG-182", state: &state, catalog: catalog,
      generator: &generator)

    XCTAssertTrue(outcome.evolutions.isEmpty)
    XCTAssertEqual(state.ownedCreatures[0].speciesID, "PG-002")
    let offer = try XCTUnwrap(outcome.mutationOffer)
    XCTAssertEqual(offer.plannedTargetSpeciesID, "PG-182")

    let resumed = try GameEngine.resolveMutationOffer(
      offer, accept: false, state: &state, catalog: catalog, generator: &generator)
    XCTAssertEqual(resumed.map(\.toSpeciesID), ["PG-182"])
  }

  // MARK: - 저장소

  @MainActor
  func testStorePublishesTheOfferWithoutWritingTheEvolutionToDisk() throws {
    let catalog = try CreatureCatalog.load()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    defer { try? FileManager.default.removeItem(at: directory) }
    let creatureID = UUID()
    var seeded = state(
      with: [creature("PG-001", level: 14, experience: 1_390, origin: "PG-001", id: creatureID)])
    seeded.discoveredSpeciesIDs = ["PG-001"]
    try persistence.save(seeded)

    let seed = triggerSeed
    let store = GameStore(
      persistence: persistence, catalog: catalog,
      makeGenerator: { SeededGenerator(seed: seed) })
    XCTAssertNil(store.pendingMutationOffer)

    store.feedLargeCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.pendingMutationOffer?.mutationSpeciesID, "PG-216")
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-001")
    let saved = try JSONDecoder.punchGrow.decode(
      GameState.self, from: Data(contentsOf: persistence.fileURL))
    XCTAssertEqual(saved.ownedCreatures[0].speciesID, "PG-001")
    XCTAssertEqual(saved.ownedCreatures[0].level, 15)
  }

  @MainActor
  func testFeedingAnOfferedCreatureHoldsTheEvolutionAndKeepsTheSameOffer() throws {
    let catalog = try CreatureCatalog.load()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    defer { try? FileManager.default.removeItem(at: directory) }
    let creatureID = UUID()
    try persistence.save(
      state(
        with: [creature("PG-001", level: 14, experience: 1_390, origin: "PG-001", id: creatureID)]))

    let seed = triggerSeed
    let store = GameStore(
      persistence: persistence, catalog: catalog,
      makeGenerator: { SeededGenerator(seed: seed) })
    store.feedLargeCurrent()
    let offer = store.pendingMutationOffer
    let experienceBefore = store.state.ownedCreatures[0].experience

    store.feedLargeCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-001")
    XCTAssertEqual(
      store.state.ownedCreatures[0].experience,
      experienceBefore + GameState.largeFoodExperience)
    XCTAssertEqual(store.pendingMutationOffer, offer)

    store.resolveMutationOffer(creatureID: creatureID, accept: false)

    XCTAssertNil(store.errorMessage)
    XCTAssertNil(store.pendingMutationOffer)
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-061")
    let saved = try JSONDecoder.punchGrow.decode(
      GameState.self, from: Data(contentsOf: persistence.fileURL))
    XCTAssertEqual(saved.ownedCreatures[0].speciesID, "PG-061")
  }

  @MainActor
  func testStoreAcceptancePathRequiresAnExplicitAccept() throws {
    let catalog = try CreatureCatalog.load()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    defer { try? FileManager.default.removeItem(at: directory) }
    let creatureID = UUID()
    try persistence.save(
      state(
        with: [creature("PG-001", level: 14, experience: 1_390, origin: "PG-001", id: creatureID)]))

    let seed = triggerSeed
    let store = GameStore(
      persistence: persistence, catalog: catalog,
      makeGenerator: { SeededGenerator(seed: seed) })
    store.feedLargeCurrent()

    // 오퍼는 열린 채 남아 있고, 어떤 자동 경로도 이를 대신 수락하지 않는다.
    XCTAssertNotNil(store.pendingMutationOffer)
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-001")

    store.resolveMutationOfferCurrent(accept: true)

    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-216")
    XCTAssertEqual(store.evolutionFeedback?.toSpeciesID, "PG-216")
    XCTAssertNil(store.pendingMutationOffer)
  }

  // MARK: - 표현

  func testOfferPresentationOffersBothActionsWithTerminalWarningAndRetryNotice() throws {
    let catalog = try CreatureCatalog.load()
    let offer = PendingMutationOffer(
      creatureID: UUID(), fromSpeciesID: "PG-001",
      mutationSpeciesID: "PG-216", plannedTargetSpeciesID: "PG-061")

    let presentation = try XCTUnwrap(
      MutationOfferPresentation.make(
        offer: offer, catalog: catalog, discoveredSpeciesIDs: ["PG-001"]))

    XCTAssertEqual(presentation.title, "변이 발동!")
    XCTAssertEqual(presentation.acceptTitle, "변이 받기")
    XCTAssertEqual(presentation.declineTitle, "그대로 진화")
    XCTAssertEqual(presentation.terminalWarning, "이 모습이 최종 형태가 됩니다")
    XCTAssertEqual(
      presentation.retryNotice,
      "거절해도 나중에 \(GameState.mutationRetryCost / 10_000)만 토큰으로 다시 노릴 수 있습니다")
    // 되돌릴 수 없는 판단이라 변이체는 항상 공개하고, 거절 대상만 발견 규칙을 따른다.
    XCTAssertEqual(presentation.mutationName, "에일크래그")
    XCTAssertEqual(presentation.plannedTargetName, "미발견 진화체")
    let discovered = try XCTUnwrap(
      MutationOfferPresentation.make(
        offer: offer, catalog: catalog, discoveredSpeciesIDs: ["PG-001", "PG-061"]))
    XCTAssertEqual(discovered.plannedTargetName, "에일반")
  }

  func testOfferBadgeIsDistinctFromTheWaitingBadge() {
    let offer = PendingMutationOffer(
      creatureID: UUID(), fromSpeciesID: "PG-001",
      mutationSpeciesID: "PG-216", plannedTargetSpeciesID: "PG-061")

    let badge = MutationOfferBadgePresentation(offer: offer)

    XCTAssertTrue(badge.isVisible)
    XCTAssertEqual(badge.creatureID, offer.creatureID)
    XCTAssertEqual(badge.label, "변이 발동 — 수락 여부 대기")
    XCTAssertNotEqual(badge.label, PendingEvolutionBadgePresentation(choices: []).label)
    XCTAssertFalse(MutationOfferBadgePresentation(offer: nil).isVisible)
  }

  func testDexMutationNoticeIsDerivedFromTheSharedConstant() {
    XCTAssertEqual(EvolutionDexEntry.mutationNotice, "Lv15 진화 시 10% 확률로 만납니다")
  }
}
