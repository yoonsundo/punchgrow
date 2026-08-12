import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class CreatureCatalogTests: XCTestCase {
  func testBundledCatalogHasValidatedGraphAndExactlySixtyFourStarts() throws {
    let catalog = try CreatureCatalog.load()
    XCTAssertEqual(catalog.count, 256)
    XCTAssertEqual(catalog.filter { $0.category == "start" && $0.stage == 1 }.count, 64)
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

  func testEvolutionGraphAcceptsDeterministicCoherentPaths() throws {
    let birdRoot = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let birdTwo = species(
      "PG-002", lineage: "PG-L001", stage: 2, category: "normal_evolution",
      body: "bird", parents: [birdRoot.id])
    let birdThree = species(
      "PG-003", lineage: "PG-L001", stage: 3, category: "normal_evolution",
      body: "bird", parents: ["PG-L001:S2"])
    let mammalRoot = species("PG-004", lineage: "PG-L002", stage: 1, category: "start", body: "mammal")
    let mixed = species(
      "PG-005", lineage: "PG-LM001", stage: 2, category: "mixed",
      body: "chimera", parents: [birdRoot.id, mammalRoot.id])

    XCTAssertNoThrow(try CreatureCatalog.validateEvolutionGraph([
      birdRoot, birdTwo, birdThree, mammalRoot, mixed,
    ]))
  }

  func testEvolutionGraphRejectsReferenceResolvingToMoreThanOneSpecies() {
    let firstRoot = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let duplicateRoot = species("PG-002", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let child = species(
      "PG-003", lineage: "PG-L001", stage: 2, category: "normal_evolution",
      body: "bird", parents: ["PG-L001:S1"])

    assertInvalidGraph([firstRoot, duplicateRoot, child])
  }

  func testEvolutionGraphRejectsSkippedStage() {
    let root = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let child = species(
      "PG-002", lineage: "PG-L001", stage: 3, category: "normal_evolution",
      body: "bird", parents: [root.id])

    assertInvalidGraph([root, child])
  }

  func testEvolutionGraphEnforcesParentCountByCategory() {
    let firstRoot = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let secondRoot = species("PG-002", lineage: "PG-L002", stage: 1, category: "start", body: "mammal")
    let mixedWithOneParent = species(
      "PG-003", lineage: "PG-LM001", stage: 2, category: "mixed",
      body: "chimera", parents: [firstRoot.id])
    let normalWithTwoParents = species(
      "PG-004", lineage: "PG-L001", stage: 2, category: "normal_evolution",
      body: "bird", parents: [firstRoot.id, secondRoot.id])

    assertInvalidGraph([firstRoot, secondRoot, mixedWithOneParent])
    assertInvalidGraph([firstRoot, secondRoot, normalWithTwoParents])
    for category in ["branch", "special", "mutant"] {
      let child = species(
        "PG-005", lineage: "PG-LX001", stage: 2, category: category,
        body: "other", parents: [firstRoot.id, secondRoot.id])
      assertInvalidGraph([firstRoot, secondRoot, child])
    }
  }

  func testEvolutionGraphRejectsCycleAndPathWithoutStart() {
    let first = species(
      "PG-001", lineage: "PG-L001", stage: 2, category: "normal_evolution",
      body: "bird", parents: ["PG-002"])
    let second = species(
      "PG-002", lineage: "PG-L001", stage: 3, category: "normal_evolution",
      body: "bird", parents: [first.id])

    assertInvalidGraph([first, second])
  }

  func testNormalEvolutionRequiresSameLineageAndBodyForm() {
    let root = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")
    let changedLineage = species(
      "PG-002", lineage: "PG-L002", stage: 2, category: "normal_evolution",
      body: "bird", parents: [root.id])
    let changedBody = species(
      "PG-003", lineage: "PG-L001", stage: 2, category: "normal_evolution",
      body: "mammal", parents: [root.id])

    assertInvalidGraph([root, changedLineage])
    assertInvalidGraph([root, changedBody])
  }

  func testSingleParentExceptionalEvolutionPreservesBodyForm() {
    let root = species("PG-001", lineage: "PG-L001", stage: 1, category: "start", body: "bird")

    for category in ["branch", "special", "mutant"] {
      let changedBody = species(
        "PG-002", lineage: "PG-LX001", stage: 2, category: category,
        body: "mammal", parents: [root.id])
      assertInvalidGraph([root, changedBody])
    }
  }

  func testBundledNormalEvolutionPreservesLineageAndBodyForm() throws {
    let catalog = try decodeBundledCatalogWithoutValidation()
    let speciesByID = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })
    let failures = catalog.compactMap { child -> String? in
      guard child.category == "normal_evolution", child.evolutionFrom.count == 1,
            let reference = child.evolutionFrom.first
      else { return nil }
      let parents: [CreatureSpecies]
      if let direct = speciesByID[reference] {
        parents = [direct]
      } else if let separator = reference.lastIndex(of: ":"),
                reference[reference.index(after: separator)...].first == "S",
                let stage = Int(reference[reference.index(separator, offsetBy: 2)...]) {
        let lineage = String(reference[..<separator])
        parents = catalog.filter { $0.lineageId == lineage && $0.stage == stage }
      } else {
        parents = []
      }
      guard parents.count == 1, let parent = parents.first,
            parent.lineageId == child.lineageId, parent.bodyForm == child.bodyForm
      else { return "\(reference) -> \(child.id)" }
      return nil
    }

    XCTAssertEqual(failures, [], "Incoherent normal evolution edges: \(failures.joined(separator: ", "))")
  }

  func testBundledSingleParentEvolutionPreservesBodyForm() throws {
    let catalog = try decodeBundledCatalogWithoutValidation()
    let speciesByID = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })
    let failures = catalog.compactMap { child -> String? in
      guard child.category != "start", child.category != "mixed",
            child.evolutionFrom.count == 1, let reference = child.evolutionFrom.first
      else { return nil }
      let parents: [CreatureSpecies]
      if let direct = speciesByID[reference] {
        parents = [direct]
      } else if let separator = reference.lastIndex(of: ":"),
                reference[reference.index(after: separator)...].first == "S",
                let stage = Int(reference[reference.index(separator, offsetBy: 2)...]) {
        let lineage = String(reference[..<separator])
        parents = catalog.filter { $0.lineageId == lineage && $0.stage == stage }
      } else {
        parents = []
      }
      guard parents.count == 1, parents[0].bodyForm == child.bodyForm
      else { return "\(reference) -> \(child.id)" }
      return nil
    }

    XCTAssertEqual(failures, [], "Incoherent single-parent evolution edges: \(failures.joined(separator: ", "))")
  }
}

private extension CreatureCatalogTests {
  func species(
    _ id: String,
    lineage: String,
    stage: Int,
    category: String,
    body: String,
    parents: [String] = []
  ) -> CreatureSpecies {
    CreatureSpecies(
      id: id, koName: id, enName: id, lineageId: lineage, rarity: "PROCESS",
      stage: stage, category: category, bodyForm: body, identity: id, lore: id,
      evolutionFrom: parents, imagePath: "")
  }

  func assertInvalidGraph(
    _ catalog: [CreatureSpecies],
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertThrowsError(try CreatureCatalog.validateEvolutionGraph(catalog), file: file, line: line) { error in
      XCTAssertEqual(error as? GameError, .emptyCatalog, file: file, line: line)
    }
  }

  func decodeBundledCatalogWithoutValidation() throws -> [CreatureSpecies] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "creatures", withExtension: "json"))
    return try JSONDecoder().decode([CreatureSpecies].self, from: Data(contentsOf: url))
  }
}
