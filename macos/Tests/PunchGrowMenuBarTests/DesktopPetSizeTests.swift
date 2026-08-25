import AppKit
import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 데스크톱 펫 크기 프리셋.
///
/// 펫은 테두리도 스크롤도 없는 바탕화면 창이라, 크기가 잘못 계산돼 화면 밖으로 나가면
/// 사용자가 되돌릴 방법이 없다. 크기 규칙과 화면 안 보정을 여기서 못 박는다.
final class DesktopPetSizeTests: XCTestCase {

  private func makeDefaults() -> (UserDefaults, String) {
    let suiteName = "punchgrow.desktop-pet-size-tests.\(UUID().uuidString)"
    return (UserDefaults(suiteName: suiteName)!, suiteName)
  }

  @MainActor
  private func emptyStore() -> GameStore {
    let file = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString)
      .appending(path: "state.json")
    return GameStore(persistence: GamePersistence(fileURL: file), catalog: [])
  }

  func testPresetsAreOrderedSmallestFirstAndKeepTheOriginalAspectRatio() {
    let sizes = DesktopPetSize.allCases
    XCTAssertEqual(sizes, [.tiny, .small, .regular, .large])

    for (smaller, larger) in zip(sizes, sizes.dropFirst()) {
      XCTAssertLessThan(
        smaller.scale, larger.scale, "\(smaller.koLabel)가 \(larger.koLabel)보다 크면 라벨이 거짓말이 된다")
      XCTAssertLessThan(smaller.panelSize.width, larger.panelSize.width)
      XCTAssertLessThan(smaller.panelSize.height, larger.panelSize.height)
    }

    let baseRatio = DesktopPetSize.basePanelSize.width / DesktopPetSize.basePanelSize.height
    for size in sizes {
      XCTAssertEqual(
        size.panelSize.width / size.panelSize.height, baseRatio, accuracy: 0.0001,
        "\(size.koLabel)에서 비율이 달라지면 크리처가 찌그러진다")
    }
  }

  /// 크기 조절이 들어오기 전 설치본이 업데이트만으로 커지거나 작아지면 안 된다.
  func testRegularKeepsThePreviousFixedPanelSize() {
    XCTAssertEqual(DesktopPetSize.regular.scale, 1)
    XCTAssertEqual(DesktopPetSize.regular.panelSize, DesktopPetSize.basePanelSize)
    XCTAssertEqual(DesktopPetSize.basePanelSize, NSSize(width: 200, height: 220))
  }

  @MainActor
  func testSizeDefaultsToRegularWithoutWritingPreference() {
    let (defaults, suiteName) = makeDefaults()
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let controller = DesktopPetController(store: emptyStore(), defaults: defaults)

    XCTAssertEqual(controller.size, .regular)
    XCTAssertNil(defaults.object(forKey: DesktopPetController.sizeKey))
  }

  @MainActor
  func testSizePersistsAcrossControllerInstances() {
    let (defaults, suiteName) = makeDefaults()
    defer { defaults.removePersistentDomain(forName: suiteName) }

    DesktopPetController(store: emptyStore(), defaults: defaults).size = .tiny

    XCTAssertEqual(
      DesktopPetController(store: emptyStore(), defaults: defaults).size, .tiny)
  }

  /// 알 수 없는 값이 저장돼 있어도 펫을 잃지 않고 보통으로 돌아온다.
  @MainActor
  func testUnknownStoredSizeFallsBackToRegular() {
    let (defaults, suiteName) = makeDefaults()
    defer { defaults.removePersistentDomain(forName: suiteName) }
    defaults.set("mega", forKey: DesktopPetController.sizeKey)

    XCTAssertEqual(
      DesktopPetController(store: emptyStore(), defaults: defaults).size, .regular)
  }

  /// 발밑 가운데를 기준으로 줄어야 펫이 제자리에 서 있는 것처럼 보인다.
  @MainActor
  func testShrinkingKeepsTheStandingSpot() {
    let visible = NSRect(x: 0, y: 0, width: 1_440, height: 900)
    let standing = NSRect(
      origin: NSPoint(x: 600, y: 300), size: DesktopPetSize.regular.panelSize)

    let shrunk = DesktopPetController.resizedFrame(from: standing, to: .tiny, within: visible)

    XCTAssertEqual(shrunk.size, DesktopPetSize.tiny.panelSize)
    XCTAssertEqual(shrunk.minY, standing.minY)
    XCTAssertEqual(shrunk.midX, standing.midX, accuracy: 0.0001)
    XCTAssertTrue(visible.contains(shrunk))
  }

  /// 화면 구석에 붙여 둔 펫을 키워도 잘리지 않아야 한다.
  @MainActor
  func testGrowingFromAScreenCornerStaysFullyVisible() {
    let visible = NSRect(x: 0, y: 0, width: 1_440, height: 900)
    let cornered = NSRect(
      origin: NSPoint(
        x: visible.maxX - DesktopPetSize.tiny.panelSize.width - 12,
        y: visible.maxY - DesktopPetSize.tiny.panelSize.height - 12),
      size: DesktopPetSize.tiny.panelSize)

    let grown = DesktopPetController.resizedFrame(from: cornered, to: .large, within: visible)

    XCTAssertEqual(grown.size, DesktopPetSize.large.panelSize)
    XCTAssertTrue(visible.contains(grown), "커진 펫이 화면 밖으로 나가면 되돌릴 방법이 없다")
  }

  /// 화면이 펫보다 작아도 원점이 가시영역 안에 머물러야 한다.
  @MainActor
  func testTinyScreenStillPlacesTheOriginInsideTheVisibleArea() {
    let visible = NSRect(x: 0, y: 0, width: 160, height: 160)
    let frame = NSRect(origin: NSPoint(x: 40, y: 40), size: DesktopPetSize.tiny.panelSize)

    let grown = DesktopPetController.resizedFrame(from: frame, to: .large, within: visible)

    XCTAssertEqual(grown.origin, NSPoint(x: 12, y: 12))
  }
}
