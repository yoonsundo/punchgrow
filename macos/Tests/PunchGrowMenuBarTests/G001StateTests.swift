import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class G001StateTests: XCTestCase {

  @MainActor
  func testLargeFoodPurchasePersistsBalanceAndInventoryTogether() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var initial = GameState()
    initial.tokenBalance = GameState.largeFoodCost
    initial.inventory.largeFood = 0
    try persistence.save(initial)
    let store = GameStore(persistence: persistence)

    store.purchaseLargeFood()

    let reloaded = GameStore(persistence: persistence)
    XCTAssertEqual(reloaded.state.schemaVersion, GameState.schemaVersion)
    XCTAssertEqual(reloaded.state.tokenBalance, 0)
    XCTAssertEqual(reloaded.state.inventory.largeFood, 1)
  }

  @MainActor
  func testV2FixtureInitializesTransientCurrentFromRepresentative() throws {
    let persistence = try copiedV2Fixture()
    let store = GameStore(persistence: persistence)

    XCTAssertTrue(store.state.schemaVersion == GameState.schemaVersion)
    XCTAssertTrue(store.currentCreatureID == store.state.representativeCreatureID)
    XCTAssertTrue(store.currentCreatureCount == 2)
    XCTAssertTrue(store.canNavigateCreatures)

    let encoded =
      try JSONSerialization.jsonObject(with: Data(contentsOf: persistence.fileURL))
      as? [String: Any]
    XCTAssertTrue(encoded?["currentCreatureID"] == nil)
  }

  @MainActor
  func testNavigationWrapsAndRepresentativeChangesOnlyExplicitly() throws {
    let persistence = try copiedV2Fixture()
    let store = GameStore(persistence: persistence)
    let representative = store.state.representativeCreatureID

    store.selectNextCreature()
    XCTAssertTrue(
      store.currentCreatureID == UUID(uuidString: "11111111-1111-1111-1111-111111111111"))
    XCTAssertTrue(store.state.representativeCreatureID == representative)

    store.selectPreviousCreature()
    XCTAssertTrue(store.currentCreatureID == representative)
    store.selectPreviousCreature()
    XCTAssertTrue(
      store.currentCreatureID == UUID(uuidString: "11111111-1111-1111-1111-111111111111"))

    store.setCurrentAsRepresentative()
    XCTAssertTrue(store.state.representativeCreatureID == store.currentCreatureID)
    let relaunched = GameStore(persistence: persistence)
    XCTAssertTrue(relaunched.currentCreatureID == store.currentCreatureID)
  }

  @MainActor
  func testFeedingTargetsCurrentWithoutChangingIdentities() throws {
    let persistence = try copiedV2Fixture()
    var seeded = try persistence.load()
    seeded.inventory.largeFood = 1
    try persistence.save(seeded)
    let store = GameStore(persistence: persistence)
    let representative = store.state.representativeCreatureID
    store.selectNextCreature()
    let current = try XCTUnwrap(store.currentCreatureID)
    let priorCurrentXP = try XCTUnwrap(store.state.ownedCreatures.first { $0.id == current })
      .experience
    let priorRepresentativeXP = try XCTUnwrap(
      store.state.ownedCreatures.first { $0.id == representative }
    ).experience

    store.feedLargeCurrent()

    XCTAssertTrue(
      store.state.ownedCreatures.first { $0.id == current }?.experience
        == priorCurrentXP + GameState.largeFoodExperience)
    XCTAssertTrue(
      store.state.ownedCreatures.first { $0.id == representative }?.experience
        == priorRepresentativeXP)
    XCTAssertTrue(store.currentCreatureID == current)
    XCTAssertTrue(store.state.representativeCreatureID == representative)
  }

  @MainActor
  func testSuccessfulPullFocusesTheAcquiredCreatureWithoutChangingRepresentative() throws {
    let store = GameStore(persistence: try copiedV2Fixture())
    let representative = store.state.representativeCreatureID
    let priorIDs = Set(store.state.ownedCreatures.map(\.id))

    store.pull()

    let acquired = Set(store.state.ownedCreatures.map(\.id)).subtracting(priorIDs)
    XCTAssertTrue(acquired.count == 1)
    XCTAssertEqual(store.currentCreatureID, acquired.first)
    XCTAssertTrue(store.state.representativeCreatureID == representative)
  }

  @MainActor
  func testDuplicatePullPersistsAndFocusesTheNewMemberWithoutGrowingTheVisibleList() throws {
    let species = CreatureSpecies(
      id: "PG-001", koName: "에일루", enName: "Eilu", lineageId: "PG-L001",
      rarity: "PROCESS", stage: 1, category: "start", bodyForm: "fox",
      identity: "test", lore: "test", imagePath: "test")
    let otherSpecies = CreatureSpecies(
      id: "PG-002", koName: "다른 종", enName: "Other", lineageId: "PG-L002",
      rarity: "PROCESS", stage: 1, category: "owned_test", bodyForm: "bird",
      identity: "test", lore: "test", imagePath: "test")
    let first = OwnedCreature(
      id: UUID(), speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1))
    let other = OwnedCreature(
      id: UUID(), speciesID: otherSpecies.id, originSpeciesID: otherSpecies.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 2))
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var state = GameState()
    state.tokenBalance = GameState.gachaCost
    state.ownedCreatures = [first, other]
    state.discoveredSpeciesIDs = [species.id, otherSpecies.id]
    state.representativeCreatureID = other.id
    try persistence.save(state)
    let store = GameStore(persistence: persistence, catalog: [species, otherSpecies])
    XCTAssertEqual(store.currentCreatureID, other.id)

    let pulled = try XCTUnwrap(store.pull())

    XCTAssertNotEqual(pulled.id, first.id)
    XCTAssertEqual(store.state.ownedCreatures.count, 3)
    XCTAssertEqual(store.currentCreatureCount, 2)
    XCTAssertEqual(store.currentCreatureID, pulled.id)
    XCTAssertEqual(store.groupMemberPosition, 2)
    XCTAssertEqual(
      GameEngine.ownedCreatures(
        inOriginGroupOf: pulled.id, state: store.state, catalog: store.catalog
      ).map(\.id),
      [first.id, pulled.id])
    XCTAssertEqual(try persistence.load().ownedCreatures.count, 3)
  }

  @MainActor
  func testRepresentativeHiddenFromVisibleListStaysOnItsOwnGroupMember() throws {
    let species = CreatureSpecies(
      id: "PG-001", koName: "에일루", enName: "Eilu", lineageId: "PG-L001",
      rarity: "PROCESS", stage: 1, category: "start", bodyForm: "fox",
      identity: "test", lore: "test", imagePath: "test")
    let first = OwnedCreature(
      id: UUID(), speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1))
    let hiddenRepresentative = OwnedCreature(
      id: UUID(), speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 2))
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var state = GameState()
    state.ownedCreatures = [hiddenRepresentative, first]
    state.discoveredSpeciesIDs = [species.id]
    state.representativeCreatureID = hiddenRepresentative.id
    try persistence.save(state)

    let store = GameStore(persistence: persistence, catalog: [species])

    XCTAssertEqual(store.currentCreatureID, hiddenRepresentative.id)
    XCTAssertEqual(store.representativeCreature?.id, hiddenRepresentative.id)
    XCTAssertEqual(store.currentCreatureCount, 1)
    XCTAssertEqual(store.currentCreaturePosition, 1)
    XCTAssertEqual(store.groupMemberPosition, 2)
    XCTAssertEqual(
      GameEngine.visibleOwnedCreatures(in: store.state, catalog: store.catalog).map(\.id),
      [first.id])
  }

  @MainActor
  func testOriginGroupReturnsEveryMemberInAcquisitionOrderWhileListStaysOnePerOrigin() throws {
    let fixture = try groupedPersistence()
    let store = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)

    XCTAssertEqual(
      GameEngine.ownedCreatures(
        inOriginGroupOf: fixture.group[0].id, state: store.state, catalog: store.catalog
      ).map(\.id),
      fixture.group.map(\.id))
    XCTAssertEqual(
      GameEngine.ownedCreatures(
        inOriginGroupOf: fixture.group[2].id, state: store.state, catalog: store.catalog
      ).map(\.id),
      fixture.group.map(\.id))
    XCTAssertEqual(
      GameEngine.ownedCreatures(
        inOriginGroupOf: fixture.other.id, state: store.state, catalog: store.catalog
      ).map(\.id),
      [fixture.other.id])
    XCTAssertEqual(
      GameEngine.visibleOwnedCreatures(in: store.state, catalog: store.catalog).map(\.id),
      [fixture.group[0].id, fixture.other.id])
    XCTAssertEqual(store.currentCreatureCount, 2)
  }

  @MainActor
  func testSecondGroupMemberKeepsGroupPositionLabelAndExposesMemberPosition() throws {
    let fixture = try groupedPersistence()
    let store = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)
    XCTAssertEqual(store.currentCreatureID, fixture.group[0].id)
    XCTAssertEqual(store.groupMemberPosition, 1)

    store.selectNextInGroup()

    XCTAssertEqual(store.currentCreatureID, fixture.group[1].id)
    XCTAssertEqual(store.currentCreaturePosition, 1)
    XCTAssertEqual(store.currentCreatureCount, 2)
    XCTAssertEqual(store.groupMemberPosition, 2)
    let presentation = CompactViewState(
      state: store.state,
      currentCreature: store.currentCreature,
      currentPosition: store.currentCreaturePosition,
      visibleCreatureCount: store.currentCreatureCount,
      catalogIsEmpty: store.catalog.isEmpty,
      weeklyUsage: [:]
    )
    XCTAssertEqual(presentation.positionLabel, "1 / 2")

    let encoded =
      try JSONSerialization.jsonObject(with: Data(contentsOf: fixture.persistence.fileURL))
      as? [String: Any]
    XCTAssertNil(encoded?["currentCreatureID"])
  }

  @MainActor
  func testGroupNavigationWrapsAndOuterNavigationStillReachesTheNextGroup() throws {
    let fixture = try groupedPersistence()
    let store = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)

    store.selectPreviousInGroup()
    XCTAssertEqual(store.currentCreatureID, fixture.group[2].id)
    store.selectNextInGroup()
    XCTAssertEqual(store.currentCreatureID, fixture.group[0].id)
    store.selectNextInGroup()
    XCTAssertEqual(store.currentCreatureID, fixture.group[1].id)

    store.selectNextCreature()
    XCTAssertEqual(store.currentCreatureID, fixture.other.id)
    store.selectNextCreature()
    XCTAssertEqual(store.currentCreatureID, fixture.group[0].id)
  }

  @MainActor
  func testFeedingSecondGroupMemberChangesOnlyThatCreature() throws {
    let fixture = try groupedPersistence()
    let store = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)
    store.selectNextInGroup()

    store.feedLargeCurrent()

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.currentCreatureID, fixture.group[1].id)
    XCTAssertEqual(
      store.state.ownedCreatures.first { $0.id == fixture.group[1].id }?.experience,
      GameState.largeFoodExperience)
    XCTAssertEqual(
      store.state.ownedCreatures.first { $0.id == fixture.group[0].id }?.experience, 0)
    XCTAssertEqual(
      store.state.ownedCreatures.first { $0.id == fixture.group[2].id }?.experience, 0)
    XCTAssertEqual(store.state.ownedCreatures.first { $0.id == fixture.other.id }?.experience, 0)
  }

  @MainActor
  func testSecondGroupMemberBecomesRepresentativeAndSurvivesRelaunch() throws {
    let fixture = try groupedPersistence()
    let store = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)
    store.selectNextInGroup()

    store.setCurrentAsRepresentative()

    XCTAssertEqual(store.state.representativeCreatureID, fixture.group[1].id)
    XCTAssertEqual(store.representativeCreature?.id, fixture.group[1].id)

    let relaunched = GameStore(persistence: fixture.persistence, catalog: fixture.catalog)
    XCTAssertEqual(relaunched.currentCreatureID, fixture.group[1].id)
    XCTAssertEqual(relaunched.representativeCreature?.id, fixture.group[1].id)
    XCTAssertEqual(relaunched.groupMemberPosition, 2)
    XCTAssertEqual(relaunched.currentCreaturePosition, 1)
  }

  @MainActor
  func testEqualAcquisitionTimesPreservePersistedAppendOrderForEarliestCreature() throws {
    let species = CreatureSpecies(
      id: "PG-001", koName: "에일루", enName: "Eilu", lineageId: "PG-L001",
      rarity: "PROCESS", stage: 1, category: "start", bodyForm: "fox",
      identity: "test", lore: "test", imagePath: "test")
    let acquiredAt = Date(timeIntervalSince1970: 1)
    let first = OwnedCreature(
      id: UUID(uuidString: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")!,
      speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: acquiredAt)
    let laterDuplicate = OwnedCreature(
      id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
      speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: acquiredAt)
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var state = GameState()
    state.ownedCreatures = [first, laterDuplicate]
    state.discoveredSpeciesIDs = [species.id]
    try persistence.save(state)

    let reloaded = GameStore(persistence: persistence, catalog: [species])

    XCTAssertEqual(reloaded.currentCreatureCount, 1)
    XCTAssertEqual(reloaded.currentCreatureID, first.id)
  }

  @MainActor
  func testLegacyV2CreaturesWithoutOriginFieldDedupeAfterEvolution() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let firstID = UUID()
    let duplicateID = UUID()
    let json = """
      {"schemaVersion":2,"tokenBalance":0,"usageEvents":[],"creditedUsageEventKeys":[],
      "lifetimeUsage":[],"codexCheckpoints":{},"ownedCreatures":[
      {"id":"\(firstID.uuidString)","speciesID":"PG-061","level":15,"experience":0,
      "affection":0,"nickname":null,"uniqueColor":false,"acquiredAt":"2026-07-01T00:00:00Z"},
      {"id":"\(duplicateID.uuidString)","speciesID":"PG-001","level":1,"experience":0,
      "affection":0,"nickname":null,"uniqueColor":false,"acquiredAt":"2026-07-02T00:00:00Z"}],
      "discoveredSpeciesIDs":["PG-001","PG-061"],"inventory":{"food":0,"largeFood":0,
      "trainingTools":0,"evolutionMaterials":0},"pullsSinceOrigin":0,
      "representativeCreatureID":null}
      """
    try Data(json.utf8).write(to: persistence.fileURL)

    let store = GameStore(persistence: persistence)

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures.count, 2)
    XCTAssertEqual(store.currentCreatureCount, 1)
    XCTAssertEqual(store.currentCreatureID, firstID)
  }


  @MainActor
  func testLegacyStateWithoutPreferenceKeyLoadsButCannotChooseAQuarantinedFusion() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let creatureID = UUID()
    let json = """
      {"schemaVersion":2,"tokenBalance":0,"usageEvents":[],"creditedUsageEventKeys":[],
      "lifetimeUsage":[],"codexCheckpoints":{},"ownedCreatures":[
      {"id":"\(creatureID.uuidString)","speciesID":"PG-117","originSpeciesID":"PG-034",
      "level":25,"experience":0,"affection":0,"nickname":null,"uniqueColor":false,
      "acquiredAt":"2026-07-01T00:00:00Z"}],
      "discoveredSpeciesIDs":["PG-034","PG-117"],"inventory":{"food":5,"largeFood":0,
      "trainingTools":0,"evolutionMaterials":0},"pullsSinceOrigin":0,
      "representativeCreatureID":null}
      """
    try Data(json.utf8).write(to: persistence.fileURL)

    let store = GameStore(persistence: persistence)

    XCTAssertNil(store.errorMessage)
    XCTAssertNil(store.pendingEvolutionChoice)

    store.chooseEvolutionCurrent(toSpeciesID: "PG-205")

    XCTAssertNotNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-117")
    XCTAssertNil(store.pendingEvolutionChoice)
    XCTAssertNil(store.evolutionFeedback)

    store.chooseEvolutionCurrent(toSpeciesID: "PG-118")

    XCTAssertNil(store.errorMessage)
    XCTAssertEqual(store.state.ownedCreatures[0].speciesID, "PG-118")
    XCTAssertEqual(store.evolutionFeedback?.toSpeciesID, "PG-118")
    XCTAssertEqual(
      GameStore(persistence: persistence).state.ownedCreatures[0].speciesID, "PG-118")
  }


  @MainActor
  func testPendingChoicesCoverWaitingCreaturesBeyondTheCurrentSelection() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let calm = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 1))
    let waiting = OwnedCreature(
      id: UUID(), speciesID: "PG-087", originSpeciesID: "PG-040", level: 25, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 2))
    var state = GameState()
    state.ownedCreatures = [calm, waiting]
    state.discoveredSpeciesIDs = ["PG-001", "PG-040", "PG-087"]
    try persistence.save(state)

    let store = GameStore(persistence: persistence)

    XCTAssertEqual(store.currentCreatureID, calm.id)
    XCTAssertNil(store.pendingEvolutionChoice)
    XCTAssertEqual(store.pendingEvolutionChoices.map(\.creatureID), [waiting.id])

    store.chooseEvolution(creatureID: waiting.id, toSpeciesID: "PG-088")

    XCTAssertNil(store.errorMessage)
    XCTAssertTrue(store.pendingEvolutionChoices.isEmpty)
    XCTAssertEqual(store.state.ownedCreatures[1].speciesID, "PG-088")
    XCTAssertEqual(store.currentCreatureID, calm.id)
  }

  @MainActor
  func testLockedPersistenceReportsAnExplicitReasonForTheNewEvolutionAPIs() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    try Data("not json".utf8).write(to: persistence.fileURL)
    let store = GameStore(persistence: persistence)
    let creatureID = UUID()

    store.chooseEvolution(creatureID: creatureID, toSpeciesID: "PG-118")
    XCTAssertEqual(store.errorMessage, GameStore.persistenceLockedActionMessage)

    store.errorMessage = nil
    store.chooseEvolution(creatureID: creatureID, toSpeciesID: "PG-062")
    XCTAssertEqual(store.errorMessage, GameStore.persistenceLockedActionMessage)
  }

  @MainActor
  func testFeedThatCreatesPendingChoiceConsumesExactlyOneItemAndStopsRepeatEligibility() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002",
      level: 14, experience: 1_390, affection: 0, nickname: nil,
      uniqueColor: false, acquiredAt: .now)
    var state = GameState()
    state.ownedCreatures = [creature]
    state.discoveredSpeciesIDs = [creature.speciesID]
    state.inventory.largeFood = 2
    try persistence.save(state)
    let store = GameStore(persistence: persistence)

    let succeeded = store.feedLargeCurrent()
    let canRepeat = FeedRepeatPolicy.canRepeat(
      creature: store.currentCreature, isPersistenceLocked: store.isPersistenceLocked,
      hasPendingEvolutionChoice: store.pendingEvolutionChoice != nil,
      hasPendingMutationOffer: store.pendingMutationOffer != nil)

    XCTAssertTrue(succeeded)
    XCTAssertEqual(store.state.inventory.largeFood, 1)
    XCTAssertNotNil(store.pendingEvolutionChoice)
    XCTAssertFalse(canRepeat)
  }

  func testExplicitPersistenceCreatesMissingParentDirectoryOnFirstSave() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let parent = root.appending(path: "fresh/nested")
    let persistence = GamePersistence(fileURL: parent.appending(path: "state.json"))
    var state = GameState()
    state.tokenBalance = 1_234_567

    XCTAssertFalse(FileManager.default.fileExists(atPath: parent.path))
    try persistence.save(state)

    XCTAssertTrue(FileManager.default.fileExists(atPath: persistence.fileURL.path))
    XCTAssertEqual(try persistence.load(), state)
  }

  @MainActor
  func testFirstPullDoesNotImplicitlyCreateRepresentative() throws {
    let persistence = try copiedV2Fixture()
    var state = try persistence.load()
    state.ownedCreatures = []
    state.discoveredSpeciesIDs = []
    state.representativeCreatureID = nil
    try persistence.save(state)
    let store = GameStore(persistence: persistence)

    store.pull()

    XCTAssertTrue(store.currentCreature != nil)
    XCTAssertTrue(store.state.representativeCreatureID == nil)
  }

  @MainActor
  func testFailedActionsLeaveCurrentAndRepresentativeUnchanged() throws {
    let persistence = try copiedV2Fixture()
    var state = try persistence.load()
    state.tokenBalance = 0
    state.inventory.largeFood = 0
    try persistence.save(state)
    let store = GameStore(persistence: persistence)
    store.selectNextCreature()
    let current = store.currentCreatureID
    let representative = store.state.representativeCreatureID

    store.pull()
    XCTAssertTrue(store.currentCreatureID == current)
    XCTAssertTrue(store.state.representativeCreatureID == representative)
    store.feedLargeCurrent()
    XCTAssertTrue(store.currentCreatureID == current)
    XCTAssertTrue(store.state.representativeCreatureID == representative)
  }

  @MainActor
  func testMissingRepresentativeUsesStableOwnedFallbackWithoutPersistenceChurn() throws {
    let persistence = try copiedV2Fixture()
    var state = try persistence.load()
    state.representativeCreatureID = nil
    state.ownedCreatures.reverse()
    try persistence.save(state)

    let store = GameStore(persistence: persistence)

    XCTAssertTrue(
      store.currentCreatureID == UUID(uuidString: "11111111-1111-1111-1111-111111111111"))
    XCTAssertTrue(store.state.representativeCreatureID == nil)
  }

  @MainActor
  func testStaleRepresentativeUUIDSurvivesUnrelatedMutationsUntilExplicitSelection() throws {
    let persistence = try copiedV2Fixture()
    var state = try persistence.load()
    let staleID = UUID()
    state.representativeCreatureID = staleID
    state.inventory.largeFood = 1
    try persistence.save(state)

    let store = GameStore(persistence: persistence)
    XCTAssertTrue(store.errorMessage == nil)
    XCTAssertTrue(store.state.ownedCreatures.count == 2)
    XCTAssertTrue(store.state.representativeCreatureID == staleID)
    XCTAssertTrue(
      store.currentCreatureID == UUID(uuidString: "11111111-1111-1111-1111-111111111111"))

    let event = TokenUsageEvent(
      id: UUID(), provider: .claude, sourceEventID: "stale-representative-event", occurredAt: .now,
      inputTokens: 1, cachedTokens: 0, outputTokens: 0
    )
    store.ingestCollectedEvents([event])
    store.feedLargeCurrent()

    let reloaded = GameStore(persistence: persistence)
    let raw = try JSONDecoder.punchGrow.decode(
      GameState.self, from: Data(contentsOf: persistence.fileURL))
    XCTAssertTrue(reloaded.state.representativeCreatureID == staleID)
    XCTAssertTrue(raw.representativeCreatureID == staleID)
    XCTAssertTrue(
      reloaded.currentCreatureID == UUID(uuidString: "11111111-1111-1111-1111-111111111111"))

    reloaded.setCurrentAsRepresentative()
    XCTAssertTrue(reloaded.state.representativeCreatureID == reloaded.currentCreatureID)
    XCTAssertTrue(
      GameStore(persistence: persistence).state.representativeCreatureID
        == reloaded.currentCreatureID)
  }

  @MainActor
  func testCodexProtocolFailuresPublishOnlyFixedSanitizedErrors() {
    var lifecycle: [IntegrationStatus] = []
    let service = CodexManagedService(
      onLifecycleState: { lifecycle.append($0) }, onSnapshot: { _ in .credited })
    let secret = "/private/work/project prompt contents"

    service.consume(Data("{not-json \(secret)\n".utf8))

    XCTAssertTrue(service.status == CodexPublishedFailure.protocolFailure.message)
    XCTAssertTrue(!service.status.contains(secret))
    XCTAssertTrue(lifecycle.last == .error(CodexPublishedFailure.protocolFailure.message))

    let prior = service.status
    service.consumeStderr(Data("stderr \(secret)".utf8))
    XCTAssertTrue(service.status == prior)
  }

  @MainActor
  func testCodexRPCErrorAndOversizedStdoutNeverPublishRawContent() throws {
    let secret = "/private/work raw prompt and json"
    var lifecycle: [IntegrationStatus] = []
    let rpc = CodexManagedService(onLifecycleState: { lifecycle.append($0) }, onSnapshot: { _ in .credited })
    rpc.consume(Data("{\"id\":2,\"error\":{\"message\":\"\(secret)\"}}\n".utf8))
    XCTAssertTrue(rpc.status == CodexPublishedFailure.protocolFailure.message)
    XCTAssertTrue(!rpc.status.contains(secret))

    let oversized = CodexManagedService(onSnapshot: { _ in .credited })
    oversized.consume(
      Data(repeating: 0x61, count: CodexManagedService.maximumProtocolLineBytes / 2 + 1))
    oversized.consume(
      Data(repeating: 0x62, count: CodexManagedService.maximumProtocolLineBytes / 2 + 1))
    XCTAssertTrue(oversized.status == CodexPublishedFailure.protocolFailure.message)
  }

  @MainActor
  func testCodexRejectsFilesAsWorkspacesAndUnexpectedExitCanReturnToStopped() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try Data("workspace path secret".utf8).write(to: file)
    let service = CodexManagedService(onSnapshot: { _ in .credited })

    service.start(workspace: file.path)
    XCTAssertTrue(service.status == CodexPublishedFailure.invalidWorkspace.message)
    service.processDidExitUnexpectedly()
    XCTAssertTrue(service.status == CodexPublishedFailure.unexpectedExit.message)
    service.stop()
    XCTAssertTrue(service.status == "중지됨")
  }

  @MainActor
  func testWorkspaceAndPromptNeverEnterGameSaveOrBackup() throws {
    let secretWorkspace = "/private/workspace-secret"
    let secretPrompt = "prompt-secret-content"
    let persistence = try copiedV2Fixture()
    let store = GameStore(persistence: persistence)
    let service = CodexManagedService(onSnapshot: { _ in .credited })
    let backup = FileManager.default.temporaryDirectory.appending(path: "\(UUID()).pgrow")

    service.start(workspace: secretWorkspace)
    service.submit(secretPrompt)
    store.exportBackup(to: backup)

    let saveText = String(decoding: try Data(contentsOf: persistence.fileURL), as: UTF8.self)
    let backupText = String(decoding: try Data(contentsOf: backup), as: UTF8.self)
    XCTAssertTrue(!service.status.contains(secretWorkspace))
    XCTAssertTrue(!service.status.contains(secretPrompt))
    XCTAssertTrue(!saveText.contains(secretWorkspace) && !saveText.contains(secretPrompt))
    XCTAssertTrue(!backupText.contains(secretWorkspace) && !backupText.contains(secretPrompt))
  }

  func testCollectorGenerationGateAllowsRestartAndRejectsStaleCallbacks() {
    var gate = CollectorListenerGenerationGate()
    let failed = gate.begin()
    XCTAssertTrue(gate.accepts(failed))
    XCTAssertTrue(gate.finish(failed))

    let restarted = gate.begin()
    XCTAssertTrue(restarted != failed)
    XCTAssertTrue(!gate.accepts(failed))
    XCTAssertTrue(!gate.finish(failed))
    XCTAssertTrue(gate.accepts(restarted))
  }

  @MainActor
  func testInjectedCodexTransportContainsSecretsWhilePublishedAndPersistedStateDoNot() async throws {
    let workspace = FileManager.default.temporaryDirectory.appending(path: "workspace-\(UUID())")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let prompt = "prompt-marker-\(UUID())"
    let transport = FakeCodexTransport()
    let projection = IntegrationStatusProjection()
    let service = CodexManagedService(
      onLifecycleState: { status in
        switch status {
        case .listening: projection.serviceDidStart(.codex)
        case .stopped: projection.serviceDidStop(.codex)
        case .recentlyReceiving: break
        case .error(let message): projection.serviceDidFail(.codex, message: message)
        }
      },
      makeTransport: { transport },
      prepareExecutable: { _ in URL(fileURLWithPath: "/usr/bin/true") },
      onSnapshot: { _ in .credited }
    )

    service.start(workspace: workspace.path)
    await waitUntil { service.isReady }
    XCTAssertTrue(service.isReady)
    service.submit(prompt)

    let writes = String(
      decoding: transport.writes.reduce(into: Data()) { $0.append($1) }, as: UTF8.self
    )
    .replacingOccurrences(of: "\\/", with: "/")
    XCTAssertTrue(writes.contains(workspace.path))
    XCTAssertTrue(writes.contains(prompt))
    XCTAssertTrue(!service.status.contains(workspace.path) && !service.status.contains(prompt))
    XCTAssertTrue(projection.status(for: .codex) == .listening)

    let encoded = String(decoding: try JSONEncoder.punchGrow.encode(GameState()), as: UTF8.self)
    let envelope = BackupEnvelope(
      format: "punchgrow-backup-v1", exportedAt: .now, state: GameState())
    let backup = String(decoding: try JSONEncoder.punchGrow.encode(envelope), as: UTF8.self)
    XCTAssertTrue(!encoded.contains(workspace.path) && !encoded.contains(prompt))
    XCTAssertTrue(!backup.contains(workspace.path) && !backup.contains(prompt))
  }

  @MainActor
  func testAppStartPolicyStartsCollectorOnceAndNeverStartsCodexImplicitly() {
    let collector = FakeCollectorStarter()
    let codex = FakeExplicitStarter()
    let policy = AppServiceStartPolicy()

    policy.startCollector(collector)
    policy.startCollector(collector)

    XCTAssertTrue(collector.startCount == 1)
    XCTAssertTrue(codex.startCount == 0)
    codex.start()
    XCTAssertTrue(codex.startCount == 1)
  }

  @MainActor
  func testCollectorCommandUsesLiteralQuotedHeaderAndMetricsEndpoint() {
    let command = LocalCollectorService.command(secret: "test-secret")
    XCTAssertTrue(command.contains("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics"))
    XCTAssertTrue(command.contains("OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer test-secret'"))
    XCTAssertTrue(command.contains("OTEL_LOGS_EXPORTER=none"))
    XCTAssertTrue(command.contains("OTEL_TRACES_EXPORTER=none"))
    XCTAssertTrue(command.contains("OTEL_METRICS_INCLUDE_SESSION_ID=false"))
    XCTAssertTrue(command.contains("OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false"))
    XCTAssertTrue(command.contains("OTEL_METRICS_INCLUDE_VERSION=false"))
    XCTAssertTrue(command.contains("OTEL_METRICS_INCLUDE_ENTRYPOINT=false"))
    XCTAssertTrue(command.contains("OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false"))
    XCTAssertFalse(command.contains("OTEL_RESOURCE_ATTRIBUTES"))
    XCTAssertFalse(command.contains("ENABLE_BETA"))
    XCTAssertFalse(command.contains("Bearer%20"))
  }

  func testCodexResolverFindsHomeCandidatesWithEmptyPath() throws {
    for relativePath in ["homebrew/bin/codex", ".local/bin/codex"] {
      let home = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      let executable = home.appending(path: relativePath)
      try FileManager.default.createDirectory(
        at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
      FileManager.default.createFile(
        atPath: executable.path, contents: Data("#!/bin/sh\nexit 0\n".utf8))
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: executable.path)

      let resolved = try resolveCodexExecutable(environment: ["PATH": ""], homeDirectory: home)
      XCTAssertEqual(resolved.standardizedFileURL, executable.standardizedFileURL)
    }
  }

  @MainActor
  func testCodexPublishesReadyOnlyAfterThreadStartAndTimesOutWhileStarting() async throws {
    let workspace = FileManager.default.temporaryDirectory.appending(path: "workspace-\(UUID())")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let transport = SilentCodexTransport()
    var lifecycle: [IntegrationStatus] = []
    let service = CodexManagedService(
      onLifecycleState: { lifecycle.append($0) },
      makeTransport: { transport },
      prepareExecutable: { _ in URL(fileURLWithPath: "/usr/bin/true") },
      onSnapshot: { _ in .credited })

    service.start(workspace: workspace.path)
    XCTAssertTrue(service.isStarting)
    XCTAssertFalse(service.isReady)
    XCTAssertEqual(service.status, "관리형 Codex 시작 중")
    XCTAssertTrue(lifecycle.isEmpty)

    await waitUntil { service.isRunning }
    XCTAssertTrue(service.isRunning)

    service.startupDidTimeOut()
    XCTAssertFalse(service.isRunning)
    XCTAssertEqual(service.status, CodexPublishedFailure.startupTimeout.message)
    XCTAssertEqual(lifecycle.last, .error(CodexPublishedFailure.startupTimeout.message))
  }

  @MainActor
  func testCodexSlowPreparationDoesNotBlockStartingUI() throws {
    let workspace = FileManager.default.temporaryDirectory.appending(path: "workspace-\(UUID())")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let service = CodexManagedService(
      prepareExecutable: { _ in
        try await Task.sleep(for: .seconds(10))
        return URL(fileURLWithPath: "/usr/bin/true")
      },
      onSnapshot: { _ in .credited })

    service.start(workspace: workspace.path)
    XCTAssertTrue(service.isStarting)
    XCTAssertEqual(service.status, "관리형 Codex 시작 중")
    service.stop()
    XCTAssertEqual(service.status, "중지됨")
  }

  func testHungCodexVersionProbeHonorsDeadline() async throws {
    let executable = FileManager.default.temporaryDirectory.appending(path: "codex-\(UUID())")
    try Data("#!/bin/sh\nwhile :; do :; done\n".utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: executable.path)
    let started = Date()

    do {
      _ = try await prepareCodexExecutable(
        deadline: started.addingTimeInterval(0.15), resolver: { executable })
      XCTFail("hung --version probe must time out")
    } catch {
      XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)
    }
  }

  @MainActor
  func testCodexSnapshotPersistenceFailureIsPublishedSanitized() {
    let service = CodexManagedService(
      onSnapshot: { _ in .failed })
    let line = Data("""
      {"method":"thread/tokenUsage/updated","params":{"threadId":"private-thread","tokenUsage":{"total":{"inputTokens":1,"cachedInputTokens":0,"outputTokens":0}}}}
      \n
      """.utf8)

    service.consume(line)
    XCTAssertEqual(service.status, CodexPublishedFailure.persistence.message)
    XCTAssertFalse(service.status.contains("private-thread"))
  }

  @MainActor
  func testOnlyCreditedEventsInvokeContentFreeCallback() throws {
    var callbacks: [(TokenProvider, Date, Int)] = []
    let creditedAt = Date(timeIntervalSince1970: 2_000)
    let store = GameStore(
      persistence: try copiedV2Fixture(),
      now: { creditedAt },
      onCreditedEvent: { callbacks.append(($0, $1, $2)) }
    )
    let event = TokenUsageEvent(
      id: UUID(), provider: .claude, sourceEventID: "new-event", occurredAt: creditedAt,
      inputTokens: 9, cachedTokens: 1, outputTokens: 2
    )

    store.ingestCollectedEvents([event, event])

    XCTAssertTrue(callbacks.count == 1)
    XCTAssertTrue(callbacks.first?.0 == .claude)
    XCTAssertTrue(callbacks.first?.1 == creditedAt)
    XCTAssertTrue(callbacks.first?.2 == 12)
  }

  @MainActor
  func testLockedPersistenceRejectsCollectorAcknowledgementWithSanitizedError() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let store = GameStore(persistence: GamePersistence(fileURL: directory))
    let event = TokenUsageEvent(
      id: UUID(), provider: .claude, sourceEventID: "event", occurredAt: .now,
      inputTokens: 1, cachedTokens: 0, outputTokens: 0)

    XCTAssertEqual(
      store.ingestCollectedEvents([event]),
      .failed)
    XCTAssertEqual(store.errorMessage, TokenIngestionResult.persistenceFailureMessage)
    XCTAssertFalse(store.errorMessage?.contains(directory.path) == true)
  }

  @MainActor
  func testIntegrationStatusExpiresAndHonorsPrecedenceAndGeneration() {
    let clock = TestClock(Date(timeIntervalSince1970: 1_000))
    let scheduler = TestIntegrationScheduler(clock: clock)
    let projection = IntegrationStatusProjection(now: { clock.now }, scheduler: scheduler)

    projection.serviceDidStart(.claude)
    XCTAssertTrue(projection.status(for: .claude) == .listening)
    projection.credited(source: .claude, creditedAt: clock.now, amount: 7)
    XCTAssertTrue(projection.status(for: .claude) == .recentlyReceiving)
    projection.serviceDidStart(.claude)
    XCTAssertTrue(projection.status(for: .claude) == .recentlyReceiving)

    clock.now = clock.now.addingTimeInterval(9.999)
    scheduler.runDueActions()
    XCTAssertTrue(projection.status(for: .claude) == .recentlyReceiving)
    clock.now = Date(timeIntervalSince1970: 1_010)
    scheduler.runDueActions()
    XCTAssertTrue(projection.status(for: .claude) == .listening)

    projection.credited(source: .claude, creditedAt: clock.now, amount: 1)
    projection.serviceDidFail(.claude, message: "boom")
    XCTAssertTrue(projection.status(for: .claude) == .error("boom"))
    projection.credited(source: .claude, creditedAt: clock.now, amount: 1)
    XCTAssertTrue(projection.status(for: .claude) == .recentlyReceiving)
    projection.serviceDidFail(.claude, message: "boom")
    projection.serviceDidStart(.claude)
    XCTAssertTrue(projection.status(for: .claude) == .listening)
    clock.now = clock.now.addingTimeInterval(10)
    scheduler.runDueActions()
    XCTAssertTrue(projection.status(for: .claude) == .listening)

    projection.credited(source: .claude, creditedAt: clock.now, amount: 1)
    projection.serviceDidStop(.claude)
    XCTAssertTrue(projection.status(for: .claude) == .stopped)
  }

}

