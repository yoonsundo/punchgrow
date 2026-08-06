import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class CreatureCatalogTests: XCTestCase {
  func testBundledCatalogHasValidatedGraphAndExactlySixtyStarts() throws {
    let catalog = try CreatureCatalog.load()
    XCTAssertEqual(catalog.count, 240)
    XCTAssertEqual(catalog.filter { $0.category == "start" && $0.stage == 1 }.count, 60)
  }

  func testEvolutionFromDecodesNullStringAndArray() throws {
    let json = """
      [
        {"id":"PG-001","koName":"a","enName":"a","lineageId":"PG-L001","rarity":"PROCESS","stage":1,"category":"start","bodyForm":"x","identity":"x","lore":"x","evolutionFrom":null,"imagePath":"x"},
        {"id":"PG-002","koName":"b","enName":"b","lineageId":"PG-L001","rarity":"AGENT","stage":2,"category":"normal_evolution","bodyForm":"x","identity":"x","lore":"x","evolutionFrom":"PG-001","imagePath":"x"},
        {"id":"PG-003","koName":"c","enName":"c","lineageId":"PG-L001","rarity":"DAEMON","stage":3,"category":"mixed","bodyForm":"x","identity":"x","lore":"x","evolutionFrom":["PG-002","PG-L001:S2"],"imagePath":"x"}
      ]
      """
    let decoded = try JSONDecoder().decode([CreatureSpecies].self, from: Data(json.utf8))
    XCTAssertEqual(decoded.map(\.evolutionFrom), [[], ["PG-001"], ["PG-002", "PG-L001:S2"]])
  }

  func testBundledValidationRejectsDuplicateIDsBeforeBuildingDictionary() throws {
    var catalog = try CreatureCatalog.load()
    catalog[1] = catalog[0]
    XCTAssertThrowsError(try CreatureCatalog.validateBundled(catalog)) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog)
    }
  }

  func testBundledValidationRejectsForwardEvolutionReference() throws {
    var catalog = try CreatureCatalog.load()
    let target = try XCTUnwrap(catalog.firstIndex { $0.stage == 2 })
    let original = catalog[target]
    let later = try XCTUnwrap(catalog.first { $0.stage > original.stage })
    catalog[target] = CreatureSpecies(
      id: original.id, koName: original.koName, enName: original.enName,
      lineageId: original.lineageId, rarity: original.rarity, stage: original.stage,
      category: original.category, bodyForm: original.bodyForm, identity: original.identity,
      lore: original.lore, evolutionFrom: [later.id], imagePath: original.imagePath)
    XCTAssertThrowsError(try CreatureCatalog.validateBundled(catalog)) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog)
    }
  }

  func testBundledValidationRejectsEmptyLineageID() throws {
    var catalog = try CreatureCatalog.load()
    let original = catalog[0]
    catalog[0] = CreatureSpecies(
      id: original.id, koName: original.koName, enName: original.enName,
      lineageId: "", rarity: original.rarity, stage: original.stage,
      category: original.category, bodyForm: original.bodyForm, identity: original.identity,
      lore: original.lore, evolutionFrom: original.evolutionFrom, imagePath: original.imagePath)
    XCTAssertThrowsError(try CreatureCatalog.validateBundled(catalog)) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog)
    }
  }
}
