import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// US-5. 지나친 변이를 토큰으로 다시 노린다(재도전 + 천장) · 계승.
///
/// 재도전은 진화 발동과 같은 10% 상수를 쓰므로 시드는 하드코딩하지 않고
/// `Double.random(in: 0..<1)` 첫 값으로 찾는다.
final class MutationRetryTests: XCTestCase {

  // MARK: - 시드

  private static func firstRoll(seed: UInt64) -> Double {
    var generator = SeededGenerator(seed: seed)
    return Double.random(in: 0..<1, using: &generator)
  }

  private lazy var successSeed: UInt64 = {
    (1...20_000).first { Self.firstRoll(seed: UInt64($0)) < GameState.mutationTriggerRate }
      .map(UInt64.init)!
  }()

  private lazy var failureSeed: UInt64 = {
    (1...20_000).first { Self.firstRoll(seed: UInt64($0)) >= GameState.mutationTriggerRate }
      .map(UInt64.init)!
  }()

  // MARK: - 도우미

  /// PG-001 계보는 변이(PG-216)를 가진다. PG-061은 그 계보의 stage 2다.
  private func creature(
    _ speciesID: String,
    origin: String?,
    level: Int = 20,
    id: UUID = UUID(),
    nickname: String? = nil,
    acquiredAt: Date = Date(timeIntervalSince1970: 1)
  ) -> OwnedCreature {
    OwnedCreature(
      id: id, speciesID: speciesID, originSpeciesID: origin, level: level, experience: 7,
      affection: 42, nickname: nickname,
      uniqueColor: false, acquiredAt: acquiredAt)
  }

  private func state(with creatures: [OwnedCreature], balance: Int = 10_000_000) -> GameState {
    var state = GameState()
    state.ownedCreatures = creatures
    state.tokenBalance = balance
    state.inventory.largeFood = 30
    return state
  }

  private let acquiredAt = Date(timeIntervalSince1970: 1_800_000_000)

  // MARK: - 상수

  func testInheritCostLivesInASingleNamedPlace() {
    XCTAssertEqual(GameState.inheritCost, 5_000_000)
    XCTAssertEqual(GameState.maximumOwnedCreatures, 100_000)
  }

  // MARK: - 재도전 성공·실패