private func copiedV2Fixture() throws -> GamePersistence {
  let source = try XCTUnwrap(
    Bundle.module.url(
      forResource: "pre-redesign-v2-state", withExtension: "json", subdirectory: "Fixtures"
    ) ?? Bundle.module.url(forResource: "pre-redesign-v2-state", withExtension: "json"))
  let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let destination = directory.appending(path: "state.json")
  try FileManager.default.copyItem(at: source, to: destination)
  return GamePersistence(fileURL: destination)
}

private struct GroupedFixture {
  let persistence: GamePersistence
  let catalog: [CreatureSpecies]
  let group: [OwnedCreature]
  let other: OwnedCreature
}

/// 시작종 두 계보 — 첫 계보에 3마리, 둘째 계보에 1마리.
private func groupedPersistence() throws -> GroupedFixture {
  let species = CreatureSpecies(
    id: "PG-001", koName: "에일루", enName: "Eilu", lineageId: "PG-L001",
    rarity: "PROCESS", stage: 1, category: "start", bodyForm: "fox",
    identity: "test", lore: "test", imagePath: "test")
  let otherSpecies = CreatureSpecies(
    id: "PG-002", koName: "다른 종", enName: "Other", lineageId: "PG-L002",
    rarity: "PROCESS", stage: 1, category: "start", bodyForm: "bird",
    identity: "test", lore: "test", imagePath: "test")
  let group = (1...3).map { index in
    OwnedCreature(
      id: UUID(), speciesID: species.id, originSpeciesID: species.id,
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: TimeInterval(index)))
  }
  let other = OwnedCreature(
    id: UUID(), speciesID: otherSpecies.id, originSpeciesID: otherSpecies.id,
    level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
    acquiredAt: Date(timeIntervalSince1970: 10))
  let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
  var state = GameState()
  state.inventory.largeFood = 5
  state.ownedCreatures = group + [other]
  state.discoveredSpeciesIDs = [species.id, otherSpecies.id]
  try persistence.save(state)
  return GroupedFixture(
    persistence: persistence, catalog: [species, otherSpecies], group: group, other: other)
}

