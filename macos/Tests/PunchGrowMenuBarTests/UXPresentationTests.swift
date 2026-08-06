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

}
