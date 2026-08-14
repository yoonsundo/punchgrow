import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 진화도감 카드의 소유 상태 판정.
///
/// 도감은 종 단위 카드인데 보유는 개체 단위다. 두 축이 어긋나면 실제로 갖고 있는 종이
/// "잠금"으로 표시된다 — 변이 재도전·계승으로 얻은 개체가 정확히 그 경우다.
final class EvolutionDexOwnershipTests: XCTestCase {

  private let acquiredAt = Date(timeIntervalSince1970: 1_800_000_000)

  private func creature(
    _ speciesID: String,
    origin: String?,
    level: Int = 40,
    offset: TimeInterval = 0
  ) -> OwnedCreature {
    OwnedCreature(
      id: UUID(), speciesID: speciesID, originSpeciesID: origin, level: level, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: acquiredAt.addingTimeInterval(offset))
  }

  private func entries(
    for creature: OwnedCreature,
    owned: [OwnedCreature],
    discovered: Set<String>
  ) throws -> [String: EvolutionDexEntry] {
    let catalog = try CreatureCatalog.load()
    let presentation = try XCTUnwrap(
      EvolutionDexPresentation.make(
        creature: creature,
        catalog: catalog,
        discoveredSpeciesIDs: discovered,
        ownedCreatures: owned
      ))
    return Dictionary(
      uniqueKeysWithValues: presentation.stages.flatMap(\.entries).map { ($0.id, $0) })
  }

  /// 변이체를 보고 있고, 같은 계보의 종착 개체를 따로 보유한 상태. 사용자가 실제로 마주친
  /// 상황이며 소유 표시 네 상태가 한 번에 나타난다. 종착 개체를 함께 돌려줘 각 카드가
  /// 가리키는 개체까지 단언할 수 있게 한다.
  private func mutantViewOfLineage() throws -> (OwnedCreature, [String: EvolutionDexEntry]) {
    let mutant = creature("PG-235", origin: "PG-024", level: 1, offset: 60)
    let terminal = creature("PG-092", origin: "PG-024", level: 40)
    return (
      terminal,
      try entries(
        for: mutant,
        owned: [terminal, mutant],
        discovered: ["PG-024", "PG-090", "PG-091", "PG-092", "PG-235"]
      )
    )
  }

  /// 이 버그의 재현. PG-235는 현재 개체가 거쳐 온 모습이 아니지만 별도 개체로 보유 중이다.
  func testMutantOwnedAsAnotherCreatureIsNotLocked() throws {
    let current = creature("PG-092", origin: "PG-024")
    let mutant = creature("PG-235", origin: "PG-024", level: 1, offset: 60)

    let entries = try entries(
      for: current,
      owned: [current, mutant],
      discovered: ["PG-024", "PG-090", "PG-091", "PG-092", "PG-235"]
    )

    let mutantEntry = try XCTUnwrap(entries["PG-235"])
    XCTAssertFalse(mutantEntry.isFormOwned, "현재 개체가 거쳐 온 모습은 아니다")
    XCTAssertTrue(mutantEntry.isOwnedApartFromCurrent)
    XCTAssertEqual(mutantEntry.ownership, .otherCreature)
    XCTAssertNotEqual(mutantEntry.ownership, .locked, "보유 중인데 잠금으로 읽히면 안 된다")
    XCTAssertEqual(mutantEntry.ownedCreatureID, mutant.id)
  }

  /// 아무도 갖고 있지 않으면 그대로 잠금이어야 한다. 잠금 자체를 없애 버리면 안 된다.
  func testUnownedMutantStaysLocked() throws {
    let current = creature("PG-092", origin: "PG-024")

    let entries = try entries(
      for: current,
      owned: [current],
      discovered: ["PG-024", "PG-090", "PG-091", "PG-092"]
    )

    let mutantEntry = try XCTUnwrap(entries["PG-235"])
    XCTAssertEqual(mutantEntry.ownership, .locked)
    XCTAssertNil(mutantEntry.ownedCreatureID)
    XCTAssertFalse(mutantEntry.isOwnedApartFromCurrent)
  }

  /// 현재 모습과 거쳐 온 모습의 기존 판정이 바뀌지 않아야 한다.
  func testCurrentAndReachedFormsKeepTheirOwnership() throws {
    let current = creature("PG-092", origin: "PG-024")
    let mutant = creature("PG-235", origin: "PG-024", level: 1, offset: 60)

    let entries = try entries(
      for: current,
      owned: [current, mutant],
      discovered: ["PG-024", "PG-090", "PG-091", "PG-092", "PG-235"]
    )

    XCTAssertEqual(try XCTUnwrap(entries["PG-092"]).ownership, .current)
    XCTAssertEqual(try XCTUnwrap(entries["PG-024"]).ownership, .reachedForm)
    XCTAssertEqual(try XCTUnwrap(entries["PG-091"]).ownership, .reachedForm)
  }