@MainActor
private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
  for _ in 0..<100 where !condition() { await Task.yield() }
}

@MainActor
private final class TestClock {
  var now: Date
  init(_ now: Date) { self.now = now }
}

@MainActor
private final class TestIntegrationScheduler: IntegrationStatusScheduling {
  private struct Entry {
    let date: Date
    let cancellation: TestCancellation
    let action: @MainActor () -> Void
  }

  private let clock: TestClock
  private var entries: [Entry] = []

  init(clock: TestClock) { self.clock = clock }

  func schedule(at date: Date, action: @escaping @MainActor () -> Void)
    -> IntegrationStatusCancellation
  {
    let cancellation = TestCancellation()
    entries.append(Entry(date: date, cancellation: cancellation, action: action))
    return cancellation
  }

  func runDueActions() {
    let due = entries.filter { $0.date <= clock.now }
    entries.removeAll { $0.date <= clock.now }
    for entry in due where !entry.cancellation.isCancelled {
      entry.action()
    }
  }
}

private final class TestCancellation: IntegrationStatusCancellation {
  private(set) var isCancelled = false
  func cancel() { isCancelled = true }
}

@MainActor
private final class FakeCodexTransport: CodexTransport {
  var onStdout: ((Data) -> Void)?
  var onStderr: ((Data) -> Void)?
  var onExit: (() -> Void)?
  private(set) var writes: [Data] = []

  func start(executable: URL) throws {}

  func write(_ data: Data) {
    writes.append(data)
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["method"] as? String == "thread/start"
    else { return }
    onStdout?(Data("{\"id\":2,\"result\":{\"thread\":{\"id\":\"raw-thread-secret\"}}}\n".utf8))
  }

  func stop() {}
}

@MainActor
private final class SilentCodexTransport: CodexTransport {
  var onStdout: ((Data) -> Void)?
  var onStderr: ((Data) -> Void)?
  var onExit: (() -> Void)?
  func start(executable: URL) throws {}
  func write(_ data: Data) {}
  func stop() {}
}

@MainActor
private final class FakeCollectorStarter: AppCollectorStarting {
  private(set) var startCount = 0
  func start() { startCount += 1 }
}

@MainActor
private final class FakeExplicitStarter {
  private(set) var startCount = 0
  func start() { startCount += 1 }
}
