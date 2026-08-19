import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 같은 시작종 계보 안의 개체 전환 표시.
///
/// 변이 재도전·계승은 같은 계보에 개체를 더한다. 그런데 좌우 화살표는 계보당 1마리만
/// 순회하므로(`GameEngine.visibleOwnedCreatures`), 2번째 이후 개체는 그룹 페이저가
/// 없으면 화면에서 영영 선택할 수 없다. 이 파일은 그 페이저의 노출 조건을 고정한다.
final class GroupNavigationPresentationTests: XCTestCase {

  private let acquiredAt = Date(timeIntervalSince1970: 1_800_000_000)

  private func creature(
    _ speciesID: String,
    origin: String?,
    level: Int = 20,
    offset: TimeInterval = 0
  ) -> OwnedCreature {
    OwnedCreature(
      id: UUID(), speciesID: speciesID, originSpeciesID: origin, level: level, experience: 7,
      affection: 42, nickname: nil, uniqueColor: false,
      acquiredAt: acquiredAt.addingTimeInterval(offset))
  }

  private func state(with creatures: [OwnedCreature]) -> GameState {
    var state = GameState()
    state.ownedCreatures = creatures
    state.tokenBalance = 10_000_000
    state.inventory.largeFood = 30
    return state
  }

  @MainActor
  private func makeStore(creatures: [OwnedCreature], directory: URL) throws -> GameStore {
    let catalog = try CreatureCatalog.load()
    let persistence = GamePersistence(fileURL: directory.appending(path: "state.json"))
    var seeded = state(with: creatures)
    seeded.discoveredSpeciesIDs = Set(creatures.map(\.speciesID))
    try persistence.save(seeded)
    return GameStore(persistence: persistence, catalog: catalog, now: { self.acquiredAt })
  }

  @MainActor
  private func presentation(for store: GameStore) -> CompactViewState {
    CompactViewState(
      state: store.state,
      currentCreature: store.currentCreature,
      currentPosition: store.currentCreaturePosition,
      visibleCreatureCount: store.currentCreatureCount,
      groupMemberPosition: store.groupMemberPosition,
      groupMemberCount: store.groupMemberCount,
      catalogIsEmpty: store.catalog.isEmpty,
      weeklyUsage: [:],
      catalog: store.catalog
    )
  }

  /// 버그가 실제로 터진 상황. 계보가 하나뿐이라 좌우 화살표는 숨겨지는데, 바로 그때
  /// 그룹 페이저가 보여야 한다. 두 조건을 하나로 묶으면 고침이 보이지 않는다.
  @MainActor
  func testSingleLineageWithTwoMembersHidesArrowsButShowsTheGroupPager() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try makeStore(
      creatures: [
        creature("PG-061", origin: "PG-001", offset: 0),
        creature("PG-001", origin: "PG-001", level: 1, offset: 1),
      ],
      directory: directory
    )

    let view = presentation(for: store)

    XCTAssertFalse(view.showsNavigation, "계보가 하나뿐이므로 좌우 화살표는 숨는다")
    XCTAssertTrue(view.showsGroupNavigation, "같은 계보 2마리이므로 그룹 페이저는 보여야 한다")
    XCTAssertEqual(view.groupPositionLabel, "1 / 2")
  }

  @MainActor
  func testGroupPagerLabelFollowsTheSelectedMember() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try makeStore(
      creatures: [
        creature("PG-061", origin: "PG-001", offset: 0),
        creature("PG-001", origin: "PG-001", level: 1, offset: 1),
        creature("PG-001", origin: "PG-001", level: 1, offset: 2),
      ],
      directory: directory
    )

    XCTAssertEqual(presentation(for: store).groupPositionLabel, "1 / 3")

    store.selectNextInGroup()
    XCTAssertEqual(presentation(for: store).groupPositionLabel, "2 / 3")

    store.selectNextInGroup()
    XCTAssertEqual(presentation(for: store).groupPositionLabel, "3 / 3")

    // 순환한다. 마지막에서 한 번 더 누르면 처음으로 돌아온다.
    store.selectNextInGroup()
    XCTAssertEqual(presentation(for: store).groupPositionLabel, "1 / 3")

    store.selectPreviousInGroup()
    XCTAssertEqual(presentation(for: store).groupPositionLabel, "3 / 3")
  }

  /// 그룹이 1마리뿐이면 컨트롤이 나오지 않아야 한다. 누를 곳이 없는 버튼은 잡음이다.
  @MainActor
  func testLoneCreatureHidesTheGroupPager() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try makeStore(
      creatures: [creature("PG-061", origin: "PG-001")],
      directory: directory
    )

    let view = presentation(for: store)

    XCTAssertFalse(view.showsGroupNavigation)
    XCTAssertNil(view.groupPositionLabel)
  }

  /// 계보가 여럿이면 두 축이 동시에 살아 있어야 한다 — 좌우는 계보 사이, 페이저는 계보 안.
  @MainActor
  func testMultipleLineagesKeepBothAxesIndependent() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try makeStore(
      creatures: [
        creature("PG-061", origin: "PG-001", offset: 0),
        creature("PG-001", origin: "PG-001", level: 1, offset: 1),
        creature("PG-002", origin: "PG-002", level: 5, offset: 2),
      ],
      directory: directory
    )

    let view = presentation(for: store)

    XCTAssertTrue(view.showsNavigation, "계보가 둘이므로 좌우 화살표가 산다")
    XCTAssertEqual(view.positionLabel, "1 / 2", "좌우 축은 계보 수를 센다")
    XCTAssertTrue(view.showsGroupNavigation)
    XCTAssertEqual(view.groupPositionLabel, "1 / 2", "그룹 축은 같은 계보 개체 수를 센다")
  }

  /// 그룹 인자를 생략한 기존 호출부는 페이저 없이 그대로 동작해야 한다.
  func testOmittingGroupArgumentsKeepsThePagerHidden() {
    let view = CompactViewState(
      state: GameState(),
      currentCreature: nil,
      currentPosition: nil,
      catalogIsEmpty: true,
      weeklyUsage: [:]
    )

    XCTAssertFalse(view.showsGroupNavigation)
    XCTAssertNil(view.groupPositionLabel)
  }
}
