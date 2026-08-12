import Foundation
import XCTest

@testable import PunchGrowMenuBar

final class UXPresentationTests: XCTestCase {

  func testMenuBarStatusCompactsUsageAndKeepsProviderShareTruthful() {
    let presentation = MenuBarStatusPresentation(
      weeklyUsage: [.claude: 86_030_000, .codex: 40_470_000],
      quotaSnapshots: [
        .claude: ProviderQuotaSnapshot(usedPercent: 100, resetsAt: nil, observedAt: .now),
        .codex: ProviderQuotaSnapshot(usedPercent: 45, resetsAt: nil, observedAt: .now),
      ]
    )

    XCTAssertTrue(presentation.weeklyTotal == 126_500_000)
    XCTAssertTrue(presentation.compactWeeklyTotal == "126.5M")
    XCTAssertTrue(presentation.claudePercent == 68)
    XCTAssertTrue(presentation.codexPercent == 32)
    XCTAssertTrue(presentation.claudePercent + presentation.codexPercent == 100)
    XCTAssertTrue(presentation.claudeProgressPercent == 100)
    XCTAssertTrue(presentation.codexProgressPercent == 45)
  }

  func testMenuBarStatusHandlesEmptyAndNegativeObservedUsage() {
    let empty = MenuBarStatusPresentation(weeklyUsage: [:])
    let invalid = MenuBarStatusPresentation(weeklyUsage: [.claude: -10, .codex: 1_250])

    XCTAssertTrue(empty.compactWeeklyTotal == "0")
    XCTAssertTrue(empty.claudePercent == 0)
    XCTAssertTrue(empty.codexPercent == 0)
    XCTAssertNil(empty.claudeProgressPercent)
    XCTAssertNil(empty.codexProgressPercent)
    XCTAssertTrue(invalid.compactWeeklyTotal == "1.2K")
    XCTAssertTrue(invalid.claudePercent == 0)
    XCTAssertTrue(invalid.codexPercent == 100)
  }

  func testRarityFeedbackUsesStaticPulseBurstAndOriginTiers() {
    XCTAssertTrue(RarityFeedbackTier(rarity: "PROCESS") == .staticAccent)
    XCTAssertTrue(RarityFeedbackTier(rarity: "AGENT") == .pulse)
    XCTAssertTrue(RarityFeedbackTier(rarity: "DAEMON") == .pulse)
    XCTAssertTrue(RarityFeedbackTier(rarity: "ORACLE") == .burst)
    XCTAssertTrue(RarityFeedbackTier(rarity: "ARCHITECT") == .burst)
    XCTAssertTrue(RarityFeedbackTier(rarity: "ORIGIN") == .origin)
  }

  func testRarityVisualTiersProgressFromStaticToPremiumEffects() {
    let tiers = ["PROCESS", "AGENT", "DAEMON", "ORACLE", "ARCHITECT", "ORIGIN"]
      .map(RarityVisualTier.init(rarity:))

    XCTAssertEqual(tiers, RarityVisualTier.allCases)
    XCTAssertEqual(tiers.map(\.particleCount), [0, 0, 4, 6, 8, 12])
    XCTAssertFalse(RarityVisualTier.agent.animates)
    XCTAssertTrue(RarityVisualTier.daemon.animates)
    XCTAssertTrue(RarityVisualTier.origin.animates)
  }

  func testEvolutionMilestonesMatchApprovedLevelProgression() {
    XCTAssertEqual(EvolutionMilestone.all.map(\.stage), [2, 3, 4])
    XCTAssertEqual(EvolutionMilestone.all.map(\.level), [15, 25, 40])
  }

