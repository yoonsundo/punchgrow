import AppKit
import Foundation
import XCTest

@testable import PunchGrowMenuBar

/// 잘라내기 결과가 비었는지 판정하는 규칙.
///
/// Vision 이 예외 없이 성공하고도 통째로 투명한 비트맵을 돌려주는 머신이 있다. 그걸 그대로
/// 캐시하면 펫 자리가 빈칸으로 남고, 캐시 때문에 앱을 다시 켜도 낫지 않는다.
final class DesktopPetCutoutTests: XCTestCase {

  private func filledImage(
    _ color: NSColor, size: NSSize = NSSize(width: 40, height: 40)
  ) -> NSImage {
    NSImage(size: size, flipped: false) { rect in
      color.setFill()
      rect.fill()
      return true
    }
  }

  @MainActor
  func testFullyTransparentImageIsBlank() {
    XCTAssertTrue(
      DesktopPetCutoutCache.isEffectivelyBlank(NSImage(size: NSSize(width: 40, height: 40))))
    XCTAssertTrue(DesktopPetCutoutCache.isEffectivelyBlank(filledImage(.clear)))
  }

  @MainActor
  func testOpaqueImageIsNotBlank() {
    XCTAssertFalse(DesktopPetCutoutCache.isEffectivelyBlank(filledImage(.white)))
    XCTAssertFalse(DesktopPetCutoutCache.isEffectivelyBlank(filledImage(.black)))
  }

  /// 가장자리만 남고 가운데가 비어도 "비었다"고 보면 안 된다. 반대로 극히 일부만 남은
  /// 그림은 마스크 실패로 봐야 한다. 경계가 어디인지 고정한다.
  @MainActor
  func testMostlyTransparentImageWithATinySpeckIsStillBlank() {
    let speck = NSImage(size: NSSize(width: 200, height: 200), flipped: false) { _ in
      NSColor.white.setFill()
      NSRect(x: 0, y: 0, width: 4, height: 4).fill()
      return true
    }

    XCTAssertTrue(DesktopPetCutoutCache.isEffectivelyBlank(speck))
  }

  @MainActor
  func testHalfCoveredImageIsNotBlank() {
    let half = NSImage(size: NSSize(width: 200, height: 200), flipped: false) { _ in
      NSColor.white.setFill()
      NSRect(x: 0, y: 0, width: 200, height: 100).fill()
      return true
    }

    XCTAssertFalse(DesktopPetCutoutCache.isEffectivelyBlank(half))
  }

  /// 번들에 든 실제 크리처 그림은 어느 경로로 만들어지든 비어 있으면 안 된다. 어떤 경로가
  /// 이겼는지도 함께 남겨, 화면 없는 머신에서 원인을 좁힐 수 있게 한다.
  @MainActor
  func testBundledCreatureCutoutIsNeverBlank() throws {
    let catalog = try CreatureCatalog.load()
    for speciesID in ["PG-001", "PG-041", "PG-215"] {
      let species = try XCTUnwrap(catalog.first { $0.id == speciesID })
      let url = try XCTUnwrap(CreatureAssetLocator.imageURL(for: species))

      let image = try XCTUnwrap(
        DesktopPetCutoutCache.shared.image(for: url, points: DesktopPetSize.artworkPoints),
        speciesID)
      let source = DesktopPetCutoutCache.shared.lastMaskSource

      XCTAssertFalse(
        DesktopPetCutoutCache.isEffectivelyBlank(image),
        "\(speciesID) source=\(source?.rawValue ?? "none")")
      XCTAssertNotNil(source, speciesID)
    }
  }
}