  /// 거쳐 온 모습이면서 동시에 별도 개체로도 보유 중일 때는 미리보기가 우선한다.
  /// 두 동작이 같은 카드에서 다투면 안 되므로 판정 순서를 고정한다.
  func testReachedFormWinsWhenAlsoOwnedSeparately() throws {
    let current = creature("PG-092", origin: "PG-024")
    let duplicateRoot = creature("PG-024", origin: "PG-024", level: 1, offset: 60)

    let entries = try entries(
      for: current,
      owned: [current, duplicateRoot],
      discovered: ["PG-024", "PG-090", "PG-091", "PG-092"]
    )

    let rootEntry = try XCTUnwrap(entries["PG-024"])
    XCTAssertTrue(rootEntry.isFormOwned)
    XCTAssertEqual(rootEntry.ownership, .reachedForm)
    XCTAssertTrue(rootEntry.canPreviewForm, "미리보기 동작이 유지된다")
  }

  /// 변이체를 보고 있을 때, 같은 계보의 종착 개체가 이미 지나온 중간 단계는 잠금이 아니어야
  /// 한다. 변이는 시작종에서 곧장 갈라져 나오므로 그 단계들을 지나온 적이 없지만, 계정
  /// 도감에는 이미 남아 있기 때문이다.
  func testStagesReachedByAnotherCreatureAreNotLocked() throws {
    let (terminal, entries) = try mutantViewOfLineage()

    for stageID in ["PG-090", "PG-091"] {
      let entry = try XCTUnwrap(entries[stageID])
      XCTAssertFalse(entry.isFormOwned, "변이체는 이 단계를 지나온 적이 없다")
      XCTAssertEqual(entry.ownership, .otherCreature, "\(stageID)이 잠금이면 회귀다")
      XCTAssertEqual(entry.ownedCreatureID, terminal.id, "그 단계를 지나온 개체를 가리킨다")
      XCTAssertFalse(entry.canPreviewForm, "미리보기 범위는 넓히지 않는다")
    }
    XCTAssertEqual(try XCTUnwrap(entries["PG-235"]).ownership, .current)
    XCTAssertEqual(try XCTUnwrap(entries["PG-024"]).ownership, .reachedForm)
  }

  /// 실물 개체가 있으면 그쪽이 우선한다. 지나온 개체로 보내면 엉뚱한 곳에 도착한다.
  func testRealCreatureWinsOverTheOneThatMerelyPassedThrough() throws {
    let (terminal, entries) = try mutantViewOfLineage()

    let terminalEntry = try XCTUnwrap(entries["PG-092"])
    XCTAssertEqual(terminalEntry.ownership, .otherCreature)
    XCTAssertEqual(terminalEntry.ownedCreatureID, terminal.id)
  }

  /// 어떤 개체도 닿은 적 없는 종은 여전히 잠금이어야 한다. 잠금 자체를 없애면 안 된다.
  func testSpeciesNoCreatureEverReachedStaysLocked() throws {
    // 시작종만 가진 개체. 2단계 이후는 아무도 도달하지 않았다.
    let starter = creature("PG-024", origin: "PG-024", level: 1)

    let entries = try entries(
      for: starter,
      owned: [starter],
      discovered: ["PG-024"]
    )

    for unreached in ["PG-090", "PG-091", "PG-092", "PG-235"] {
      let entry = try XCTUnwrap(entries[unreached])
      XCTAssertEqual(entry.ownership, .locked, "\(unreached)은 아무도 도달한 적이 없다")
      XCTAssertNil(entry.ownedCreatureID)
    }
    XCTAssertEqual(try XCTUnwrap(entries["PG-024"]).ownership, .current)
  }

  /// 접근성 문구가 네 상태를 각각 다르게 읽어 준다. 잠금 문구가 보유 상태로 새어 나가면
  /// 화면은 고쳐졌는데 보이스오버만 여전히 "선택할 수 없음"이라고 말하게 된다.
  func testOwnershipDescriptionsAreDistinctForEveryState() throws {
    let catalog = try CreatureCatalog.load()
    let species = try XCTUnwrap(catalog.first { $0.id == "PG-235" })

    func entry(isCurrent: Bool, isFormOwned: Bool, ownedID: UUID?) -> EvolutionDexEntry {
      EvolutionDexEntry(
        species: species, parentNames: [], isCurrent: isCurrent, isDiscovered: true,
        isFormOwned: isFormOwned, ownedCreatureID: ownedID)
    }

    let ownedID = UUID()
    let current = entry(isCurrent: true, isFormOwned: true, ownedID: ownedID)
    let reachedForm = entry(isCurrent: false, isFormOwned: true, ownedID: nil)
    let otherCreature = entry(isCurrent: false, isFormOwned: false, ownedID: ownedID)
    let locked = entry(isCurrent: false, isFormOwned: false, ownedID: nil)

    XCTAssertEqual(current.ownership, .current)
    XCTAssertEqual(reachedForm.ownership, .reachedForm)
    XCTAssertEqual(otherCreature.ownership, .otherCreature)
    XCTAssertEqual(locked.ownership, .locked)

    let descriptions = [current, reachedForm, otherCreature, locked].map(\.ownershipDescription)
    XCTAssertEqual(Set(descriptions).count, 4)
    XCTAssertFalse(
      otherCreature.ownershipDescription.contains("선택할 수 없음"),
      "보유 중인 개체가 잠금 문구로 읽히면 안 된다")
  }
}