  func testAutomaticPathStaysADefaultCandidateWalkAndNoLongerDrivesPotential() {
    let root = potentialSpecies(
      id: "PG-001", name: "시작형", rarity: "PROCESS", stage: 1, category: "start")
    let normal = potentialSpecies(
      id: "PG-061", name: "기본 진화", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let branch = potentialSpecies(
      id: "PG-060", name: "분기 진화", rarity: "ORACLE", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let final = potentialSpecies(
      id: "PG-181", name: "최종 진화", rarity: "AGENT", stage: 3,
      category: "normal_evolution", evolutionFrom: [normal.id])
    let catalog = [branch, final, normal, root]

    // 엔진 내부 의미는 그대로다 — 매 단계 기본 후보만 따라간다.
    XCTAssertEqual(
      EvolutionCatalog.automaticPath(from: root, in: catalog).map(\.id),
      [root.id, normal.id, final.id])

    // 표시 계층은 이 경로를 더 이상 쓰지 않는다. 상한은 기본 후보가 아닌 분기 쪽에 있다.
    XCTAssertEqual(
      EvolutionCatalog.maxReachablePath(from: root, in: catalog).map(\.id),
      [root.id, branch.id])
    XCTAssertEqual(EvolutionCatalog.maxReachableRarity(from: root, in: catalog), "ORACLE")
    XCTAssertEqual(EvolutionCatalog.minGuaranteedRarity(from: root, in: catalog), "AGENT")
    XCTAssertEqual(
      EvolutionPotentialPresentation.make(from: root, catalog: catalog).finalSpecies.id,
      branch.id)
  }

  func testEvolutionPotentialReportsTheMaxReachableCeilingWithItsGuaranteedFloor() {
    let root = potentialSpecies(
      id: "PG-001", name: "프라곤", rarity: "PROCESS", stage: 1, category: "start")
    let middle = potentialSpecies(
      id: "PG-061", name: "프라곤온", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let sideBranch = potentialSpecies(
      id: "PG-060", name: "프라겔", rarity: "DAEMON", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let final = potentialSpecies(
      id: "PG-181", name: "피티온", rarity: "ORIGIN", stage: 3,
      category: "normal_evolution", evolutionFrom: [middle.id])

    let potential = EvolutionPotentialPresentation.make(
      from: root, catalog: [final, root, sideBranch, middle])

    XCTAssertEqual(potential.currentSpecies.id, root.id)
    XCTAssertEqual(potential.currentRarityLabel, "현재 PROCESS")
    XCTAssertEqual(potential.finalSpecies.id, final.id)
    XCTAssertEqual(potential.finalRarityLabel, "최대 도달 등급 ORIGIN")
    XCTAssertEqual(potential.finalSpeciesName, "피티온")
    XCTAssertEqual(potential.path.map(\.id), [root.id, middle.id, final.id])
    XCTAssertTrue(potential.pathLabel.contains("프라곤 → 프라곤온 → 피티온"))
    XCTAssertTrue(potential.reachesOrigin)

    // 상한만 보여 주면 낙관 편향이 생긴다. 종착 분기를 고르면 DAEMON에서 멈춘다.
    XCTAssertEqual(potential.guaranteedRarity, "DAEMON")
    XCTAssertEqual(potential.guaranteedRarityLabel, "최소 보장 등급 DAEMON")
  }

  func testOwnedCreaturePotentialStartsAtTheCurrentStage() throws {
    let root = potentialSpecies(
      id: "PG-001", name: "프라곤", rarity: "PROCESS", stage: 1, category: "start")
    let middle = potentialSpecies(
      id: "PG-061", name: "프라곤온", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let final = potentialSpecies(
      id: "PG-181", name: "피티온", rarity: "ORIGIN", stage: 3,
      category: "normal_evolution", evolutionFrom: [middle.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: middle.id, originSpeciesID: root.id, level: 15,
      experience: 0, affection: 20, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let potential = try XCTUnwrap(
      EvolutionPotentialPresentation.make(for: creature, catalog: [final, root, middle]))

    XCTAssertEqual(potential.currentSpecies.id, middle.id)
    XCTAssertEqual(potential.path.map(\.id), [middle.id, final.id])
    XCTAssertEqual(potential.guaranteedRarity, "ORIGIN")
  }

  func testBranchCreaturePotentialNeverFallsBackToTheRootCeiling() throws {
    let root = potentialSpecies(
      id: "PG-002", name: "모루핀", rarity: "PROCESS", stage: 1, category: "start")
    let automatic = potentialSpecies(
      id: "PG-062", name: "모루벨", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let branch = potentialSpecies(
      id: "PG-182", name: "바르켈름", rarity: "DAEMON", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: branch.id, originSpeciesID: root.id, level: 18,
      experience: 0, affection: 20, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let potential = try XCTUnwrap(
      EvolutionPotentialPresentation.make(for: creature, catalog: [root, automatic, branch]))

    XCTAssertEqual(potential.currentSpecies.id, branch.id)
    XCTAssertEqual(potential.finalSpecies.id, branch.id)
    XCTAssertEqual(potential.path.map(\.id), [branch.id])
    XCTAssertEqual(potential.currentRarityLabel, "현재 DAEMON")
    XCTAssertEqual(potential.finalRarityLabel, "최대 도달 등급 DAEMON")
    XCTAssertEqual(potential.guaranteedRarityLabel, "최소 보장 등급 DAEMON")
  }

  func testEvolutionDexShowsSelectableBranchesWithoutHighlightingAnyPathByDefault() throws {
    let root = CreatureSpecies(
      id: "PG-001", koName: "시작형", enName: "Root", lineageId: "PG-L001",
      rarity: "PROCESS", stage: 1, category: "start", bodyForm: "form",
      identity: "identity", lore: "lore", imagePath: ""
    )
    let normal = CreatureSpecies(
      id: "PG-061", koName: "기본 진화", enName: "Normal", lineageId: "PG-L001",
      rarity: "AGENT", stage: 2, category: "normal_evolution", bodyForm: "form",
      identity: "identity", lore: "lore", evolutionFrom: [root.id], imagePath: ""
    )
    let branch = CreatureSpecies(
      id: "PG-216", koName: "분기 진화", enName: "Branch", lineageId: "PG-L001-M",
      rarity: "DAEMON", stage: 2, category: "mutant", bodyForm: "form",
      identity: "identity", lore: "lore", evolutionFrom: ["PG-L001:S1"], imagePath: ""
    )
    let final = CreatureSpecies(
      id: "PG-181", koName: "최종 진화", enName: "Final", lineageId: "PG-L001",
      rarity: "DAEMON", stage: 3, category: "normal_evolution", bodyForm: "form",
      identity: "identity", lore: "lore", evolutionFrom: [normal.id], imagePath: ""
    )
    let otherRoot = CreatureSpecies(
      id: "PG-002", koName: "다른 시작형", enName: "Other Root", lineageId: "PG-L002",
      rarity: "PROCESS", stage: 1, category: "start", bodyForm: "form",
      identity: "identity", lore: "lore", imagePath: ""
    )
    let otherNormal = CreatureSpecies(
      id: "PG-062", koName: "다른 진화", enName: "Other Normal", lineageId: "PG-L002",
      rarity: "AGENT", stage: 2, category: "normal_evolution", bodyForm: "form",
      identity: "identity", lore: "lore", evolutionFrom: [otherRoot.id], imagePath: ""
    )
    let mixed = CreatureSpecies(
      id: "PG-196", koName: "혼합 진화", enName: "Mixed", lineageId: "PG-LX",
      rarity: "ORACLE", stage: 3, category: "mixed", bodyForm: "form",
      identity: "identity", lore: "lore", evolutionFrom: [normal.id, otherNormal.id], imagePath: ""
    )
    let creature = OwnedCreature(
      id: UUID(), speciesID: final.id, originSpeciesID: root.id, level: 25,
      experience: 0, affection: 40, nickname: nil, uniqueColor: false, acquiredAt: .now
    )

    let presentation = try XCTUnwrap(
      EvolutionDexPresentation.make(
        creature: creature,
        catalog: [root, otherRoot, normal, otherNormal, branch, final, mixed],
        discoveredSpeciesIDs: [root.id, normal.id, final.id]
      )
    )

    XCTAssertEqual(presentation.stages.map(\.stage), [1, 2, 3])
    XCTAssertEqual(presentation.stages[1].entries.map(\.species.id), [normal.id, branch.id])
    XCTAssertEqual(
      presentation.stages[1].entries.first(where: { $0.species.id == normal.id })?.parentNames,
      [root.koName]
    )
    XCTAssertEqual(
      presentation.stages[2].entries.first(where: { $0.species.id == final.id })?.parentNames,
      [normal.koName]
    )
    let entries = presentation.stages.flatMap(\.entries)
    XCTAssertFalse(entries.contains(where: { $0.species.id == mixed.id }))
    XCTAssertTrue(entries.first(where: { $0.species.id == final.id })?.isCurrent == true)
    // 선호를 지정하지 않았으므로 도감의 어떤 항목도 강조되지 않는다.
    // 카테고리는 원래 값 그대로 보여준다. "자동 진화"로 덮어쓰지 않는다.
    XCTAssertEqual(entries.first(where: { $0.species.id == normal.id })?.categoryLabel, "기본")
    XCTAssertEqual(entries.first(where: { $0.species.id == branch.id })?.categoryLabel, "변이")
    XCTAssertEqual(presentation.potential.finalSpecies.id, final.id)
    XCTAssertEqual(presentation.potential.path.map(\.id), [final.id])
  }

  func testExistingMixedCreatureIsPresentedOnlyAsItsCurrentStandaloneFusionForm() throws {
    let root = potentialSpecies(
      id: "PG-M01", name: "부모", rarity: "PROCESS", stage: 1, category: "start")
    let parent = potentialSpecies(
      id: "PG-M02", name: "과거 후보", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let mixed = potentialSpecies(
      id: "PG-M03", name: "융합 수집품", rarity: "ORACLE", stage: 3,
      category: "mixed", evolutionFrom: [parent.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: mixed.id, originSpeciesID: root.id, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let presentation = try XCTUnwrap(EvolutionDexPresentation.make(
      creature: creature,
      catalog: [root, parent, mixed],
      discoveredSpeciesIDs: [root.id, parent.id, mixed.id],
      ownedCreatures: [creature]
    ))

    XCTAssertEqual(presentation.rootSpecies.id, mixed.id)
    XCTAssertEqual(presentation.stages.count, 1)
    XCTAssertEqual(presentation.stages[0].entries.map(\.species.id), [mixed.id])
    XCTAssertEqual(presentation.stages[0].entries[0].parentNames, [])
    XCTAssertTrue(presentation.stages[0].entries[0].isCurrent)
    XCTAssertTrue(presentation.stages[0].entries[0].isFormOwned)
    XCTAssertEqual(
      presentation.lineageNotice,
      "혼합형은 일반 진화 계보 밖의 융합 수집품입니다. 현재 모습만 표시합니다.")
    XCTAssertNil(presentation.mutationLineageNotice)
    XCTAssertEqual(presentation.potential.path.map(\.id), [mixed.id])

    var state = GameState()
    state.ownedCreatures = [creature]
    state.tokenBalance = max(GameState.inheritCost, GameState.mutationRetryCost)
    let compact = CompactViewState(
      state: state,
      currentCreature: creature,
      currentPosition: 1,
      catalogIsEmpty: false,
      weeklyUsage: [:],
      catalog: [root, parent, mixed]
    )
    XCTAssertFalse(compact.retryMutation.isEnabled)
    XCTAssertFalse(compact.inherit.isEnabled)
    XCTAssertTrue(compact.retryMutation.explanation.contains("융합 수집품"))
    XCTAssertTrue(compact.inherit.explanation.contains("융합 수집품"))
  }

  func testAmbiguousLegacyLineageShowsOnlyTheCurrentForm() throws {
    let firstRoot = potentialSpecies(
      id: "PG-A01", name: "첫 시작", rarity: "PROCESS", stage: 1, category: "start")
    let secondRoot = potentialSpecies(
      id: "PG-A02", name: "둘째 시작", rarity: "PROCESS", stage: 1, category: "start")
    let current = potentialSpecies(
      id: "PG-A03", name: "현재 모습", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [firstRoot.id, secondRoot.id])
    let creature = OwnedCreature(
      id: UUID(), speciesID: current.id, level: 15, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let presentation = try XCTUnwrap(EvolutionDexPresentation.make(
      creature: creature,
      catalog: [firstRoot, secondRoot, current],
      discoveredSpeciesIDs: [firstRoot.id, secondRoot.id, current.id],
      ownedCreatures: [creature]
    ))

    XCTAssertTrue(presentation.isStandalone)
    XCTAssertEqual(presentation.rootSpecies.id, current.id)
    XCTAssertEqual(presentation.stages.flatMap(\.entries).map(\.species.id), [current.id])
    XCTAssertEqual(presentation.potential.path.map(\.id), [current.id])
    XCTAssertEqual(
      presentation.lineageNotice,
      EvolutionDexPresentation.unresolvedLineageNotice)
    XCTAssertNil(presentation.mutationLineageNotice)
  }

  func testEvolutionDexUnlocksOnlyFormsReachedByTheCurrentCreature() throws {
    let root = potentialSpecies(
      id: "PG-T01", name: "1단계", rarity: "PROCESS", stage: 1, category: "start")
    let chosenStageTwo = potentialSpecies(
      id: "PG-T02", name: "선택한 2단계", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let siblingStageTwo = potentialSpecies(
      id: "PG-T12", name: "선택하지 않은 2단계", rarity: "DAEMON", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let stageThree = potentialSpecies(
      id: "PG-T03", name: "3단계", rarity: "ORACLE", stage: 3,
      category: "normal_evolution", evolutionFrom: [chosenStageTwo.id])
    let stageFour = potentialSpecies(
      id: "PG-T04", name: "4단계", rarity: "ORIGIN", stage: 4,
      category: "normal_evolution", evolutionFrom: [stageThree.id])
    let catalog = [root, chosenStageTwo, siblingStageTwo, stageThree, stageFour]
    let globallyDiscovered = Set(catalog.map(\.id))

    for (current, expectedReached) in [
      (chosenStageTwo, Set([root.id, chosenStageTwo.id])),
      (stageFour, Set([root.id, chosenStageTwo.id, stageThree.id, stageFour.id])),
    ] {
      let creature = OwnedCreature(
        id: UUID(), speciesID: current.id, originSpeciesID: root.id,
        level: current.stage == 4 ? 40 : 15, experience: 0, affection: 0,
        nickname: nil, uniqueColor: false, acquiredAt: .now)
      let presentation = try XCTUnwrap(
        EvolutionDexPresentation.make(
          creature: creature,
          catalog: catalog,
          discoveredSpeciesIDs: globallyDiscovered))
      let entries = Dictionary(
        uniqueKeysWithValues: presentation.stages.flatMap(\.entries).map { ($0.id, $0) })

      for species in catalog {
        let entry = try XCTUnwrap(entries[species.id])
        XCTAssertEqual(entry.isFormOwned, expectedReached.contains(species.id), species.id)
        XCTAssertEqual(
          entry.canPreviewForm,
          expectedReached.contains(species.id) && species.id != current.id,
          species.id)
      }
    }
  }

  func testCreaturePreviewSelectionDoesNotLeakIntoAnotherCreature() throws {
    let firstID = UUID()
    let secondID = UUID()
    let root = potentialSpecies(
      id: "PG-P01", name: "시작형", rarity: "PROCESS", stage: 1, category: "start")
    let past = potentialSpecies(
      id: "PG-P02", name: "과거 모습", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let current = potentialSpecies(
      id: "PG-P03", name: "현재 모습", rarity: "DAEMON", stage: 3,
      category: "normal_evolution", evolutionFrom: [past.id])
    let catalog = [root, past, current]
    let initial = OwnedCreature(
      id: firstID, speciesID: current.id, originSpeciesID: root.id, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let another = OwnedCreature(
      id: secondID, speciesID: current.id, originSpeciesID: root.id, level: 25,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let restoredAtStageOne = OwnedCreature(
      id: firstID, speciesID: root.id, originSpeciesID: root.id, level: 1,
      experience: 0, affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let selection = CreaturePreviewSelection(creatureID: firstID, speciesID: past.id)

    XCTAssertEqual(selection.species(for: initial, in: catalog), past)
    XCTAssertNil(selection.species(for: another, in: catalog))
    XCTAssertNil(selection.species(for: restoredAtStageOne, in: catalog))
    XCTAssertNil(selection.species(for: nil, in: catalog))
  }


  func testEvolutionDexStatesWhenALineageHasNoMutationAtAll() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let withoutMutations = catalog.filter { $0.category != "mutant" }

    let presentation = try XCTUnwrap(
      EvolutionDexPresentation.make(
        creature: creature, catalog: withoutMutations, discoveredSpeciesIDs: ["PG-001"]))

    XCTAssertFalse(presentation.lineageHasMutation)
    XCTAssertEqual(presentation.mutationLineageNotice, "이 계열에는 변이형이 없습니다")
  }

  func testEvolutionDexMarksSeparatelyOwnedSpeciesApartFromTheCurrentOne() throws {
    let catalog = try CreatureCatalog.load()
    let current = OwnedCreature(
      id: UUID(), speciesID: "PG-181", originSpeciesID: "PG-001", level: 25, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let inherited = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let presentation = try XCTUnwrap(
      EvolutionDexPresentation.make(
        creature: current, catalog: catalog, discoveredSpeciesIDs: ["PG-001", "PG-181"],
        ownedCreatures: [current, inherited]))
    let entries = presentation.stages.flatMap(\.entries)

    let owned = try XCTUnwrap(entries.first { $0.species.id == "PG-001" })
    XCTAssertEqual(owned.ownedCreatureID, inherited.id)
    XCTAssertTrue(owned.isOwnedApartFromCurrent)

    // 보고 있는 개체는 바꿀 것이 없으므로 보유하고 있어도 선택 대상이 아니다.
    let currentEntry = try XCTUnwrap(entries.first { $0.species.id == "PG-181" })
    XCTAssertEqual(currentEntry.ownedCreatureID, current.id)
    XCTAssertTrue(currentEntry.isCurrent)
    XCTAssertFalse(currentEntry.isOwnedApartFromCurrent)

    let unowned = entries.filter { !["PG-001", "PG-181"].contains($0.species.id) }
    XCTAssertFalse(unowned.isEmpty)
    XCTAssertTrue(unowned.allSatisfy { $0.ownedCreatureID == nil && !$0.isOwnedApartFromCurrent })
  }

  func testEvolutionDexPicksTheSameOwnedCreatureRegardlessOfInputOrder() throws {
    let catalog = try CreatureCatalog.load()
    let base = Date(timeIntervalSince1970: 1_754_275_200)
    let current = OwnedCreature(
      id: UUID(), speciesID: "PG-181", originSpeciesID: "PG-001", level: 25, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: base)
    // 같은 종을 세 마리 보유한다. 먼저 얻은 개체가 뽑혀야 하며, 입력 순서는 결과를 바꾸지 못한다.
    let earliest = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: base)
    let middle = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: base.addingTimeInterval(60))
    let latest = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: base.addingTimeInterval(120))

    for owned in [[current, latest, middle, earliest], [earliest, middle, latest, current]] {
      let presentation = try XCTUnwrap(
        EvolutionDexPresentation.make(
          creature: current, catalog: catalog, discoveredSpeciesIDs: ["PG-001"],
          ownedCreatures: owned))
      let entry = try XCTUnwrap(
        presentation.stages.flatMap(\.entries).first { $0.species.id == "PG-001" })
      XCTAssertEqual(entry.ownedCreatureID, earliest.id)
    }
  }

  func testEvolutionDexReportsNoOwnershipWhenTheCallerPassesNoCreatures() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-181", originSpeciesID: "PG-001", level: 25, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)

    let presentation = try XCTUnwrap(
      EvolutionDexPresentation.make(
        creature: creature, catalog: catalog, discoveredSpeciesIDs: ["PG-181"]))

    XCTAssertTrue(
      presentation.stages.flatMap(\.entries).allSatisfy {
        $0.ownedCreatureID == nil && !$0.isOwnedApartFromCurrent
      })
  }

  func testPendingChoiceBadgeStaysVisibleForCreaturesOtherThanTheCurrentOne() throws {
    let catalog = try CreatureCatalog.load()
    let calm = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001", level: 1, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let waiting = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002", level: 15, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let waitingChoice = try XCTUnwrap(
      GameEngine.pendingEvolutionChoice(for: waiting, catalog: catalog))

    XCTAssertNil(GameEngine.pendingEvolutionChoice(for: calm, catalog: catalog))
    XCTAssertFalse(PendingEvolutionBadgePresentation(choices: []).isVisible)

    let badge = PendingEvolutionBadgePresentation(choices: [waitingChoice])
    XCTAssertTrue(badge.isVisible)
    XCTAssertEqual(badge.creatureID, waiting.id)
    XCTAssertEqual(badge.label, "진화 선택 대기")
    XCTAssertEqual(
      PendingEvolutionBadgePresentation(choices: [waitingChoice, waitingChoice]).label,
      "진화 선택 대기 2마리")
  }

  func testEvolutionChoiceOffersAtMostTwoCardsAndHidesUndiscoveredIdentity() throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-002", originSpeciesID: "PG-002", level: 15, experience: 0,
      affection: 0, nickname: nil, uniqueColor: false, acquiredAt: .now)
    let choice = try XCTUnwrap(GameEngine.pendingEvolutionChoice(for: creature, catalog: catalog))

    let presentation = EvolutionChoicePresentation.make(
      choice: choice, catalog: catalog, discoveredSpeciesIDs: ["PG-002", "PG-062"])
    let known = try XCTUnwrap(presentation.cards.first { $0.id == "PG-062" })
    let hidden = try XCTUnwrap(presentation.cards.first { $0.id == "PG-182" })

    XCTAssertEqual(presentation.cards.count, 2)
    XCTAssertTrue(presentation.cards.count <= 2)
    XCTAssertEqual(presentation.title, "진화 방향 선택")

    XCTAssertEqual(known.displayName, "모루벨")
    XCTAssertTrue(known.showsArtwork)
    XCTAssertEqual(known.categoryLabel, "기본")
    XCTAssertEqual(known.maximumRarityLabel, "최대 도달 AGENT")
    XCTAssertTrue(known.isTerminal)
    XCTAssertEqual(known.terminalLabel, "이후 성장 없음")
    XCTAssertNotNil(known.confirmationMessage)

    XCTAssertFalse(hidden.showsArtwork)
    XCTAssertEqual(hidden.displayName, "미발견 진화체")
    XCTAssertNotEqual(hidden.displayName, hidden.species.koName)
    XCTAssertFalse(hidden.displayName.contains(hidden.species.imagePath))
    XCTAssertNil(hidden.maximumRarityLabel)
    XCTAssertEqual(hidden.species.rarity, "DAEMON")
    XCTAssertEqual(hidden.categoryLabel, "분기")
    XCTAssertEqual(hidden.terminalLabel, "이후 성장 없음")
    XCTAssertEqual(
      hidden.confirmationMessage,
      "미발견 진화체(으)로 진화하면 이 진화 이후로는 더 성장하지 않습니다. 그래도 진행할까요?")
  }


  func testProductionEiluLineageUsesApprovedEilsionFinalEvolution() throws {
    let catalog = try CreatureCatalog.load()
    let eilvan = try XCTUnwrap(catalog.first { $0.id == "PG-061" })
    let eilsion = try XCTUnwrap(catalog.first { $0.id == "PG-181" })

    XCTAssertEqual(eilsion.koName, "에일시온")
    XCTAssertEqual(eilsion.enName, "Eilsion")
    XCTAssertEqual(eilsion.lineageId, "PG-L001")
    XCTAssertEqual(eilsion.rarity, "DAEMON")
    XCTAssertEqual(eilsion.category, "normal_evolution")
    XCTAssertEqual(eilsion.evolutionFrom, [eilvan.id])
    XCTAssertEqual(EvolutionCatalog.candidates(after: eilvan, in: catalog).first?.id, eilsion.id)
    XCTAssertEqual(eilsion.imagePath, "assets/creatures/generated/PG-181.png")
  }

  func testIntegrationStatusPresentationNeverReliesOnColorAlone() {
    let stopped = IntegrationStatusPresentation(.stopped, provider: .claude)
    let listening = IntegrationStatusPresentation(.listening, provider: .claude)
    let recent = IntegrationStatusPresentation(.recentlyReceiving, provider: .claude)
    let error = IntegrationStatusPresentation(.error("포트 충돌"), provider: .claude)

    XCTAssertTrue(stopped.label == "중지됨")
    XCTAssertEqual(listening.label, "로그 감시 중")
    XCTAssertTrue(recent.label == "방금 수신")
    XCTAssertTrue(error.label == "확인 필요")
    XCTAssertTrue(error.detail == "포트 충돌")
    XCTAssertTrue(Set([stopped.symbol, listening.symbol, recent.symbol, error.symbol]).count == 4)
  }

  func testIntegrationStatusPresentationExplainsProviderSpecificListeningScope() {
    let claude = IntegrationStatusPresentation(.listening, provider: .claude)
    let codex = IntegrationStatusPresentation(.listening, provider: .codex)

    XCTAssertTrue(claude.detail.contains("~/.claude/projects"))
    XCTAssertTrue(codex.detail.contains("~/.codex/sessions"))
    XCTAssertTrue(claude.detail.contains("감시하고 있습니다"))
    XCTAssertFalse(claude.detail.contains("연결"))
    XCTAssertTrue(claude.detail != codex.detail)
  }

  func testCompactViewStateSeparatesStarterBalanceFromMeasuredUsageAndExplainsDisabledActions() {
    let state = GameState()
    let presentation = CompactViewState(
      state: state,
      currentCreature: nil,
      currentPosition: nil,
      catalogIsEmpty: false,
      weeklyUsage: [:]
    )

    XCTAssertTrue(presentation.balance == 2_000_000)
    XCTAssertTrue(presentation.weeklyClaude == 0)
    XCTAssertTrue(presentation.weeklyCodex == 0)
    XCTAssertTrue(!presentation.feed.isEnabled)
    XCTAssertTrue(!presentation.feedLarge.isEnabled)
    XCTAssertTrue(presentation.purchaseFood.isEnabled)
    XCTAssertTrue(presentation.purchaseLargeFood.isEnabled)
    XCTAssertTrue(presentation.purchaseFood.explanation.contains(GameState.foodCost.formatted()))
    XCTAssertTrue(presentation.feed.explanation.contains("가챠"))
    XCTAssertTrue(presentation.pull.isEnabled)
    XCTAssertTrue(presentation.pull.explanation.contains(GameState.gachaCost.formatted()))
    XCTAssertTrue(!presentation.showsNavigation)
  }

  func testFoodPurchasePresentationStaysVisibleButDisabledWhenTokensAreShort() {
    var state = GameState()
    state.tokenBalance = GameState.foodCost - 1
    state.inventory.food = 0
    let presentation = CompactViewState(
      state: state,
      currentCreature: nil,
      currentPosition: nil,
      catalogIsEmpty: false,
      weeklyUsage: [:]
    )

    XCTAssertFalse(presentation.purchaseFood.isEnabled)
    XCTAssertTrue(presentation.purchaseFood.explanation.contains("1"))
  }

  func testFoodPurchasePresentationDisablesAtInventoryLimit() {
    var state = GameState()
    state.inventory.food = Int.max
    let presentation = CompactViewState(
      state: state,
      currentCreature: nil,
      currentPosition: nil,
      catalogIsEmpty: false,
      weeklyUsage: [:]
    )

    XCTAssertFalse(presentation.purchaseFood.isEnabled)
    XCTAssertTrue(presentation.purchaseFood.explanation.contains("한도"))
  }

  func testLargeFoodPresentationExplainsFastGrowthAndPurchaseCost() {
    let creature = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 1, experience: 0, affection: 0,
      nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    var state = GameState()
    state.ownedCreatures = [creature]
    state.inventory.largeFood = 1
    let presentation = CompactViewState(
      state: state,
      currentCreature: creature,
      currentPosition: 1,
      catalogIsEmpty: false,
      weeklyUsage: [:]
    )

    XCTAssertTrue(presentation.feedLarge.isEnabled)
    XCTAssertTrue(presentation.feedLarge.explanation.contains("XP +200"))
    XCTAssertTrue(presentation.purchaseLargeFood.isEnabled)
    XCTAssertTrue(presentation.purchaseLargeFood.explanation.contains(GameState.largeFoodCost.formatted()))
  }

  func testCompactViewStateShowsNavigationPositionAndRepresentativeTruthfully() {
    let first = OwnedCreature(
      id: UUID(), speciesID: "PG-001", level: 3, experience: 20, affection: 8,
      nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 1)
    )
    let second = OwnedCreature(
      id: UUID(), speciesID: "PG-002", level: 1, experience: 0, affection: 0,
      nickname: nil, uniqueColor: false, acquiredAt: Date(timeIntervalSince1970: 2)
    )
    var state = GameState()
    state.ownedCreatures = [first, second]
    state.representativeCreatureID = first.id
    state.inventory.food = 0
    let presentation = CompactViewState(
      state: state,
      currentCreature: second,
      currentPosition: 2,
      catalogIsEmpty: false,
      weeklyUsage: [.claude: 120, .codex: 80]
    )

    XCTAssertTrue(presentation.showsNavigation)
    XCTAssertTrue(presentation.positionLabel == "2 / 2")
    XCTAssertTrue(!presentation.isRepresentative)
    XCTAssertTrue(!presentation.feed.isEnabled)
    XCTAssertTrue(presentation.feed.explanation.contains("먹이"))
    XCTAssertTrue(presentation.weeklyClaude == 120)
    XCTAssertTrue(presentation.weeklyCodex == 80)
  }

  func testCompactViewStateUsesVisibleUniqueCountForNavigation() {
    let first = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001",
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1))
    let duplicate = OwnedCreature(
      id: UUID(), speciesID: "PG-001", originSpeciesID: "PG-001",
      level: 1, experience: 0, affection: 0, nickname: nil, uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 2))
    var state = GameState()
    state.ownedCreatures = [first, duplicate]

    let presentation = CompactViewState(
      state: state,
      currentCreature: first,
      currentPosition: 1,
      visibleCreatureCount: 1,
      catalogIsEmpty: false,
      weeklyUsage: [:])

    XCTAssertFalse(presentation.showsNavigation)
    XCTAssertEqual(presentation.positionLabel, "1 / 1")
  }

  func testAllOriginRevealPathsConvergeOnTheSameCompletedPhase() {
    XCTAssertTrue(OriginRevealPath.allCases.allSatisfy { $0.completedPhase == .revealed })
  }

  func testOriginRevealTransitionPathsDismissOnlyRevealWindowAndNeverOpenPopup() {
    for path in OriginRevealPath.allCases {
      var transition = OriginRevealTransitionState(requestID: UUID())
      transition.begin(reduceMotion: path == .reducedMotion)
      transition.complete(path)
      let commands = transition.dismiss()

      XCTAssertTrue(transition.phase == .revealed)
      XCTAssertTrue(commands == [.dismissWindow("origin-reveal")])
      XCTAssertTrue(!commands.contains(.openPopup))
    }
  }

  @MainActor
  func testOriginRevealRequestAndPresentationStayBoundToAcquiredUUID() throws {
    let species = CreatureSpecies(
      id: "PG-ORIGIN", koName: "기원", enName: "Origin", rarity: "ORIGIN", stage: 1,
      category: "base", bodyForm: "dragon", identity: "origin", lore: "bound", imagePath: ""
    )
    let acquired = OwnedCreature(
      id: UUID(), speciesID: species.id, level: 1, experience: 0, affection: 0,
      nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    let other = OwnedCreature(
      id: UUID(), speciesID: "PG-OTHER", level: 1, experience: 0, affection: 0,
      nickname: nil, uniqueColor: false, acquiredAt: .now
    )
    var state = GameState()
    state.ownedCreatures = [acquired, other]
    let coordinator = OriginRevealCoordinator()

    let outcome = try XCTUnwrap(coordinator.requestReveal(for: acquired, species: species))
    let request = outcome.request
    let presentation = try XCTUnwrap(
      OriginRevealPresentation(
        request: coordinator.currentRequest, state: state, catalog: [species]
      ))

    XCTAssertTrue(request.creatureID == acquired.id)
    XCTAssertTrue(presentation.creature.id == acquired.id)
    XCTAssertTrue(coordinator.currentRequest == request)
    XCTAssertTrue(outcome.windowCommand.windowID == "origin-reveal")
    XCTAssertTrue(outcome.windowCommand.requestID == request.id)
    XCTAssertTrue(coordinator.lastWindowCommand == outcome.windowCommand)
    XCTAssertTrue(coordinator.issuedWindowCommandCount == 1)

    coordinator.windowDidClose(requestID: request.id)
    XCTAssertTrue(coordinator.issuedWindowCommandCount == 1)
    XCTAssertTrue(coordinator.currentRequest == request)
    XCTAssertTrue(OriginRevealPath.allCases.allSatisfy { $0.completedPhase == .revealed })
  }

  func testLockedSearchCannotMatchUndiscoveredIdentity() {
    let hidden = CreatureSpecies(
      id: "PG-SECRET", koName: "숨은이름", enName: "SecretName", rarity: "PROCESS", stage: 1,
      category: "base", bodyForm: "form", identity: "identity", lore: "lore", imagePath: ""
    )

    XCTAssertTrue(
      CollectionSearch.results(catalog: [hidden], discoveredSpeciesIDs: [], query: "SECRET").isEmpty
    )
    XCTAssertTrue(
      CollectionSearch.results(catalog: [hidden], discoveredSpeciesIDs: [], query: "숨은이름").isEmpty)
    XCTAssertTrue(
      CollectionSearch.results(catalog: [hidden], discoveredSpeciesIDs: [], query: "").count == 1)
  }

  @MainActor
  func testCreatureImageCacheHasBoundedCountAndMemoryCost() {
    XCTAssertTrue(CreatureImageCache.countLimit == 48)
    XCTAssertTrue(CreatureImageCache.costLimit == 64 * 1_024 * 1_024)
  }

  func testLargeWindowExposesOnlyApprovedDestinations() {
    XCTAssertTrue(MainDestination.allCases == [.collection, .connections, .settings])
  }

  @MainActor
  func testPopupDockMapsEachManagementButtonToTheRequestedLargeWindowDestination() throws {
    let navigation = MainWindowNavigation()

    XCTAssertEqual(
      MenuDockItem.allCases,
      [.collection, .rarity, .evolution, .settings, .quit]
    )
    for item in [MenuDockItem.collection, .settings] {
      let command = try XCTUnwrap(navigation.command(for: item))
      XCTAssertEqual(command.windowID, "main")
      XCTAssertEqual(command.destination, item.destination)
      XCTAssertEqual(navigation.destination, item.destination)
    }
    XCTAssertNil(navigation.command(for: .rarity))
    XCTAssertNil(navigation.command(for: .evolution))
    XCTAssertNil(navigation.command(for: .quit))
  }

  func testRarityGuideShowsPullProbabilityAndOwnedCatalogCounts() throws {
    let process = CreatureSpecies(
      id: "PG-P", koName: "프로세스", enName: "Process", rarity: "PROCESS", stage: 1,
      category: "start", bodyForm: "form", identity: "identity", lore: "lore", imagePath: ""
    )
    let agent = CreatureSpecies(
      id: "PG-A", koName: "에이전트", enName: "Agent", rarity: "AGENT", stage: 2,
      category: "evolution", bodyForm: "form", identity: "identity", lore: "lore", imagePath: ""
    )
    let origin = CreatureSpecies(
      id: "PG-O", koName: "오리진", enName: "Origin", rarity: "ORIGIN", stage: 4,
      category: "special", bodyForm: "form", identity: "identity", lore: "lore", imagePath: ""
    )
    var state = GameState()
    state.discoveredSpeciesIDs = [process.id, agent.id]
    state.ownedCreatures = [
      OwnedCreature(
        id: UUID(), speciesID: process.id, level: 1, experience: 0, affection: 0,
        nickname: nil, uniqueColor: false, acquiredAt: .now
      ),
      OwnedCreature(
        id: UUID(), speciesID: agent.id, level: 15, experience: 0, affection: 20,
        nickname: nil, uniqueColor: false, acquiredAt: .now
      ),
      OwnedCreature(
        id: UUID(), speciesID: agent.id, level: 16, experience: 0, affection: 25,
        nickname: nil, uniqueColor: false, acquiredAt: .now
      ),
    ]

    let rows = RarityGuidePresentation.rows(state: state, catalog: [process, agent, origin])
    XCTAssertEqual(rows.map(\.tier), Array(RarityVisualTier.allCases.reversed()))

    let processRow = try XCTUnwrap(rows.first { $0.tier == .process })
    XCTAssertEqual(processRow.pullProbability, 100)
    XCTAssertEqual(processRow.pullProbabilityLabel, "100%")
    XCTAssertEqual(processRow.ownedCount, 1)
    XCTAssertEqual(processRow.discoveredCount, 1)
    XCTAssertEqual(processRow.catalogCount, 1)

    let agentRow = try XCTUnwrap(rows.first { $0.tier == .agent })
    XCTAssertEqual(agentRow.pullProbability, 0)
    XCTAssertEqual(agentRow.pullProbabilityLabel, "0% · 진화 전용")
    XCTAssertEqual(agentRow.ownedCount, 2)
    XCTAssertEqual(agentRow.discoveredCount, 1)
    XCTAssertEqual(agentRow.catalogCount, 1)

    let originRow = try XCTUnwrap(rows.first { $0.tier == .origin })
    XCTAssertEqual(originRow.ownedCount, 0)
    XCTAssertEqual(originRow.discoveredCount, 0)
    XCTAssertEqual(originRow.catalogCount, 1)
  }

  func testRarityGuideSeparatesDirectPullProbabilityFromMaxReachableLineages() throws {
    let processRoot = potentialSpecies(
      id: "PG-P", name: "프로세스", rarity: "PROCESS", stage: 1, category: "start")
    let originRoot = potentialSpecies(
      id: "PG-O", name: "오리진 계보", rarity: "PROCESS", stage: 1, category: "start")
    // 기본 후보(`normal_evolution`)가 낮은 등급이라, 자동 경로 기준이면 이 계보가 DAEMON으로
    // 잡힌다. 등급표는 상한 기준이므로 분기 쪽 ORIGIN을 세야 한다.
    let originNormal = potentialSpecies(
      id: "PG-ON", name: "기본 진화", rarity: "DAEMON", stage: 2,
      category: "normal_evolution", evolutionFrom: [originRoot.id])
    let originFinal = potentialSpecies(
      id: "PG-OF", name: "오리진", rarity: "ORIGIN", stage: 2,
      category: "branch", evolutionFrom: [originRoot.id])

    let rows = RarityGuidePresentation.rows(
      state: GameState(), catalog: [processRoot, originFinal, originNormal, originRoot])
    let processRow = try XCTUnwrap(rows.first { $0.tier == .process })
    let daemonRow = try XCTUnwrap(rows.first { $0.tier == .daemon })
    let originRow = try XCTUnwrap(rows.first { $0.tier == .origin })

    XCTAssertEqual(processRow.pullProbability, 100)
    XCTAssertEqual(originRow.pullProbability, 0)
    XCTAssertEqual(daemonRow.finalPotentialLineageCount, 0)
    XCTAssertEqual(originRow.finalPotentialLineageCount, 1)
    XCTAssertEqual(originRow.finalPotentialLineageTotal, 2)
    XCTAssertEqual(originRow.finalPotentialProbability, 50)
    XCTAssertEqual(originRow.finalPotentialProbabilityLabel, "50%")
  }

  func testRarityGuideMatchesProductionCatalogDistribution() throws {
    let rows = RarityGuidePresentation.rows(
      state: GameState(),
      catalog: try CreatureCatalog.load()
    )
    let catalogCounts = Dictionary(uniqueKeysWithValues: rows.map { ($0.tier, $0.catalogCount) })

    XCTAssertEqual(catalogCounts[.process], 64)
    XCTAssertEqual(catalogCounts[.agent], 70)
    XCTAssertEqual(catalogCounts[.daemon], 55)
    XCTAssertEqual(catalogCounts[.oracle], 22)
    XCTAssertEqual(catalogCounts[.architect], 38)
    XCTAssertEqual(catalogCounts[.origin], 7)
    XCTAssertEqual(rows.first { $0.tier == .process }?.pullProbability, 100)
    XCTAssertTrue(
      rows.filter { $0.tier != .process }.allSatisfy { $0.pullProbability == 0 }
    )

    // 등급표의 잠재력 컬럼은 최대 도달 등급 기준이다. 컬럼 구조는 그대로 두고 값만 바뀐다.
    let ceilingCounts = Dictionary(
      uniqueKeysWithValues: rows.map { ($0.tier, $0.finalPotentialLineageCount) })
    XCTAssertEqual(ceilingCounts[.process], 0)
    XCTAssertEqual(ceilingCounts[.agent], 4)
    XCTAssertEqual(ceilingCounts[.daemon], 13)
    XCTAssertEqual(ceilingCounts[.oracle], 11)
    XCTAssertEqual(ceilingCounts[.architect], 29)
    XCTAssertEqual(ceilingCounts[.origin], 7)
    XCTAssertEqual(ceilingCounts.values.reduce(0, +), 64)
  }

  func testProductionCatalogMaxReachableAndGuaranteedRarityDistributionsCoverSixtyFourLineages() throws
  {
    let catalog = try CreatureCatalog.load()
    let starts = catalog.filter { $0.stage == 1 && $0.category == "start" }
    XCTAssertEqual(starts.count, 64)

    func distribution(_ rarity: (CreatureSpecies) -> String) -> [String: Int] {
      starts.reduce(into: [:]) { counts, species in counts[rarity(species), default: 0] += 1 }
    }

    let ceiling = distribution { EvolutionCatalog.maxReachableRarity(from: $0, in: catalog) }
    XCTAssertEqual(ceiling["PROCESS", default: 0], 0)
    XCTAssertEqual(ceiling["AGENT"], 4)
    XCTAssertEqual(ceiling["DAEMON"], 13)
    XCTAssertEqual(ceiling["ORACLE"], 11)
    XCTAssertEqual(ceiling["ARCHITECT"], 29)
    XCTAssertEqual(ceiling["ORIGIN"], 7)
    XCTAssertEqual(ceiling.values.reduce(0, +), 64)

    // 변이를 섞어 계산하면 DAEMON 16 · ORACLE 17 · ARCHITECT 14가 되므로 이 단언이 잡아낸다.
    let floor = distribution { EvolutionCatalog.minGuaranteedRarity(from: $0, in: catalog) }
    XCTAssertEqual(floor["PROCESS", default: 0], 0)
    XCTAssertEqual(floor["AGENT"], 10)
    XCTAssertEqual(floor["DAEMON"], 15)
    XCTAssertEqual(floor["ORACLE"], 16)
    XCTAssertEqual(floor["ARCHITECT"], 16)
    XCTAssertEqual(floor["ORIGIN"], 7)
    XCTAssertEqual(floor.values.reduce(0, +), 64)
  }

  func testProductionCatalogNeverCountsAMutationOnlyRarityAsReachable() throws {
    let catalog = try CreatureCatalog.load()
    let pg009 = try XCTUnwrap(catalog.first { $0.id == "PG-009" })
    let lineageMutationRarities = Set(
      catalog
        .filter { $0.category == EvolutionCatalog.mutantCategory }
        .filter { mutation in
          EvolutionCatalog.parents(of: mutation, in: catalog)
            .contains { $0.lineageId == pg009.lineageId }
        }
        .map(\.rarity))

    // 이 계보는 변이로만 DAEMON에 닿는다. 상한이 DAEMON으로 새면 회귀다.
    XCTAssertTrue(lineageMutationRarities.contains("DAEMON"))
    XCTAssertEqual(EvolutionCatalog.maxReachableRarity(from: pg009, in: catalog), "AGENT")
    XCTAssertEqual(EvolutionCatalog.minGuaranteedRarity(from: pg009, in: catalog), "AGENT")
  }

  func testEvolutionChoiceCardCeilingComesFromTheSharedCatalogFunction() throws {
    let root = potentialSpecies(
      id: "PG-001", name: "시작형", rarity: "PROCESS", stage: 1, category: "start")
    let lowBranch = potentialSpecies(
      id: "PG-061", name: "낮은 분기", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let highBranch = potentialSpecies(
      id: "PG-060", name: "높은 분기", rarity: "AGENT", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let highFinal = potentialSpecies(
      id: "PG-181", name: "높은 종착", rarity: "ARCHITECT", stage: 3,
      category: "normal_evolution", evolutionFrom: [highBranch.id])
    let mutation = potentialSpecies(
      id: "PG-201", name: "변이", rarity: "ORIGIN", stage: 3,
      category: "mutant", evolutionFrom: [lowBranch.id])
    let catalog = [root, lowBranch, highBranch, highFinal, mutation]

    let presentation = EvolutionChoicePresentation.make(
      choice: PendingEvolutionChoice(
        creatureID: UUID(), fromSpecies: root, candidates: [lowBranch, highBranch],
),
      catalog: catalog,
      discoveredSpeciesIDs: [lowBranch.id, highBranch.id]
    )
    let cards = Dictionary(uniqueKeysWithValues: presentation.cards.map { ($0.id, $0) })

    // 변이로만 닿는 ORIGIN은 카드 상한에 섞이지 않는다.
    XCTAssertEqual(cards[lowBranch.id]?.maximumReachableRarity, "AGENT")
    XCTAssertEqual(cards[lowBranch.id]?.maximumRarityLabel, "최대 도달 AGENT")
    XCTAssertEqual(cards[highBranch.id]?.maximumReachableRarity, "ARCHITECT")
    XCTAssertEqual(cards[highBranch.id]?.maximumRarityLabel, "최대 도달 ARCHITECT")
  }

  func testProductionCatalogKeepsTheSameSevenOriginLineagesUnderEveryCriterion() throws {
    let catalog = try CreatureCatalog.load()
    let starts = catalog.filter { $0.stage == 1 && $0.category == "start" }
    let expected = ["PG-041", "PG-045", "PG-054", "PG-241", "PG-245", "PG-249", "PG-253"]

    func originLineageIDs(_ rarity: (CreatureSpecies) -> String) -> [String] {
      starts.filter { rarity($0).uppercased() == "ORIGIN" }.map(\.id).sorted()
    }

    XCTAssertEqual(starts.count, 64)
    XCTAssertEqual(
      originLineageIDs { EvolutionCatalog.automaticPath(from: $0, in: catalog).last?.rarity ?? "" },
      expected)
    XCTAssertEqual(
      originLineageIDs { EvolutionCatalog.maxReachableRarity(from: $0, in: catalog) }, expected)
    XCTAssertEqual(
      originLineageIDs { EvolutionCatalog.minGuaranteedRarity(from: $0, in: catalog) }, expected)

    // ORIGIN 전용 연출은 `reachesOrigin` 하나에 걸려 있다. 기준이 바뀌어도 결과가 같아야 한다.
    XCTAssertEqual(
      starts.filter { EvolutionPotentialPresentation.make(from: $0, catalog: catalog).reachesOrigin }
        .map(\.id).sorted(),
      expected)
  }

  func testRarityGuideReportsElementalOriginFinalPotentialForProductionCatalog() throws {
    let catalog = try CreatureCatalog.load()
    let originRow = try XCTUnwrap(
      RarityGuidePresentation.rows(state: GameState(), catalog: catalog)
        .first { $0.tier == .origin })
    XCTAssertEqual(originRow.pullProbability, 0)
    XCTAssertEqual(originRow.finalPotentialLineageCount, 7)
    XCTAssertEqual(originRow.finalPotentialLineageTotal, 64)
    XCTAssertEqual(originRow.finalPotentialProbability, 10.9375)
    XCTAssertEqual(originRow.finalPotentialProbabilityLabel, "10.9%")
  }

  func testMenuPopoverReservesAScrollFreePlayAreaAndUsableFooterInsideItsFixedCanvas() {
    XCTAssertEqual(MenuPopoverLayout.width, 398)
    XCTAssertEqual(MenuPopoverLayout.height, 670)
    XCTAssertEqual(MenuPopoverLayout.dockHeight, 54)
    XCTAssertEqual(MenuPopoverLayout.contentHeight, 616)
    XCTAssertEqual(MenuPopoverLayout.contentHeight + MenuPopoverLayout.dockHeight, MenuPopoverLayout.height)
    XCTAssertGreaterThanOrEqual(MenuPopoverLayout.dockButtonHeight, 44)
    XCTAssertLessThanOrEqual(MenuPopoverLayout.dockButtonHeight, MenuPopoverLayout.dockHeight)
    XCTAssertGreaterThanOrEqual(MenuPopoverLayout.heroArtworkSize, 128)
    XCTAssertGreaterThan(MenuPopoverLayout.heroAuraSize, MenuPopoverLayout.heroArtworkSize)
  }

#if DEBUG
  func testMenuPopoverSnapshotRequestRejectsAMissingOutputPath() throws {
    XCTAssertNil(try MenuPopoverSnapshotRequest(arguments: ["PunchGrowMenuBar"]))
    XCTAssertThrowsError(
      try MenuPopoverSnapshotRequest(
        arguments: ["PunchGrowMenuBar", MenuPopoverSnapshotRequest.flag]
      )
    )
    XCTAssertEqual(
      try MenuPopoverSnapshotRequest(
        arguments: ["PunchGrowMenuBar", MenuPopoverSnapshotRequest.evolutionFlag, "/tmp/evolution.png"]
      )?.kind,
      .evolution
    )
    XCTAssertEqual(
      try MenuPopoverSnapshotRequest(
        arguments: ["PunchGrowMenuBar", MenuPopoverSnapshotRequest.rarityFlag, "/tmp/rarity.png"]
      )?.kind,
      .rarity
    )
    XCTAssertEqual(
      try MenuPopoverSnapshotRequest(
        arguments: ["PunchGrowMenuBar", MenuPopoverSnapshotRequest.menuBarHUDFlag, "/tmp/hud.png"]
      )?.kind,
      .menuBarHUD
    )
    let freshRequest = try MenuPopoverSnapshotRequest(
      arguments: ["PunchGrowMenuBar", MenuPopoverSnapshotRequest.menuFreshFlag, "/tmp/menu-fresh.png"]
    )
    XCTAssertEqual(freshRequest?.kind, .menuFresh)
    XCTAssertEqual(freshRequest?.usesFreshSetupFixture, true)
  }
#endif

}

private func potentialSpecies(
  id: String,
  name: String,
  rarity: String,
  stage: Int,
  category: String,
  evolutionFrom: [String] = []
) -> CreatureSpecies {
  CreatureSpecies(
    id: id, koName: name, enName: name, lineageId: "TEST-\(id)", rarity: rarity,
    stage: stage, category: category, bodyForm: "form", identity: "identity", lore: "lore",
    evolutionFrom: evolutionFrom, imagePath: "")
}
