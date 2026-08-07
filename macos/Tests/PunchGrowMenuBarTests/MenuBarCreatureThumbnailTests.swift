import AppKit
import XCTest

@testable import PunchGrowMenuBar

@MainActor
final class MenuBarCreatureThumbnailTests: XCTestCase {
  func testContentAnalysisCentersCropOnOffCenterContent() throws {
    let content = NSRect(x: 40, y: 220, width: 80, height: 100)
    let image = makeCardImage(side: 360, contentRect: content, contentColor: .systemOrange)

    let analysis = try XCTUnwrap(CreatureImageCache.contentAnalysis(of: image))

    XCTAssertEqual(analysis.cropRect.width, analysis.cropRect.height, accuracy: 0.5)
    XCTAssertEqual(analysis.cropRect.midX, content.midX, accuracy: 14)
    XCTAssertEqual(analysis.cropRect.midY, content.midY, accuracy: 14)
    XCTAssertEqual(analysis.cropRect.width, 102, accuracy: 16)
  }

  func testThumbnailZoomsIntoContent() throws {
    let content = NSRect(x: 130, y: 190, width: 100, height: 100)
    let url = try writeTemporaryPNG(
      makeCardImage(side: 360, contentRect: content, contentColor: .systemOrange)
    )
    defer { try? FileManager.default.removeItem(at: url) }

    let thumbnail = try XCTUnwrap(CreatureImageCache().thumbnail(for: url, points: 20))

    XCTAssertEqual(thumbnail.size, NSSize(width: 20, height: 20))
    XCTAssertGreaterThanOrEqual(CreatureThumbnailDiagnostics.contentCoverage(of: thumbnail), 0.7)
  }

  func testThumbnailFallsBackWhenNoContentDetected() throws {
    let url = try writeTemporaryPNG(makeCardImage(side: 360, contentRect: nil))
    defer { try? FileManager.default.removeItem(at: url) }

    let thumbnail = try XCTUnwrap(CreatureImageCache().thumbnail(for: url, points: 20))

    XCTAssertEqual(thumbnail.size, NSSize(width: 20, height: 20))
    XCTAssertLessThan(CreatureThumbnailDiagnostics.contentCoverage(of: thumbnail), 0.05)
  }

  func testBundledSpriteThumbnailsAreCreatureDominant() throws {
    let catalog = try CreatureCatalog.load()
    var coverageByID: [String: (cropped: Double, baseline: Double)] = [:]

    for id in ["PG-001", "PG-044", "PG-130"] {
      let species = try XCTUnwrap(catalog.first { $0.id == id }, id)
      let url = try XCTUnwrap(CreatureAssetLocator.imageURL(for: species), id)
      let source = try XCTUnwrap(NSImage(contentsOf: url), id)
      let cropped = try XCTUnwrap(CreatureImageCache().thumbnail(for: url, points: 20), id)

      let croppedCoverage = CreatureThumbnailDiagnostics.contentCoverage(of: cropped)
      let baselineCoverage = CreatureThumbnailDiagnostics.contentCoverage(
        of: CreatureThumbnailDiagnostics.uncroppedThumbnail(of: source, points: 20)
      )
      coverageByID[id] = (croppedCoverage, baselineCoverage)

      XCTAssertGreaterThanOrEqual(croppedCoverage, baselineCoverage - 0.01, id)
    }

    let compact = try XCTUnwrap(coverageByID["PG-001"])
    XCTAssertGreaterThanOrEqual(compact.cropped, compact.baseline * 1.15, "PG-001")
  }

  func testBrightnessLiftTargetsDarkContentOnly() throws {
    let darkImage = makeCardImage(
      side: 360,
      contentRect: NSRect(x: 100, y: 100, width: 160, height: 160),
      contentColor: NSColor(srgbRed: 60 / 255, green: 50 / 255, blue: 90 / 255, alpha: 1)
    )
    let brightImage = makeCardImage(
      side: 360,
      contentRect: NSRect(x: 100, y: 100, width: 160, height: 160),
      contentColor: .systemOrange
    )

    let darkAnalysis = try XCTUnwrap(CreatureImageCache.contentAnalysis(of: darkImage))
    let brightAnalysis = try XCTUnwrap(CreatureImageCache.contentAnalysis(of: brightImage))
    let darkLift = CreatureImageCache.brightnessLift(for: darkAnalysis.meanContentLuminance)
    let brightLift = CreatureImageCache.brightnessLift(for: brightAnalysis.meanContentLuminance)

    XCTAssertGreaterThan(darkLift, 0.3)
    XCTAssertLessThanOrEqual(darkLift, 0.8)
    XCTAssertEqual(brightLift, 0)
    XCTAssertEqual(CreatureImageCache.brightnessLift(for: nil), 0)
    XCTAssertEqual(CreatureImageCache.brightnessLift(for: 0), 0.8)
  }

  func testHUDCanvasFitsProgressTexts() {
    let image = MenuBarHUDRenderer.render(
      creature: nil, claudeProgressPercent: 100, codexProgressPercent: 100
    )
    XCTAssertEqual(image.size, NSSize(width: 118, height: 22))

    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold)
    ]
    let claudeWidth = ("C 100%" as NSString).size(withAttributes: attributes).width
    let codexWidth = ("X 100%" as NSString).size(withAttributes: attributes).width
    XCTAssertLessThanOrEqual(25 + claudeWidth, 74, "Claude 텍스트가 Codex 시작 x를 침범")
    XCTAssertLessThanOrEqual(74 + codexWidth, 118, "Codex 텍스트가 캔버스 폭을 벗어남")
  }

  private func makeCardImage(
    side: CGFloat, contentRect: NSRect?, contentColor: NSColor = .systemOrange
  ) -> NSImage {
    NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
      NSColor(
        srgbRed: CGFloat(CreatureThumbnailDiagnostics.cardBackground.red) / 255,
        green: CGFloat(CreatureThumbnailDiagnostics.cardBackground.green) / 255,
        blue: CGFloat(CreatureThumbnailDiagnostics.cardBackground.blue) / 255,
        alpha: 1
      ).setFill()
      NSRect(x: 0, y: 0, width: side, height: side).fill()
      if let contentRect {
        contentColor.setFill()
        contentRect.fill()
      }
      return true
    }
  }

  private func writeTemporaryPNG(_ image: NSImage) throws -> URL {
    let rep = try XCTUnwrap(
      NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(image.size.width.rounded()),
        pixelsHigh: Int(image.size.height.rounded()),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
      )
    )
    rep.size = image.size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(origin: .zero, size: image.size))
    NSGraphicsContext.restoreGraphicsState()
    let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("punchgrow-thumbnail-test-\(UUID().uuidString).png")
    try png.write(to: url)
    return url
  }
}
