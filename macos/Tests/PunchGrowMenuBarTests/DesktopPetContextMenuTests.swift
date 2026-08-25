import AppKit
import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 펫 위 오른쪽 클릭 메뉴.
///
/// 펫에는 창틀도 버튼도 없다. 이 메뉴가 크기를 바꾸고 펫을 숨기는 유일한 직접 조작 경로라
/// 항목 하나만 끊겨도 사용자는 손댈 방법을 잃는다.
final class DesktopPetContextMenuTests: XCTestCase {

  @MainActor
  private func makeController() -> (DesktopPetController, UserDefaults, String) {
    let suiteName = "punchgrow.desktop-pet-menu-tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    let file = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString)
      .appending(path: "state.json")
    let store = GameStore(persistence: GamePersistence(fileURL: file), catalog: [])
    return (
      DesktopPetController(
        store: store,
        defaults: defaults,
        frameAutosaveName: "PunchGrow.DesktopPetMenuTests"),
      defaults, suiteName
    )
  }

  private func sizeItems(of menu: NSMenu) -> [NSMenuItem] {
    menu.items.filter { $0.representedObject is DesktopPetSize }
  }

  @MainActor
  func testMenuListsEverySizeAndAHideItem() {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let menu = controller.contextMenu()

    // 헤더 + 크기 4개 + 구분선 + 숨기기.
    XCTAssertEqual(menu.items.count, DesktopPetSize.allCases.count + 3)
    XCTAssertEqual(menu.items.first?.title, DesktopPetContextMenu.sizeHeaderTitle)
    XCTAssertFalse(menu.items.first?.isEnabled ?? true, "헤더는 고를 수 없어야 한다")
    XCTAssertEqual(
      sizeItems(of: menu).map(\.title), DesktopPetSize.allCases.map(\.koLabel))
    XCTAssertTrue(menu.items[menu.items.count - 2].isSeparatorItem)
    XCTAssertEqual(menu.items.last?.title, DesktopPetContextMenu.hideTitle)
  }

  /// 숨기면 펫이 화면에서 완전히 사라진다. 다시 켜는 곳을 알려주지 않으면 되돌릴 방법을
  /// 사용자가 찾지 못한다.
  @MainActor
  func testHideItemExplainsWhereToTurnThePetBackOn() {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let hint = controller.contextMenu().items.last?.toolTip

    XCTAssertEqual(hint, DesktopPetContextMenu.hideHint)
    XCTAssertTrue(hint?.contains("Data & Settings") ?? false)
  }

  @MainActor
  func testOnlyTheCurrentSizeIsChecked() {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }
    controller.size = .small

    let checked = sizeItems(of: controller.contextMenu())
      .filter { $0.state == .on }
      .map { $0.representedObject as? DesktopPetSize }

    XCTAssertEqual(checked, [.small], "체크마크가 여러 개면 어떤 크기인지 알 수 없다")
  }

  @MainActor
  func testChoosingASizeItemChangesTheSizeAndPersistsIt() throws {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let large = try XCTUnwrap(
      sizeItems(of: controller.contextMenu())
        .first { $0.representedObject as? DesktopPetSize == .large })

    controller.selectSizeFromMenu(large)

    XCTAssertEqual(controller.size, .large)
    XCTAssertEqual(
      defaults.string(forKey: DesktopPetController.sizeKey), DesktopPetSize.large.rawValue)
  }

  @MainActor
  func testHidingFromTheMenuTurnsTheStoredVisibilityOff() {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }
    XCTAssertTrue(controller.isVisible)

    controller.hideFromMenu(nil)

    XCTAssertFalse(controller.isVisible)
    XCTAssertFalse(defaults.bool(forKey: DesktopPetController.visibilityKey))
  }

  /// 알 수 없는 항목이 들어와도 크기를 엉뚱하게 바꾸지 않는다.
  @MainActor
  func testUnrelatedMenuItemDoesNotChangeTheSize() {
    let (controller, defaults, suiteName) = makeController()
    defer { defaults.removePersistentDomain(forName: suiteName) }
    controller.size = .small

    controller.selectSizeFromMenu(NSMenuItem(title: "무관", action: nil, keyEquivalent: ""))

    XCTAssertEqual(controller.size, .small)
  }
}
