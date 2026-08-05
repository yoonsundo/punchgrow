import Foundation
import XCTest

@testable import PunchGrowMenuBar

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

  func testOriginPityGuaranteesOrigin() throws {
    var state = GameState()
    state.pullsSinceOrigin = GameState.originPityThreshold
    let origin = CreatureSpecies(
      id: "PG-999", koName: "테스트", enName: "Test", rarity: "ORIGIN", stage: 1,
      category: "start", bodyForm: "test", identity: "test", lore: "test", imagePath: "test"
    )
    var generator = SeededGenerator(seed: 42)
    let creature = try GameEngine.pull(state: &state, catalog: [origin], generator: &generator)
    XCTAssertTrue(creature.speciesID == origin.id)
    XCTAssertTrue(state.pullsSinceOrigin == 0)
  }

  func testOriginPityFailsClosedWithoutOriginCatalogEntry() {
    var state = GameState()
    state.pullsSinceOrigin = GameState.originPityThreshold
    let process = CreatureSpecies(
      id: "PG-001", koName: "테스트", enName: "Test", rarity: "PROCESS", stage: 1,
      category: "start", bodyForm: "test", identity: "test", lore: "test", imagePath: "test"
    )
    var generator = SeededGenerator(seed: 42)
    XCTAssertThrowsError(
      try GameEngine.pull(state: &state, catalog: [process], generator: &generator)
    ) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog)
    }
  }

  func testRepeatedSpeciesAcquisitionsRemainDistinctOwnedInstances() throws {
    var state = GameState()
    state.tokenBalance = GameState.gachaCost * 2
    state.pullsSinceOrigin = GameState.originPityThreshold
    let origin = CreatureSpecies(
      id: "PG-999", koName: "테스트", enName: "Test", rarity: "ORIGIN", stage: 1,
      category: "start", bodyForm: "test", identity: "test", lore: "test", imagePath: "test"
    )
    var generator = SeededGenerator(seed: 42)

    let first = try GameEngine.pull(state: &state, catalog: [origin], generator: &generator)
    state.pullsSinceOrigin = GameState.originPityThreshold
    let second = try GameEngine.pull(state: &state, catalog: [origin], generator: &generator)

    XCTAssertTrue(first.speciesID == second.speciesID)
    XCTAssertTrue(first.id != second.id)
    XCTAssertTrue(Set(state.ownedCreatures.map(\.id)).count == 2)
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
