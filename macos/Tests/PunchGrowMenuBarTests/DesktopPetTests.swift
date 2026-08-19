import AppKit
import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class DesktopPetTests: XCTestCase {
  @MainActor
  func testVisibilityDefaultsVisibleWithoutWritingPreference() {
    let suiteName = "punchgrow.desktop-pet-tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let controller = DesktopPetController(store: emptyStore(), defaults: defaults)

    XCTAssertTrue(controller.isVisible)
    XCTAssertNil(defaults.object(forKey: DesktopPetController.visibilityKey))
  }

  @MainActor
  func testVisibilityPersistsAcrossControllerInstances() {
    let suiteName = "punchgrow.desktop-pet-tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let first = DesktopPetController(store: emptyStore(), defaults: defaults)
    first.isVisible = false
    XCTAssertFalse(DesktopPetController(store: emptyStore(), defaults: defaults).isVisible)

    first.isVisible = true
    XCTAssertTrue(DesktopPetController(store: emptyStore(), defaults: defaults).isVisible)
  }

  func testRepresentativePinnedFormWinsOverCurrentCreature() {
    let root = species(id: "PG-T01", stage: 1, category: "start")
    let evolved = species(
      id: "PG-T02", stage: 2, category: "normal_evolution", evolutionFrom: [root.id])
    let other = species(id: "PG-T03", stage: 1, category: "start", lineageID: "PG-L002")
    let representative = creature(
      speciesID: evolved.id, originSpeciesID: root.id, displaySpeciesID: root.id)
    let current = creature(speciesID: other.id, originSpeciesID: other.id)

    let resolved = DesktopPetSpeciesResolver.resolve(
      representative: representative,
      current: current,
      catalog: [root, evolved, other]
    )

    XCTAssertEqual(resolved?.id, root.id)
    XCTAssertEqual(representative.speciesID, evolved.id)
  }

  func testCurrentCreatureIsUsedOnlyWhenRepresentativeIsMissing() {
    let currentSpecies = species(id: "PG-C01", stage: 1, category: "start")
    let current = creature(speciesID: currentSpecies.id, originSpeciesID: currentSpecies.id)

    XCTAssertEqual(
      DesktopPetSpeciesResolver.resolve(
        representative: nil, current: current, catalog: [currentSpecies])?.id,
      currentSpecies.id
    )
    XCTAssertNil(
      DesktopPetSpeciesResolver.resolve(representative: nil, current: nil, catalog: [currentSpecies])
    )
  }

  func testInvalidPinnedFormFallsBackToActualRepresentativeSpecies() {
    let actual = species(id: "PG-A01", stage: 1, category: "start")
    let representative = creature(
      speciesID: actual.id, originSpeciesID: actual.id, displaySpeciesID: "PG-STALE")

    XCTAssertEqual(
      DesktopPetSpeciesResolver.resolve(
        representative: representative, current: nil, catalog: [actual])?.id,
      actual.id
    )
  }

  @MainActor
  func testRestoredOriginClampsInsideVisibleFrame() {
    let visibleFrame = NSRect(x: 100, y: 50, width: 900, height: 700)
    let windowFrame = NSRect(x: 2_000, y: -400, width: 200, height: 220)

    let origin = DesktopPetController.clampedOrigin(
      for: windowFrame, within: visibleFrame, margin: 12)

    XCTAssertEqual(origin.x, 788)
    XCTAssertEqual(origin.y, 62)
  }

  @MainActor
  func testRestoredOriginClampsLeftAndTopEdges() {
    let visibleFrame = NSRect(x: 100, y: 50, width: 900, height: 700)
    let windowFrame = NSRect(x: -2_000, y: 2_000, width: 200, height: 220)

    let origin = DesktopPetController.clampedOrigin(
      for: windowFrame, within: visibleFrame, margin: 12)

    XCTAssertEqual(origin.x, 112)
    XCTAssertEqual(origin.y, 518)
  }

  func testIdleMotionRequiresBothReductionSettingsOff() {
    XCTAssertTrue(
      DesktopPetMotionPolicy.allowsIdleMotion(
        appReduceEffects: false, systemReduceMotion: false))
    XCTAssertFalse(
      DesktopPetMotionPolicy.allowsIdleMotion(
        appReduceEffects: true, systemReduceMotion: false))
    XCTAssertFalse(
      DesktopPetMotionPolicy.allowsIdleMotion(
        appReduceEffects: false, systemReduceMotion: true))
    XCTAssertFalse(
      DesktopPetMotionPolicy.allowsIdleMotion(
        appReduceEffects: true, systemReduceMotion: true))
  }

  @MainActor
  func testCutoutMakesBundledCardBackgroundTransparent() throws {
    for speciesID in ["PG-001", "PG-041", "PG-215"] {
      let source = species(id: speciesID, stage: 1, category: "start")
      let url = try XCTUnwrap(CreatureAssetLocator.imageURL(for: source))
      let image = try XCTUnwrap(
        DesktopPetCutoutCache.shared.image(for: url, points: 164),
        DesktopPetCutoutCache.shared.lastErrorDescription ?? "전경 마스크 결과 없음"
      )
      var proposedRect = NSRect(origin: .zero, size: image.size)
      let cgImage = try XCTUnwrap(
        image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil))
      let bitmap = NSBitmapImageRep(cgImage: cgImage)
      let corners = [
        NSPoint(x: 0, y: 0),
        NSPoint(x: CGFloat(bitmap.pixelsWide - 1), y: 0),
        NSPoint(x: 0, y: CGFloat(bitmap.pixelsHigh - 1)),
        NSPoint(
          x: CGFloat(bitmap.pixelsWide - 1),
          y: CGFloat(bitmap.pixelsHigh - 1)
        ),
      ]
      let transparentCorners = corners.filter {
        (bitmap.colorAt(x: Int($0.x), y: Int($0.y))?.alphaComponent ?? 1) < 0.1
      }

      XCTAssertGreaterThanOrEqual(transparentCorners.count, 3, speciesID)
      XCTAssertGreaterThan(
        bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?.alphaComponent ?? 0,
        0.5,
        speciesID
      )
      if let outputDirectory = ProcessInfo.processInfo.environment["PUNCHGROW_CUTOUT_OUTPUT"],
         let png = bitmap.representation(using: .png, properties: [:])
      {
        try png.write(to: URL(fileURLWithPath: outputDirectory).appending(path: "\(speciesID).png"))
      }
    }
  }

  @MainActor
  private func emptyStore() -> GameStore {
    let file = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString)
      .appending(path: "state.json")
    return GameStore(persistence: GamePersistence(fileURL: file), catalog: [])
  }

  private func species(
    id: String,
    stage: Int,
    category: String,
    lineageID: String = "PG-L001",
    evolutionFrom: [String] = []
  ) -> CreatureSpecies {
    CreatureSpecies(
      id: id,
      koName: id,
      enName: id,
      lineageId: lineageID,
      rarity: "PROCESS",
      stage: stage,
      category: category,
      bodyForm: "test",
      identity: "test",
      lore: "test",
      evolutionFrom: evolutionFrom,
      imagePath: "test"
    )
  }

  private func creature(
    speciesID: String,
    originSpeciesID: String,
    displaySpeciesID: String? = nil
  ) -> OwnedCreature {
    OwnedCreature(
      id: UUID(),
      speciesID: speciesID,
      originSpeciesID: originSpeciesID,
      level: 20,
      experience: 0,
      affection: 0,
      nickname: nil,
      displaySpeciesID: displaySpeciesID,
      uniqueColor: false,
      acquiredAt: .now
    )
  }
}