  func testSuccessAppendsTheMutantAndClearsTheLineageCounter() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject])
    state.recordMutationRetryFailure(forOrigin: "PG-001")
    var generator = SeededGenerator(seed: successSeed)

    let outcome = try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator,
      now: acquiredAt)

    XCTAssertTrue(outcome.succeeded)
    XCTAssertEqual(outcome.tokensSpent, GameState.mutationRetryCost)
    XCTAssertEqual(outcome.failureCount, 0)
    XCTAssertEqual(state.tokenBalance, 10_000_000 - GameState.mutationRetryCost)
    XCTAssertEqual(state.ownedCreatures.count, 2)
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 0)

    let offspring = try XCTUnwrap(state.ownedCreatures.last)
    XCTAssertEqual(offspring.id, outcome.creatureID)
    XCTAssertEqual(offspring.speciesID, "PG-216")
    XCTAssertEqual(offspring.originSpeciesID, "PG-001")
    XCTAssertEqual(offspring.level, 1)
    XCTAssertEqual(offspring.experience, 0)
    XCTAssertEqual(offspring.affection, 0)
    XCTAssertNil(offspring.nickname)
    XCTAssertFalse(offspring.uniqueColor)
    XCTAssertEqual(offspring.acquiredAt, acquiredAt)
    XCTAssertEqual(catalog.first { $0.id == "PG-216" }?.stage, 2)
    XCTAssertTrue(state.discoveredSpeciesIDs.contains("PG-216"))
  }

  func testFailureStillSpendsTokensAndRaisesOnlyTheCounter() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject])
    var generator = SeededGenerator(seed: failureSeed)

    let outcome = try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertFalse(outcome.succeeded)
    XCTAssertNil(outcome.creatureID)
    XCTAssertEqual(outcome.tokensSpent, GameState.mutationRetryCost)
    XCTAssertEqual(outcome.failureCount, 1)
    XCTAssertEqual(state.tokenBalance, 10_000_000 - GameState.mutationRetryCost)
    XCTAssertEqual(state.ownedCreatures.count, 1)
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 1)
    XCTAssertFalse(state.discoveredSpeciesIDs.contains("PG-216"))
  }

  func testOriginalCreatureAndRepresentativeNeverMove() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001", nickname: "테스트")
    var state = state(with: [subject])
    state.representativeCreatureID = subject.id
    var generator = SeededGenerator(seed: successSeed)

    try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertEqual(state.ownedCreatures[0], subject)
    XCTAssertEqual(state.representativeCreatureID, subject.id)
  }

  // MARK: - 천장

  func testThirtyFailuresGuaranteeTheNextAttemptRegardlessOfSeed() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject], balance: 100_000_000)
    for _ in 0..<29 { state.recordMutationRetryFailure(forOrigin: "PG-001") }
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 29)

    var failing = SeededGenerator(seed: failureSeed)
    let thirtieth = try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &failing)

    XCTAssertFalse(thirtieth.succeeded)
    XCTAssertEqual(thirtieth.failureCount, GameState.mutationRetryPityThreshold)

    // 천장에 닿으면 판정 자체를 건너뛰므로 실패 시드를 그대로 넣어도 성공한다.
    var pity = SeededGenerator(seed: failureSeed)
    let guaranteed = try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &pity)

    XCTAssertTrue(guaranteed.succeeded)
    XCTAssertEqual(guaranteed.failureCount, 0)
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 0)
    XCTAssertEqual(state.ownedCreatures.last?.speciesID, "PG-216")
    // 확정 성공은 난수를 소비하지 않는다.
    var fresh = SeededGenerator(seed: failureSeed)
    XCTAssertEqual(pity.next(), fresh.next())
  }

  func testCountersAreIndependentPerLineage() throws {
    let catalog = try CreatureCatalog.load()
    let first = creature("PG-061", origin: "PG-001")
    // PG-034 계보도 변이(PG-240)를 가진다.
    let second = creature("PG-117", origin: "PG-034", acquiredAt: Date(timeIntervalSince1970: 2))
    var state = state(with: [first, second], balance: 100_000_000)
    for _ in 0..<GameState.mutationRetryPityThreshold {
      state.recordMutationRetryFailure(forOrigin: "PG-001")
    }

    var generator = SeededGenerator(seed: failureSeed)
    let other = try GameEngine.retryMutation(
      fromCreatureID: second.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertFalse(other.succeeded, "A 계보의 천장이 B 계보를 확정시키면 안 된다")
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-034"), 1)
    XCTAssertEqual(
      state.mutationRetryFailureCount(forOrigin: "PG-001"),
      GameState.mutationRetryPityThreshold)
  }

  // MARK: - 거절 조건

  func testStageOneCreatureCannotRetryAndNothingChanges() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-001", origin: "PG-001", level: 5)
    var state = state(with: [subject])
    let before = state
    var generator = SeededGenerator(seed: successSeed)

    XCTAssertThrowsError(
      try GameEngine.retryMutation(
        fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)
    ) { XCTAssertEqual($0 as? GameError, .creatureActionUnavailable) }
    XCTAssertEqual(state, before)
  }

  func testMutationFreeLineageCannotRetryAndTheReasonIsShownInKorean() throws {
    let catalog = try CreatureCatalog.load()
    // PG-041은 변이가 없는 35개 계보 중 하나다.
    let subject = creature("PG-149", origin: "PG-041")
    var state = state(with: [subject])
    let before = state
    var generator = SeededGenerator(seed: successSeed)

    XCTAssertThrowsError(
      try GameEngine.retryMutation(
        fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)
    ) { XCTAssertEqual($0 as? GameError, .creatureActionUnavailable) }
    XCTAssertEqual(state, before)

    let presentation = CompactViewState(
      state: state, currentCreature: subject, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertFalse(presentation.retryMutation.isEnabled)
    XCTAssertEqual(presentation.retryMutation.explanation, "이 계보에는 변이가 없습니다.")
  }

  func testOneTokenShortLeavesEverythingUntouched() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject], balance: GameState.mutationRetryCost - 1)
    let before = state
    var generator = SeededGenerator(seed: successSeed)

    XCTAssertThrowsError(
      try GameEngine.retryMutation(
        fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)
    ) { XCTAssertEqual($0 as? GameError, .insufficientTokens) }
    XCTAssertEqual(state, before)

    let presentation = CompactViewState(
      state: state, currentCreature: subject, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertFalse(presentation.retryMutation.isEnabled)
    XCTAssertEqual(presentation.retryMutation.explanation, "1 토큰이 더 필요합니다.")
  }

  /// R7. 한도를 넘기면 `validate`가 거부해 저장 전체가 잠긴다.
  func testCreatureLimitBlocksBothAcquisitionPathsWithoutSpendingTokens() throws {
    let catalog = try CreatureCatalog.load()
    let retrySubject = creature("PG-061", origin: "PG-001")
    let inheritSubject = creature(
      "PG-119", origin: "PG-034", acquiredAt: Date(timeIntervalSince1970: 2))
    var filler = (0..<(GameState.maximumOwnedCreatures - 2)).map { index in
      creature("PG-041", origin: "PG-041", acquiredAt: Date(timeIntervalSince1970: 10 + Double(index)))
    }
    filler.append(contentsOf: [retrySubject, inheritSubject])
    var state = state(with: filler, balance: 100_000_000)
    XCTAssertEqual(state.ownedCreatures.count, GameState.maximumOwnedCreatures)
    let before = state
    var generator = SeededGenerator(seed: successSeed)

    XCTAssertThrowsError(
      try GameEngine.retryMutation(
        fromCreatureID: retrySubject.id, state: &state, catalog: catalog, generator: &generator)
    ) { XCTAssertEqual($0 as? GameError, .creatureLimitReached) }
    XCTAssertThrowsError(
      try GameEngine.inherit(
        fromCreatureID: inheritSubject.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .creatureLimitReached) }
    XCTAssertEqual(state.tokenBalance, before.tokenBalance)
    XCTAssertEqual(state.ownedCreatures.count, GameState.maximumOwnedCreatures)
  }

  // MARK: - 세이브 안전

  func testLegacySaveWithoutTheCounterKeyLoadsAndBehavesAsAnEmptyDictionary() throws {
    let catalog = try CreatureCatalog.load()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "state.json")
    let json = """
      {
        "schemaVersion": 2,
        "tokenBalance": 3000000,
        "usageEvents": [],
        "creditedUsageEventKeys": [],
        "lifetimeUsage": [],
        "codexCheckpoints": {},
        "ownedCreatures": [
          {
            "id": "00000000-0000-4000-8000-000000000061",
            "speciesID": "PG-061",
            "originSpeciesID": "PG-001",
            "level": 20,
            "experience": 0,
            "affection": 0,
            "uniqueColor": false,
            "acquiredAt": "2026-01-01T00:00:00Z"
          }
        ],
        "discoveredSpeciesIDs": ["PG-001", "PG-061"],
        "inventory": {"food": 5, "largeFood": 0, "trainingTools": 1, "evolutionMaterials": 0},
        "pullsSinceOrigin": 0
      }
      """
    try Data(json.utf8).write(to: file)
    var state = try GamePersistence(fileURL: file).load()
    try state.validate(catalogIDs: Set(catalog.map(\.id)))

    XCTAssertNil(state.mutationRetryFailures)
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 0)

    let subject = try XCTUnwrap(state.ownedCreatures.first)
    var generator = SeededGenerator(seed: failureSeed)
    let outcome = try GameEngine.retryMutation(
      fromCreatureID: subject.id, state: &state, catalog: catalog, generator: &generator)

    XCTAssertFalse(outcome.succeeded)
    XCTAssertEqual(state.mutationRetryFailureCount(forOrigin: "PG-001"), 1)
  }

  func testBackupRoundTripPreservesTheCounters() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var state = state(with: [creature("PG-061", origin: "PG-001")])
    for _ in 0..<7 { state.recordMutationRetryFailure(forOrigin: "PG-001") }
    let backup = directory.appending(path: "backup.pgrow")

    try persistence.export(state, to: backup)
    let restored = try persistence.restore(from: backup)

    XCTAssertEqual(restored.mutationRetryFailureCount(forOrigin: "PG-001"), 7)
    XCTAssertEqual(restored.mutationRetryFailures, ["PG-001": 7])
  }

  // MARK: - 계승

  func testInheritOnlyWorksOnTerminalSpeciesAndLeavesTheOriginalAlone() throws {
    let catalog = try CreatureCatalog.load()
    let terminal = creature("PG-119", origin: "PG-034", level: 40)
    var state = state(with: [terminal])
    state.representativeCreatureID = terminal.id
    XCTAssertTrue(
      GameEngine.isTerminalSpecies(try XCTUnwrap(catalog.first { $0.id == "PG-119" }), catalog: catalog))

    let offspring = try GameEngine.inherit(
      fromCreatureID: terminal.id, state: &state, catalog: catalog, now: acquiredAt)

    XCTAssertEqual(state.tokenBalance, 10_000_000 - GameState.inheritCost)
    XCTAssertEqual(state.ownedCreatures.count, 2)
    XCTAssertEqual(state.ownedCreatures[0], terminal)
    XCTAssertEqual(state.representativeCreatureID, terminal.id)
    XCTAssertEqual(offspring.speciesID, "PG-034")
    XCTAssertEqual(offspring.originSpeciesID, "PG-034")
    XCTAssertEqual(catalog.first { $0.id == "PG-034" }?.stage, 1)
    XCTAssertEqual(offspring.level, 1)
    XCTAssertEqual(offspring.experience, 0)
    XCTAssertEqual(offspring.affection, 0)
    XCTAssertFalse(offspring.uniqueColor)
    XCTAssertEqual(offspring.acquiredAt, acquiredAt)
  }

  func testNonTerminalCreatureCannotInherit() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject])
    let before = state

    XCTAssertThrowsError(
      try GameEngine.inherit(fromCreatureID: subject.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .creatureActionUnavailable) }
    XCTAssertEqual(state, before)

    let presentation = CompactViewState(
      state: state, currentCreature: subject, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertFalse(presentation.inherit.isEnabled)
    XCTAssertEqual(presentation.inherit.explanation, "최종 단계까지 키운 뒤에 계승할 수 있습니다.")
  }

  func testInheritShortfallLeavesEverythingUntouched() throws {
    let catalog = try CreatureCatalog.load()
    let terminal = creature("PG-119", origin: "PG-034", level: 40)
    var state = state(with: [terminal], balance: GameState.inheritCost - 1)
    let before = state

    XCTAssertThrowsError(
      try GameEngine.inherit(fromCreatureID: terminal.id, state: &state, catalog: catalog)
    ) { XCTAssertEqual($0 as? GameError, .insufficientTokens) }
    XCTAssertEqual(state, before)
  }

  // MARK: - 표현

  func testBothActionsAreDisabledWithKoreanReasonsWhileSavingIsLocked() throws {
    let catalog = try CreatureCatalog.load()
    let terminal = creature("PG-119", origin: "PG-034", level: 40)
    let state = state(with: [terminal], balance: 100_000_000)

    let locked = CompactViewState(
      state: state, currentCreature: terminal, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog, isPersistenceLocked: true)

    XCTAssertFalse(locked.retryMutation.isEnabled)
    XCTAssertFalse(locked.inherit.isEnabled)
    XCTAssertEqual(
      locked.retryMutation.explanation, "저장이 잠겨 있습니다. Data & Settings에서 백업을 복원해 주세요.")
    XCTAssertEqual(locked.inherit.explanation, locked.retryMutation.explanation)

    let unlocked = CompactViewState(
      state: state, currentCreature: terminal, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertTrue(unlocked.inherit.isEnabled)
    // 계승 문구는 변이를 언급하지 않는다.
    XCTAssertFalse(unlocked.inherit.explanation.contains("변이"))
  }

  func testRetryTitleCarriesThePityProgressOnlyAfterAFailure() throws {
    let catalog = try CreatureCatalog.load()
    let subject = creature("PG-061", origin: "PG-001")
    var state = state(with: [subject])

    let fresh = CompactViewState(
      state: state, currentCreature: subject, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertEqual(
      fresh.retryMutationTitle, "변이 재도전 · \(GameState.mutationRetryCost / 10_000)만")
    XCTAssertTrue(fresh.retryMutation.isEnabled)

    for _ in 0..<12 { state.recordMutationRetryFailure(forOrigin: "PG-001") }
    let progressed = CompactViewState(
      state: state, currentCreature: subject, currentPosition: 1, catalogIsEmpty: false,
      weeklyUsage: [:], catalog: catalog)
    XCTAssertEqual(
      progressed.retryMutationTitle,
      "변이 재도전 · \(GameState.mutationRetryCost / 10_000)만 (12/\(GameState.mutationRetryPityThreshold))")
    XCTAssertTrue(progressed.retryMutation.explanation.contains("18회 더 실패하면 확정"))
  }

  // MARK: - 저장소 · US-1 결합

  @MainActor
  private func makeStore(
    creatures: [OwnedCreature],
    balance: Int,
    seed: UInt64,
    directory: URL
  ) throws -> GameStore {
    let catalog = try CreatureCatalog.load()
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var seeded = state(with: creatures, balance: balance)
    seeded.discoveredSpeciesIDs = Set(creatures.map(\.speciesID))
    try persistence.save(seeded)
    return GameStore(
      persistence: persistence, catalog: catalog, now: { self.acquiredAt },
      makeGenerator: { SeededGenerator(seed: seed) })
  }

  @MainActor
  func testStoreRetrySuccessLandsInTheOriginGroupAndTheNewCreatureCanBeFed() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let subject = creature("PG-061", origin: "PG-001")
    let store = try makeStore(
      creatures: [subject], balance: 10_000_000, seed: successSeed, directory: directory)

    store.retryMutationCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures.count, 2)
    XCTAssertEqual(store.currentCreatureID, subject.id, "원 개체 포커스가 유지된다")
    let group = GameEngine.ownedCreatures(
      inOriginGroupOf: subject.id, state: store.state, catalog: store.catalog)
    XCTAssertEqual(group.count, 2)
    XCTAssertEqual(group.last?.speciesID, "PG-216")

    store.selectNextInGroup()
    XCTAssertEqual(store.currentCreatureID, group[1].id)
    store.feedLargeCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures[1].level, 2)
    XCTAssertEqual(
      store.state.ownedCreatures[1].experience, GameState.largeFoodExperience - 100)
    XCTAssertEqual(store.state.ownedCreatures[0], subject)
  }

  @MainActor
  func testStoreInheritLandsInTheOriginGroupAndTheNewCreatureCanBeFed() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let terminal = creature("PG-119", origin: "PG-034", level: 40)
    let store = try makeStore(
      creatures: [terminal], balance: 10_000_000, seed: failureSeed, directory: directory)

    store.inheritCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.tokenBalance, 10_000_000 - GameState.inheritCost)
    let group = GameEngine.ownedCreatures(
      inOriginGroupOf: terminal.id, state: store.state, catalog: store.catalog)
    XCTAssertEqual(group.count, 2)
    XCTAssertEqual(group.last?.speciesID, "PG-034")

    store.selectNextInGroup()
    store.feedLargeCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures[1].level, 2)
    XCTAssertEqual(
      store.state.ownedCreatures[1].experience, GameState.largeFoodExperience - 100)
    XCTAssertEqual(store.state.ownedCreatures[0], terminal)
  }

  @MainActor
  func testStoreRetryFailurePersistsTheCounter() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let subject = creature("PG-061", origin: "PG-001")
    let store = try makeStore(
      creatures: [subject], balance: 10_000_000, seed: failureSeed, directory: directory)

    store.retryMutationCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures.count, 1)
    XCTAssertEqual(store.state.mutationRetryFailureCount(forOrigin: "PG-001"), 1)
    let saved = try JSONDecoder.punchGrow.decode(
      GameState.self, from: Data(contentsOf: directory.appending(path: "state.json")))
    XCTAssertEqual(saved.mutationRetryFailureCount(forOrigin: "PG-001"), 1)
  }

  @MainActor
  func testLockedStoreRefusesBothActionsWithAnExplicitMessage() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "state.json")
    try Data("{ broken".utf8).write(to: fileURL)
    let catalog = try CreatureCatalog.load()
    let store = GameStore(persistence: GamePersistence(fileURL: fileURL), catalog: catalog)
    XCTAssertTrue(store.isPersistenceLocked)

    store.retryMutationCurrent()
    XCTAssertEqual(store.errorMessage, GameStore.persistenceLockedActionMessage)
    store.inheritCurrent()
    XCTAssertEqual(store.errorMessage, GameStore.persistenceLockedActionMessage)
    XCTAssertTrue(store.state.ownedCreatures.isEmpty)
  }
}
