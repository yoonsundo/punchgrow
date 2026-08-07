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

  func testAutomaticEvolutionPathFollowsCandidatePriorityAtEveryStage() {
    let root = potentialSpecies(
      id: "PG-001", name: "시작형", rarity: "PROCESS", stage: 1, category: "start")
    let normal = potentialSpecies(
      id: "PG-061", name: "기본 진화", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let branch = potentialSpecies(
      id: "PG-060", name: "분기 진화", rarity: "ORACLE", stage: 2,
      category: "branch", evolutionFrom: [root.id])
    let final = potentialSpecies(
      id: "PG-181", name: "최종 진화", rarity: "ORIGIN", stage: 3,
      category: "normal_evolution", evolutionFrom: [normal.id])

    let path = EvolutionCatalog.automaticPath(
      from: root, in: [branch, final, normal, root])

    XCTAssertEqual(path.map(\.id), [root.id, normal.id, final.id])
  }

  func testEvolutionPotentialDescribesFinalAutomaticOutcomeWithoutChangingCurrentRarity() {
    let root = potentialSpecies(
      id: "PG-001", name: "프라곤", rarity: "PROCESS", stage: 1, category: "start")
    let middle = potentialSpecies(
      id: "PG-061", name: "프라곤온", rarity: "AGENT", stage: 2,
      category: "normal_evolution", evolutionFrom: [root.id])
    let final = potentialSpecies(
      id: "PG-181", name: "피티온", rarity: "ORIGIN", stage: 3,
      category: "normal_evolution", evolutionFrom: [middle.id])

    let potential = EvolutionPotentialPresentation.make(
      from: root, catalog: [final, root, middle])

    XCTAssertEqual(potential.currentSpecies.id, root.id)
    XCTAssertEqual(potential.currentRarityLabel, "현재 PROCESS")
    XCTAssertEqual(potential.finalSpecies.id, final.id)
    XCTAssertEqual(potential.finalRarityLabel, "성장 잠재력 ORIGIN")
    XCTAssertEqual(potential.finalSpeciesName, "피티온")
    XCTAssertEqual(potential.path.map(\.id), [root.id, middle.id, final.id])
    XCTAssertTrue(potential.pathLabel.contains("프라곤 → 프라곤온 → 피티온"))
    XCTAssertTrue(potential.reachesOrigin)
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
  }

  func testBranchCreaturePotentialNeverFallsBackToTheRootAutomaticPath() throws {
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
    XCTAssertEqual(potential.finalRarityLabel, "성장 잠재력 DAEMON")
  }

  func testEvolutionDexShowsCurrentAutomaticPathAndBranches() throws {
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
    XCTAssertEqual(
      presentation.stages[2].entries.first(where: { $0.species.id == mixed.id })?.parentNames,
      [normal.koName, otherNormal.koName]
    )
    XCTAssertTrue(
      presentation.stages.flatMap(\.entries)
        .first(where: { $0.species.id == final.id })?.isCurrent == true
    )
    XCTAssertFalse(
      presentation.stages.flatMap(\.entries)
        .first(where: { $0.species.id == normal.id })?.isAutomaticPath == true
    )
    XCTAssertTrue(
      presentation.stages.flatMap(\.entries)
        .first(where: { $0.species.id == final.id })?.isAutomaticPath == true
    )
    XCTAssertFalse(
      presentation.stages.flatMap(\.entries)
        .first(where: { $0.species.id == branch.id })?.isAutomaticPath == true
    )
    XCTAssertEqual(presentation.potential.finalSpecies.id, final.id)
    XCTAssertEqual(presentation.potential.path.map(\.id), [final.id])
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

  func testRarityGuideSeparatesDirectPullProbabilityFromFinalPotentialLineages() throws {
    let processRoot = potentialSpecies(
      id: "PG-P", name: "프로세스", rarity: "PROCESS", stage: 1, category: "start")
    let originRoot = potentialSpecies(
      id: "PG-O", name: "오리진 계보", rarity: "PROCESS", stage: 1, category: "start")
    let originFinal = potentialSpecies(
      id: "PG-OF", name: "오리진", rarity: "ORIGIN", stage: 2,
      category: "normal_evolution", evolutionFrom: [originRoot.id])

    let rows = RarityGuidePresentation.rows(
      state: GameState(), catalog: [processRoot, originFinal, originRoot])
    let processRow = try XCTUnwrap(rows.first { $0.tier == .process })
    let originRow = try XCTUnwrap(rows.first { $0.tier == .origin })

    XCTAssertEqual(processRow.pullProbability, 100)
    XCTAssertEqual(originRow.pullProbability, 0)
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

    XCTAssertEqual(catalogCounts[.process], 60)
    XCTAssertEqual(catalogCounts[.agent], 66)
    XCTAssertEqual(catalogCounts[.daemon], 51)
    XCTAssertEqual(catalogCounts[.oracle], 22)
    XCTAssertEqual(catalogCounts[.architect], 38)
    XCTAssertEqual(catalogCounts[.origin], 3)
    XCTAssertEqual(rows.first { $0.tier == .process }?.pullProbability, 100)
    XCTAssertTrue(
      rows.filter { $0.tier != .process }.allSatisfy { $0.pullProbability == 0 }
    )
  }

  func testProductionCatalogHasExactlyThreeOriginAutomaticLineagesOutOfSixty() throws {
    let catalog = try CreatureCatalog.load()
    let starts = catalog.filter { $0.stage == 1 && $0.category == "start" }
    let originLineages = starts.filter {
      EvolutionCatalog.automaticPath(from: $0, in: catalog).last?.rarity == "ORIGIN"
    }

    XCTAssertEqual(starts.count, 60)
    XCTAssertEqual(originLineages.count, 3)
  }

  func testRarityGuideReportsFivePercentOriginFinalPotentialForProductionCatalog() throws {
    let catalog = try CreatureCatalog.load()
    let originRow = try XCTUnwrap(
      RarityGuidePresentation.rows(state: GameState(), catalog: catalog)
        .first { $0.tier == .origin })
    XCTAssertEqual(originRow.pullProbability, 0)
    XCTAssertEqual(originRow.finalPotentialLineageCount, 3)
    XCTAssertEqual(originRow.finalPotentialLineageTotal, 60)
    XCTAssertEqual(originRow.finalPotentialProbability, 5)
    XCTAssertEqual(originRow.finalPotentialProbabilityLabel, "5%")
  }

  func testMenuPopoverReservesAUsableFooterInsideItsFixedCanvas() {
    XCTAssertEqual(MenuPopoverLayout.width, 398)
    XCTAssertEqual(MenuPopoverLayout.height, 670)
    XCTAssertEqual(MenuPopoverLayout.dockHeight, 54)
    XCTAssertGreaterThanOrEqual(MenuPopoverLayout.dockButtonHeight, 44)
    XCTAssertLessThanOrEqual(MenuPopoverLayout.dockButtonHeight, MenuPopoverLayout.dockHeight)
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
