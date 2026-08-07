import AppKit
import SwiftUI

enum RarityFeedbackTier: Equatable {
  case staticAccent
  case pulse
  case burst
  case origin

  init(rarity: String) {
    switch rarity.uppercased() {
    case "ORIGIN": self = .origin
    case "ORACLE", "ARCHITECT": self = .burst
    case "AGENT", "DAEMON": self = .pulse
    default: self = .staticAccent
    }
  }
}

enum RarityVisualTier: Int, CaseIterable, Equatable, Hashable {
  case process
  case agent
  case daemon
  case oracle
  case architect
  case origin

  init(rarity: String) {
    self = switch rarity.uppercased() {
    case "AGENT": .agent
    case "DAEMON": .daemon
    case "ORACLE": .oracle
    case "ARCHITECT": .architect
    case "ORIGIN": .origin
    default: .process
    }
  }

  var particleCount: Int {
    switch self {
    case .process, .agent: 0
    case .daemon: 4
    case .oracle: 6
    case .architect: 8
    case .origin: 12
    }
  }

  var animates: Bool { rawValue >= Self.daemon.rawValue }

  var label: String {
    switch self {
    case .process: "PROCESS"
    case .agent: "AGENT"
    case .daemon: "DAEMON"
    case .oracle: "ORACLE"
    case .architect: "ARCHITECT"
    case .origin: "ORIGIN"
    }
  }
}

struct RarityGuideRow: Equatable, Identifiable {
  let tier: RarityVisualTier
  let ownedCount: Int
  let discoveredCount: Int
  let catalogCount: Int
  let pullCandidateCount: Int
  let pullCandidateTotal: Int
  let finalPotentialLineageCount: Int
  let finalPotentialLineageTotal: Int

  var id: RarityVisualTier { tier }

  var pullProbability: Double {
    guard pullCandidateTotal > 0 else { return 0 }
    return Double(pullCandidateCount) / Double(pullCandidateTotal) * 100
  }

  var pullProbabilityLabel: String {
    guard pullCandidateTotal > 0 else { return "—" }
    guard pullCandidateCount > 0 else { return "0% · 진화 전용" }
    let percent = pullProbability
    return percent.rounded() == percent
      ? "\(Int(percent))%"
      : String(format: "%.1f%%", percent)
  }

  var finalPotentialProbability: Double {
    guard finalPotentialLineageTotal > 0 else { return 0 }
    return Double(finalPotentialLineageCount) / Double(finalPotentialLineageTotal) * 100
  }

  var finalPotentialProbabilityLabel: String {
    guard finalPotentialLineageTotal > 0 else { return "—" }
    let percent = finalPotentialProbability
    return percent.rounded() == percent
      ? "\(Int(percent))%"
      : String(format: "%.1f%%", percent)
  }
}

enum RarityGuidePresentation {
  static func rows(state: GameState, catalog: [CreatureSpecies]) -> [RarityGuideRow] {
    var catalogCounts: [RarityVisualTier: Int] = [:]
    var discoveredCounts: [RarityVisualTier: Int] = [:]
    var pullCandidateCounts: [RarityVisualTier: Int] = [:]
    var finalPotentialLineageCounts: [RarityVisualTier: Int] = [:]
    var speciesByID: [String: CreatureSpecies] = [:]

    for species in catalog {
      let tier = RarityVisualTier(rarity: species.rarity)
      speciesByID[species.id] = species
      catalogCounts[tier, default: 0] += 1
      if state.discoveredSpeciesIDs.contains(species.id) {
        discoveredCounts[tier, default: 0] += 1
      }
      if species.category == "start", species.stage == 1 {
        pullCandidateCounts[tier, default: 0] += 1
        let finalSpecies = EvolutionCatalog.automaticPath(from: species, in: catalog).last ?? species
        finalPotentialLineageCounts[
          RarityVisualTier(rarity: finalSpecies.rarity), default: 0
        ] += 1
      }
    }

    var ownedCounts: [RarityVisualTier: Int] = [:]
    for creature in state.ownedCreatures {
      guard let species = speciesByID[creature.speciesID] else { continue }
      ownedCounts[RarityVisualTier(rarity: species.rarity), default: 0] += 1
    }

    let pullCandidateTotal = pullCandidateCounts.values.reduce(0, +)
    let finalPotentialLineageTotal = finalPotentialLineageCounts.values.reduce(0, +)
    return RarityVisualTier.allCases.reversed().map { tier in
      RarityGuideRow(
        tier: tier,
        ownedCount: ownedCounts[tier, default: 0],
        discoveredCount: discoveredCounts[tier, default: 0],
        catalogCount: catalogCounts[tier, default: 0],
        pullCandidateCount: pullCandidateCounts[tier, default: 0],
        pullCandidateTotal: pullCandidateTotal,
        finalPotentialLineageCount: finalPotentialLineageCounts[tier, default: 0],
        finalPotentialLineageTotal: finalPotentialLineageTotal
      )
    }
  }
}

struct ActionAvailability: Equatable {
  let isEnabled: Bool
  let explanation: String
}

struct EvolutionMilestone: Equatable, Identifiable {
  let stage: Int
  let level: Int
  var id: Int { stage }

  static let all = [
    Self(stage: 2, level: 15),
    Self(stage: 3, level: 25),
    Self(stage: 4, level: 40),
  ]
}

struct EvolutionDexEntry: Equatable, Identifiable {
  let species: CreatureSpecies
  let parentNames: [String]
  let isCurrent: Bool
  let isDiscovered: Bool
  let isAutomaticPath: Bool

  var id: String { species.id }

  var categoryLabel: String {
    if isAutomaticPath && species.category != "start" { return "자동 진화" }
    return switch species.category {
    case "start": "시작"
    case "normal_evolution": "기본"
    case "branch": "분기"
    case "mixed": "혼합"
    case "special": "특수"
    case "mutant": "변이"
    default: species.category
    }
  }

  var relationshipLabel: String {
    let discovery = isDiscovered ? "발견" : "미발견"
    guard !parentNames.isEmpty else { return discovery }
    return "← \(parentNames.joined(separator: " + ")) · \(discovery)"
  }
}

struct EvolutionDexStage: Equatable, Identifiable {
  let stage: Int
  let requiredLevel: Int?
  let entries: [EvolutionDexEntry]

  var id: Int { stage }
}

struct EvolutionPotentialPresentation: Equatable {
  let currentSpecies: CreatureSpecies
  let finalSpecies: CreatureSpecies
  let path: [CreatureSpecies]

  var currentRarityLabel: String { "현재 \(currentSpecies.rarity)" }
  var finalRarityLabel: String { "성장 잠재력 \(finalSpecies.rarity)" }
  var finalSpeciesName: String { finalSpecies.koName }
  var pathLabel: String { path.map(\.koName).joined(separator: " → ") }
  var reachesOrigin: Bool { finalSpecies.rarity.uppercased() == "ORIGIN" }

  static func make(
    for creature: OwnedCreature?,
    catalog: [CreatureSpecies]
  ) -> Self? {
    guard let creature,
          let currentSpecies = catalog.first(where: { $0.id == creature.speciesID })
    else { return nil }
    return make(currentSpecies: currentSpecies, catalog: catalog)
  }

  static func make(
    from species: CreatureSpecies,
    catalog: [CreatureSpecies]
  ) -> Self {
    make(currentSpecies: species, catalog: catalog)
  }

  private static func make(
    currentSpecies: CreatureSpecies,
    catalog: [CreatureSpecies]
  ) -> Self {
    let path = EvolutionCatalog.automaticPath(from: currentSpecies, in: catalog)
    return Self(
      currentSpecies: currentSpecies,
      finalSpecies: path.last ?? currentSpecies,
      path: path
    )
  }
}

struct EvolutionDexPresentation: Equatable {
  let rootSpecies: CreatureSpecies
  let currentSpecies: CreatureSpecies
  let currentLevel: Int
  let stages: [EvolutionDexStage]
  let potential: EvolutionPotentialPresentation

  static func make(
    creature: OwnedCreature?,
    catalog: [CreatureSpecies],
    discoveredSpeciesIDs: Set<String>
  ) -> Self? {
    guard let creature,
          let currentSpecies = catalog.first(where: { $0.id == creature.speciesID })
    else { return nil }

    guard let potential = EvolutionPotentialPresentation.make(for: creature, catalog: catalog)
    else { return nil }
    let rootID = GameEngine.originSpeciesID(for: creature, catalog: catalog)
    let rootSpecies = catalog.first(where: { $0.id == rootID }) ?? currentSpecies
    var reachableByStage: [Int: [CreatureSpecies]] = [rootSpecies.stage: [rootSpecies]]
    var frontier = [rootSpecies]
    var visited: Set<String> = [rootSpecies.id]

    while !frontier.isEmpty {
      var nextByID: [String: CreatureSpecies] = [:]
      for parent in frontier {
        for candidate in EvolutionCatalog.candidates(after: parent, in: catalog) {
          guard visited.insert(candidate.id).inserted else { continue }
          nextByID[candidate.id] = candidate
        }
      }
      let next = nextByID.values.sorted { $0.id < $1.id }
      for species in next {
        reachableByStage[species.stage, default: []].append(species)
      }
      frontier = next
    }

    let automaticPathIDs = Set(potential.path.map(\.id))

    let stages = reachableByStage.keys.sorted().map { stage in
      EvolutionDexStage(
        stage: stage,
        requiredLevel: EvolutionCatalog.requiredLevel(for: stage),
        entries: (reachableByStage[stage] ?? []).map { species in
          EvolutionDexEntry(
            species: species,
            parentNames: EvolutionCatalog.parents(of: species, in: catalog).map(\.koName),
            isCurrent: species.id == currentSpecies.id,
            isDiscovered: discoveredSpeciesIDs.contains(species.id),
            isAutomaticPath: automaticPathIDs.contains(species.id)
          )
        }
      )
    }

    return Self(
      rootSpecies: rootSpecies,
      currentSpecies: currentSpecies,
      currentLevel: creature.level,
      stages: stages,
      potential: potential
    )
  }
}

struct CompactViewState: Equatable {
  let balance: Int
  let weeklyClaude: Int
  let weeklyCodex: Int
  let positionLabel: String?
  let showsNavigation: Bool
  let isRepresentative: Bool
  let feed: ActionAvailability
  let feedLarge: ActionAvailability
  let purchaseFood: ActionAvailability
  let purchaseLargeFood: ActionAvailability
  let pull: ActionAvailability

  init(
    state: GameState,
    currentCreature: OwnedCreature?,
    currentPosition: Int?,
    visibleCreatureCount: Int? = nil,
    isRepresentative representativeOverride: Bool? = nil,
    catalogIsEmpty: Bool,
    weeklyUsage: [TokenProvider: Int]
  ) {
    balance = state.tokenBalance
    weeklyClaude = weeklyUsage[.claude, default: 0]
    weeklyCodex = weeklyUsage[.codex, default: 0]
    let navigationCount = visibleCreatureCount ?? state.ownedCreatures.count
    showsNavigation = navigationCount > 1
    positionLabel = currentPosition.map { "\($0) / \(navigationCount)" }
    isRepresentative = representativeOverride
      ?? (currentCreature?.id == state.representativeCreatureID)
    if currentCreature == nil {
      feed = ActionAvailability(isEnabled: false, explanation: "먼저 가챠로 크리처를 만나세요.")
      feedLarge = ActionAvailability(isEnabled: false, explanation: "먼저 크리처를 만나세요.")
    } else if state.inventory.food == 0 {
      feed = ActionAvailability(isEnabled: false, explanation: "먹이가 없습니다. 아래에서 구매하세요.")
      feedLarge = state.inventory.largeFood == 0
        ? ActionAvailability(isEnabled: false, explanation: "대형 먹이가 없습니다.")
        : ActionAvailability(isEnabled: true, explanation: "대형 1개 · XP +200 · 친밀도 +10")
    } else {
      feed = ActionAvailability(isEnabled: true, explanation: "먹이 1개 · XP +25 · 친밀도 +3")
      feedLarge = state.inventory.largeFood == 0
        ? ActionAvailability(isEnabled: false, explanation: "대형 먹이가 없습니다.")
        : ActionAvailability(isEnabled: true, explanation: "대형 1개 · XP +200 · 친밀도 +10")
    }
    if state.inventory.food == Int.max {
      purchaseFood = ActionAvailability(
        isEnabled: false,
        explanation: "먹이 보유 한도에 도달했습니다."
      )
    } else if state.tokenBalance < GameState.foodCost {
      purchaseFood = ActionAvailability(
        isEnabled: false,
        explanation: "\((GameState.foodCost - state.tokenBalance).formatted()) 토큰이 더 필요합니다."
      )
    } else {
      purchaseFood = ActionAvailability(
        isEnabled: true,
        explanation: "\(GameState.foodCost.formatted()) 토큰 · 먹이 +1"
      )
    }
    if state.inventory.largeFood == Int.max {
      purchaseLargeFood = ActionAvailability(isEnabled: false, explanation: "대형 먹이 보유 한도입니다.")
    } else if state.tokenBalance < GameState.largeFoodCost {
      purchaseLargeFood = ActionAvailability(
        isEnabled: false,
        explanation: "\((GameState.largeFoodCost - state.tokenBalance).formatted()) 토큰이 더 필요합니다."
      )
    } else {
      purchaseLargeFood = ActionAvailability(
        isEnabled: true,
        explanation: "\(GameState.largeFoodCost.formatted()) 토큰 · 대형 +1"
      )
    }
    if catalogIsEmpty {
      pull = ActionAvailability(isEnabled: false, explanation: "크리처 카탈로그를 불러오지 못했습니다.")
    } else if state.tokenBalance < GameState.gachaCost {
      pull = ActionAvailability(
        isEnabled: false,
        explanation: "\((GameState.gachaCost - state.tokenBalance).formatted()) 토큰이 더 필요합니다."
      )
    } else {
      pull = ActionAvailability(
        isEnabled: true, explanation: "1회 \(GameState.gachaCost.formatted()) 토큰")
    }
  }
}

struct MenuBarStatusPresentation: Equatable {
  let weeklyTotal: Int
  let claudePercent: Int
  let codexPercent: Int
  let claudeProgressPercent: Int?
  let codexProgressPercent: Int?

  init(
    weeklyUsage: [TokenProvider: Int],
    quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot] = [:]
  ) {
    let claude = max(0, weeklyUsage[.claude, default: 0])
    let codex = max(0, weeklyUsage[.codex, default: 0])
    let (sum, overflow) = claude.addingReportingOverflow(codex)
    weeklyTotal = overflow ? Int.max : sum
    claudeProgressPercent = quotaSnapshots[.claude].map { Int($0.usedPercent.rounded()) }
    codexProgressPercent = quotaSnapshots[.codex].map { Int($0.usedPercent.rounded()) }

    guard weeklyTotal > 0 else {
      claudePercent = 0
      codexPercent = 0
      return
    }
    claudePercent = Int((Double(claude) / Double(weeklyTotal) * 100).rounded())
    codexPercent = 100 - claudePercent
  }

  var compactWeeklyTotal: String {
    Self.compactNumber(weeklyTotal)
  }

  var accessibilityLabel: String {
    "PunchGrow, Claude 주간 \(percentText(claudeProgressPercent)), Codex 주간 \(percentText(codexProgressPercent))"
  }

  private func percentText(_ value: Int?) -> String { value.map { "\($0)퍼센트" } ?? "확인 대기" }

  private static func compactNumber(_ value: Int) -> String {
    let magnitude: Double
    let suffix: String
    switch value {
    case 1_000_000_000...:
      magnitude = Double(value) / 1_000_000_000
      suffix = "B"
    case 1_000_000...:
      magnitude = Double(value) / 1_000_000
      suffix = "M"
    case 1_000...:
      magnitude = Double(value) / 1_000
      suffix = "K"
    default:
      return value.formatted()
    }
    let precision = magnitude.rounded() == magnitude ? 0 : 1
    return String(
      format: "%.*f%@", locale: Locale(identifier: "en_US_POSIX"),
      precision, magnitude, suffix)
  }
}

struct WeeklyProviderUsage: Equatable {
  let input: Int
  let cached: Int
  let output: Int
  let lastReceivedAt: Date?

  static func currentWeek(
    for provider: TokenProvider,
    in state: GameState,
    now: Date = .now,
    calendar: Calendar = .current
  ) -> Self {
    guard let interval = calendar.dateInterval(of: .weekOfYear, for: now) else {
      return Self(input: 0, cached: 0, output: 0, lastReceivedAt: nil)
    }
    return state.usageEvents.reduce(
      into: Self(input: 0, cached: 0, output: 0, lastReceivedAt: nil)
    ) { result, event in
      guard event.provider == provider, interval.contains(event.occurredAt) else { return }
      result = Self(
        input: result.input + event.inputTokens,
        cached: result.cached + event.cachedTokens,
        output: result.output + event.outputTokens,
        lastReceivedAt: max(result.lastReceivedAt ?? event.occurredAt, event.occurredAt)
      )
    }
  }
}

struct IntegrationStatusPresentation: Equatable {
  let label: String
  let detail: String
  let symbol: String

  init(_ status: IntegrationStatus, provider: TokenProvider) {
    switch status {
    case .stopped:
      label = "중지됨"
      detail = "현재 토큰을 수집하지 않습니다."
      symbol = "pause.circle.fill"
    case .listening:
      label = "로그 감시 중"
      detail = provider == .claude
        ? "~/.claude/projects에서 새 사용량을 감시하고 있습니다."
        : "~/.codex/sessions에서 새 사용량을 감시하고 있습니다."
      symbol = "dot.radiowaves.left.and.right"
    case .recentlyReceiving:
      label = "방금 수신"
      detail = "최근 토큰 사용량을 반영했습니다."
      symbol = "waveform.badge.plus"
    case .error(let message):
      label = "확인 필요"
      detail = message
      symbol = "exclamationmark.triangle.fill"
    }
  }
}

enum OriginRevealPath: CaseIterable, Equatable {
  case normal
  case reducedMotion
  case skipped

  var completedPhase: OriginRevealPhase { .revealed }
}

enum OriginRevealPhase: Equatable {
  case gathering
  case revealed
}

enum CollectionSearch {
  static func results(
    catalog: [CreatureSpecies], discoveredSpeciesIDs: Set<String>, query: String
  ) -> [CreatureSpecies] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return catalog }
    return catalog.filter { species in
      guard discoveredSpeciesIDs.contains(species.id) else { return false }
      return species.id.localizedCaseInsensitiveContains(trimmed)
        || species.koName.localizedCaseInsensitiveContains(trimmed)
        || species.enName.localizedCaseInsensitiveContains(trimmed)
    }
  }
}

private enum PunchGrowColors {
  static let void = Color(red: 7 / 255, green: 6 / 255, blue: 13 / 255)
  static let surface = Color(red: 18 / 255, green: 14 / 255, blue: 29 / 255)
  static let raised = Color(red: 31 / 255, green: 23 / 255, blue: 47 / 255)
  static let line = Color.white.opacity(0.10)
  static let fuel = Color(red: 198 / 255, green: 248 / 255, blue: 78 / 255)
  static let calm = Color(red: 77 / 255, green: 225 / 255, blue: 1)
  static let rival = Color(red: 1, green: 77 / 255, blue: 157 / 255)
  static let myth = Color(red: 165 / 255, green: 115 / 255, blue: 1)
  static let warning = Color(red: 1, green: 184 / 255, blue: 77 / 255)
}

private struct RarityVisualStyle {
  let tier: RarityVisualTier

  init(_ rarity: String) {
    tier = RarityVisualTier(rarity: rarity)
  }

  var primary: Color {
    switch tier {
    case .process: Color(red: 154 / 255, green: 166 / 255, blue: 184 / 255)
    case .agent: PunchGrowColors.calm
    case .daemon: Color(red: 154 / 255, green: 105 / 255, blue: 1)
    case .oracle: Color(red: 1, green: 76 / 255, blue: 190 / 255)
    case .architect: Color(red: 1, green: 190 / 255, blue: 70 / 255)
    case .origin: Color(red: 198 / 255, green: 248 / 255, blue: 78 / 255)
    }
  }

  var secondary: Color {
    switch tier {
    case .process: Color.white.opacity(0.55)
    case .agent: Color(red: 63 / 255, green: 130 / 255, blue: 1)
    case .daemon: Color(red: 80 / 255, green: 54 / 255, blue: 1)
    case .oracle: Color(red: 1, green: 126 / 255, blue: 70 / 255)
    case .architect: Color(red: 1, green: 105 / 255, blue: 35 / 255)
    case .origin: PunchGrowColors.calm
    }
  }

  var glowOpacity: Double { 0.12 + Double(tier.rawValue) * 0.055 }

  var gradientColors: [Color] {
    switch tier {
    case .architect:
      [primary, Color(red: 1, green: 244 / 255, blue: 180 / 255), secondary]
    case .origin:
      [primary, PunchGrowColors.calm, Color(red: 183 / 255, green: 95 / 255, blue: 1)]
    default:
      [primary, secondary]
    }
  }
}

private func integrationStatusColor(for status: IntegrationStatus, tint: Color) -> Color {
  switch status {
  case .stopped: .secondary
  case .listening: tint
  case .recentlyReceiving: PunchGrowColors.fuel
  case .error: .red
  }
}

private enum CreatureAssetLocator {
  static func imageURL(for species: CreatureSpecies) -> URL? {
    let configuredName = URL(fileURLWithPath: species.imagePath)
      .deletingPathExtension()
      .lastPathComponent
    let resourceNames = configuredName.isEmpty || configuredName == species.id
      ? [species.id]
      : [configuredName, species.id]

    for name in resourceNames {
      if let url = Bundle.module.url(forResource: name, withExtension: "png")
        ?? Bundle.module.url(forResource: name, withExtension: "png", subdirectory: "Creatures")
      {
        return url
      }
    }
    return nil
  }
}

struct MenuBarStatusLabel: View {
  @ObservedObject var store: GameStore

  private var representativeSpecies: CreatureSpecies? {
    guard let creature = store.representativeCreature else { return store.currentSpecies }
    return store.catalog.first(where: { $0.id == creature.speciesID }) ?? store.currentSpecies
  }

  private var weeklyUsage: [TokenProvider: Int] {
    store.observedLocalWeeklyUsage
  }

  private var presentation: MenuBarStatusPresentation {
    MenuBarStatusPresentation(
      weeklyUsage: weeklyUsage,
      quotaSnapshots: store.observedQuotaSnapshots
    )
  }

  private var creatureImage: NSImage? {
    guard let species = representativeSpecies else { return nil }
    return CreatureAssetLocator.imageURL(for: species)
      .flatMap { CreatureImageCache.shared.thumbnail(for: $0, points: 18) }
  }

  var body: some View {
    Image(
      nsImage: MenuBarHUDRenderer.render(
        creature: creatureImage,
        claudeProgressPercent: presentation.claudeProgressPercent,
        codexProgressPercent: presentation.codexProgressPercent
      )
    )
    .renderingMode(.original)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.accessibilityLabel)
    .help("Claude \(percentLabel(presentation.claudeProgressPercent)) · Codex \(percentLabel(presentation.codexProgressPercent)) · 실제 플랜 주간 한도")
  }

  private func percentLabel(_ value: Int?) -> String { value.map { "\($0)%" } ?? "확인 대기" }
}

private enum MenuBarHUDRenderer {
  static let size = NSSize(width: 116, height: 22)

  static func render(
    creature: NSImage?, claudeProgressPercent: Int?, codexProgressPercent: Int?
  ) -> NSImage {
    let image = NSImage(size: size, flipped: false) { bounds in
      drawCreature(creature, in: NSRect(x: 0, y: 2, width: 18, height: 18))
      drawText(
        claudeProgressPercent.map { "C \($0)%" } ?? "C —",
        at: NSPoint(x: 23, y: 4),
        font: .monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold),
        color: NSColor(red: 77 / 255, green: 225 / 255, blue: 1, alpha: 1)
      )
      drawText(
        codexProgressPercent.map { "X \($0)%" } ?? "X —",
        at: NSPoint(x: 72, y: 4),
        font: .monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold),
        color: NSColor(red: 1, green: 77 / 255, blue: 157 / 255, alpha: 1)
      )
      return !bounds.isEmpty
    }
    image.isTemplate = false
    return image
  }

  private static func drawCreature(_ creature: NSImage?, in rect: NSRect) {
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(ovalIn: rect).addClip()
    if let creature {
      creature.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    } else {
      NSColor.windowBackgroundColor.setFill()
      rect.fill()
      let fallback = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
      fallback?.draw(in: rect.insetBy(dx: 2, dy: 2), from: .zero, operation: .sourceOver, fraction: 1)
    }
    NSGraphicsContext.restoreGraphicsState()
    NSColor(red: 198 / 255, green: 248 / 255, blue: 78 / 255, alpha: 0.9).setStroke()
    let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 0.75, dy: 0.75))
    ring.lineWidth = 1.25
    ring.stroke()
  }

  @discardableResult
  private static func drawText(
    _ text: String, at point: NSPoint, font: NSFont, color: NSColor
  ) -> CGFloat {
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    (text as NSString).draw(
      at: point,
      withAttributes: attributes
    )
    return (text as NSString).size(withAttributes: attributes).width
  }

}

enum MenuPopoverLayout {
  static let width: CGFloat = 398
  static let height: CGFloat = 670
  static let dockHeight: CGFloat = 54
  static let dockButtonHeight: CGFloat = 44
}

struct MenuPopoverView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var integrationStatus: IntegrationStatusProjection
  @ObservedObject var originReveal: OriginRevealCoordinator
  @ObservedObject var mainNavigation: MainWindowNavigation
  @Environment(\.openWindow) private var openWindow
  @State private var pullFeedback: PullFeedback?
  @State private var showsRarityGuide = false
  @State private var showsEvolutionGuide = false

  private var weeklyUsage: [TokenProvider: Int] {
    if !store.observedLocalWeeklyUsage.isEmpty { return store.observedLocalWeeklyUsage }
    return GameEngine.weeklyUsage(from: store.state)
  }
  private var presentation: CompactViewState {
    CompactViewState(
      state: store.state,
      currentCreature: store.currentCreature,
      currentPosition: store.currentCreaturePosition,
      visibleCreatureCount: store.currentCreatureCount,
      isRepresentative: store.currentCreature?.id == store.representativeCreature?.id,
      catalogIsEmpty: store.catalog.isEmpty,
      weeklyUsage: weeklyUsage
    )
  }
  private var evolutionPotential: EvolutionPotentialPresentation? {
    EvolutionPotentialPresentation.make(for: store.currentCreature, catalog: store.catalog)
  }

  var body: some View {
    ZStack {
      DigitalMythBackground()
      VStack(spacing: 0) {
        ScrollView(.vertical) {
          compactContent
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .frame(
          height: MenuPopoverLayout.height - MenuPopoverLayout.dockHeight,
          alignment: .top
        )
        VStack(spacing: 0) {
          footer
            .frame(height: MenuPopoverLayout.dockButtonHeight)
          Color.clear.frame(height: 6)
        }
          .padding(.top, 4)
          .padding(.horizontal, 14)
          .frame(height: MenuPopoverLayout.dockHeight, alignment: .top)
          .background(PunchGrowColors.void.opacity(0.96))
          .overlay(alignment: .top) {
            Divider().overlay(Color.white.opacity(0.12))
          }
          .zIndex(10)
      }
    }
    .frame(width: MenuPopoverLayout.width, height: MenuPopoverLayout.height)
    .preferredColorScheme(.dark)
    .overlay(alignment: .top) {
      if let message = store.errorMessage {
        Label(message, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.red)
          .lineLimit(2)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color.red.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
          .padding(12)
          .help(message)
      } else if let evolutionFeedback = store.evolutionFeedback {
        EvolutionResultToast(feedback: evolutionFeedback)
          .padding(12)
          .transition(.move(edge: .top).combined(with: .opacity))
      } else if let pullFeedback {
        PullResultToast(feedback: pullFeedback)
          .padding(12)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .task(id: store.evolutionFeedback?.id) {
      guard let id = store.evolutionFeedback?.id else { return }
      try? await Task.sleep(for: .seconds(2.8))
      guard !Task.isCancelled else { return }
      withAnimation { store.clearEvolutionFeedback(id: id) }
    }
  }

  private var compactContent: some View {
    VStack(alignment: .leading, spacing: 2) {
      header
      CreatureHero(
        store: store,
        presentation: presentation,
        potential: evolutionPotential
      )
      WeeklyUsageCard(
        state: store.state,
        usage: weeklyUsage,
        localBreakdown: store.observedLocalWeeklyBreakdown,
        quotaSnapshots: store.observedQuotaSnapshots
      )
      connectionStrip
      actionRow
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        Text("PUNCHGROW").font(.headline.weight(.black)).tracking(2.2)
        Text("DIGITAL FAMILIAR SYSTEM").font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.secondary)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 2) {
        Text("TOKEN BALANCE").font(.system(size: 10, weight: .semibold, design: .monospaced))
          .foregroundStyle(.secondary)
        Text(presentation.balance.formatted()).font(.title3.monospacedDigit().weight(.bold))
          .foregroundStyle(PunchGrowColors.fuel)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("보유 토큰 \(presentation.balance)")
    }
  }

  private var connectionStrip: some View {
    HStack(spacing: 8) {
      IntegrationBadge(
        name: "Claude", provider: .claude, status: integrationStatus.status(for: .claude),
        lastReceivedAt: latestUsageDate(for: .claude), tint: PunchGrowColors.calm)
      IntegrationBadge(
        name: "Codex", provider: .codex, status: integrationStatus.status(for: .codex),
        lastReceivedAt: latestUsageDate(for: .codex), tint: PunchGrowColors.rival)
    }
  }

  private var actionRow: some View {
    VStack(spacing: 6) {
      HStack(spacing: 8) {
      ActionButton(
        title: "일반 먹이",
        symbol: "carrot.fill",
        tint: PunchGrowColors.fuel,
        usesDarkForeground: true,
        availability: presentation.feed,
        repeatAction: {
          guard store.currentCreature != nil, store.state.inventory.food > 0 else { return false }
          store.feedCurrent()
          return true
        },
        showsExplanation: false
      ) { store.feedCurrent() }
      ActionButton(
        title: "대형 먹이",
        symbol: "takeoutbag.and.cup.and.straw.fill",
        tint: PunchGrowColors.myth,
        usesDarkForeground: false,
        availability: presentation.feedLarge,
        repeatAction: {
          guard store.currentCreature != nil, store.state.inventory.largeFood > 0 else { return false }
          store.feedLargeCurrent()
          return true
        },
        showsExplanation: false
      ) { store.feedLargeCurrent() }
      ActionButton(
        title: "가챠",
        symbol: "sparkles",
        tint: PunchGrowColors.rival,
        usesDarkForeground: false,
        availability: presentation.pull,
        showsExplanation: false
      ) { performPull() }
      }
      HStack(spacing: 8) {
      ActionButton(
        title: "일반 구매 · 100K",
        symbol: "cart.badge.plus",
        tint: PunchGrowColors.warning,
        usesDarkForeground: true,
        availability: presentation.purchaseFood,
        repeatAction: {
          guard store.state.tokenBalance >= GameState.foodCost,
                store.state.inventory.food < Int.max else { return false }
          store.purchaseFood()
          return true
        },
        showsExplanation: false
      ) { store.purchaseFood() }
      ActionButton(
        title: "대형 구매 · 500K",
        symbol: "cart.fill.badge.plus",
        tint: PunchGrowColors.warning,
        usesDarkForeground: true,
        availability: presentation.purchaseLargeFood,
        repeatAction: {
          guard store.state.tokenBalance >= GameState.largeFoodCost,
                store.state.inventory.largeFood < Int.max else { return false }
          store.purchaseLargeFood()
          return true
        },
        showsExplanation: false
      ) { store.purchaseLargeFood() }
      }
    }
  }

  private var footer: some View {
    HStack(spacing: 6) {
      ForEach(MenuDockItem.allCases) { item in
        dockButton(for: item)
      }
    }
  }

  @ViewBuilder
  private func dockButton(for item: MenuDockItem) -> some View {
    switch item {
    case .collection, .settings:
      FooterDockButton(
        title: item.title,
        symbol: item.symbol,
        tint: PunchGrowColors.calm,
        isSelected: false
      ) {
        guard let command = mainNavigation.command(for: item) else { return }
        openWindow(id: command.windowID)
        NSApp.activate(ignoringOtherApps: true)
      }
      .help("\(item.title) 화면 열기")
    case .rarity:
      FooterDockButton(
        title: item.title,
        symbol: item.symbol,
        tint: PunchGrowColors.warning,
        isSelected: showsRarityGuide
      ) {
        showsEvolutionGuide = false
        showsRarityGuide.toggle()
      }
      .popover(isPresented: $showsRarityGuide, arrowEdge: .bottom) {
        RarityGuidePopover(
          rows: RarityGuidePresentation.rows(state: store.state, catalog: store.catalog)
        )
      }
      .help("등급별 가챠 확률과 크리처 수 보기")
    case .evolution:
      FooterDockButton(
        title: item.title,
        symbol: item.symbol,
        tint: PunchGrowColors.myth,
        isSelected: showsEvolutionGuide
      ) {
        showsRarityGuide = false
        showsEvolutionGuide.toggle()
      }
      .popover(isPresented: $showsEvolutionGuide, arrowEdge: .bottom) {
        EvolutionGuidePopover(
          presentation: EvolutionDexPresentation.make(
            creature: store.currentCreature,
            catalog: store.catalog,
            discoveredSpeciesIDs: store.state.discoveredSpeciesIDs
          )
        )
      }
      .help("현재 크리처의 진화도감 보기")
    case .quit:
      FooterDockButton(
        title: item.title,
        symbol: item.symbol,
        tint: PunchGrowColors.rival,
        isSelected: false
      ) {
        NSApplication.shared.terminate(nil)
      }
      .help("PunchGrow 종료")
    }
  }

  private func performPull() {
    guard let creature = store.pull(),
          let species = store.catalog.first(where: { $0.id == creature.speciesID }) else { return }
    let potential = EvolutionPotentialPresentation.make(from: species, catalog: store.catalog)
    let tier = RarityFeedbackTier(rarity: species.rarity)
    if tier == .origin {
      if let outcome = originReveal.requestReveal(for: creature, species: species) {
        openWindow(id: outcome.windowCommand.windowID)
        NSApp.activate(ignoringOtherApps: true)
      }
    } else {
      withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
        pullFeedback = PullFeedback(
          name: species.koName,
          currentRarity: species.rarity,
          potentialRarity: potential.finalSpecies.rarity,
          potentialSpeciesName: potential.finalSpeciesName,
          kind: potential.reachesOrigin ? .originLineage : .ordinary,
          tier: tier
        )
      }
      guard let feedback = pullFeedback else { return }
      announcePullFeedback(feedback)
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(2.4))
        guard pullFeedback?.id == feedback.id else { return }
        withAnimation { pullFeedback = nil }
      }
    }
  }

  private func announcePullFeedback(_ feedback: PullFeedback) {
    let announcement = feedback.kind == .originLineage
      ? "ORIGIN 계보 발견. \(feedback.name), 현재 \(feedback.currentRarity), 성장 잠재력 ORIGIN"
      : "새 크리처 획득. \(feedback.name), 현재 \(feedback.currentRarity), 성장 잠재력 \(feedback.potentialRarity)"
    NSAccessibility.post(
      element: NSApplication.shared,
      notification: .announcementRequested,
      userInfo:
      [
        .announcement: announcement,
        .priority: NSAccessibilityPriorityLevel.high.rawValue,
      ]
    )
  }

  private func latestUsageDate(for provider: TokenProvider) -> Date? {
    store.state.usageEvents.lazy
      .filter { $0.provider == provider }
      .map(\.occurredAt)
      .max()
  }
}

private struct WeeklyUsageCard: View {
  let state: GameState
  let usage: [TokenProvider: Int]
  let localBreakdown: [TokenProvider: LocalUsageCounts]
  let quotaSnapshots: [TokenProvider: ProviderQuotaSnapshot]
  @State private var selectedProvider: TokenProvider = .claude
  private var claude: Int { usage[.claude, default: 0] }
  private var codex: Int { usage[.codex, default: 0] }
  private var total: Int { claude + codex }
  private var selectedUsage: LocalUsageCounts {
    if let observed = localBreakdown[selectedProvider] { return observed }
    let persisted = WeeklyProviderUsage.currentWeek(for: selectedProvider, in: state)
    return LocalUsageCounts(
      inputTokens: persisted.input,
      cachedTokens: persisted.cached,
      outputTokens: persisted.output
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("주간 사용률").font(.system(size: 12, weight: .bold)).tracking(0.2)
          .foregroundStyle(.secondary)
        Spacer()
        HStack(spacing: 5) {
          Text("보유 토큰")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
          Text(state.tokenBalance.formatted())
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(PunchGrowColors.fuel)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("보유 토큰 \(state.tokenBalance)")
      }
      VStack(spacing: 5) {
        providerProgressButton(.claude, name: "Claude", value: claude, color: PunchGrowColors.calm)
        providerProgressButton(.codex, name: "Codex", value: codex, color: PunchGrowColors.rival)
      }
      if total == 0, state.tokenBalance > 0 {
        Text("보유 토큰에는 시작 보너스가 포함됩니다. 위 사용률은 이번 주에 실제로 측정된 Claude/Codex 토큰만 보여줘요.")
          .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      } else {
        HStack(spacing: 7) {
          usageMetric("INPUT", value: selectedUsage.inputTokens)
          usageMetric("CACHE", value: selectedUsage.cachedTokens)
          usageMetric("OUTPUT", value: selectedUsage.outputTokens)
        }
      }
    }
    .panelStyle()
  }

  private func providerProgressButton(
    _ provider: TokenProvider, name: String, value: Int, color: Color
  ) -> some View {
    let percent = quotaSnapshots[provider].map { Int($0.usedPercent.rounded()) }
    let progress = Double(percent ?? 0) / 100
    return Button {
      selectedProvider = provider
    } label: {
      VStack(spacing: 3) {
        HStack(spacing: 6) {
          Circle().fill(color).frame(width: 6, height: 6)
          Text(name)
          Spacer(minLength: 3)
          Text(percent.map { "\($0)%" } ?? "확인 대기").monospacedDigit().foregroundStyle(color)
          Text("· \(value.formatted())").monospacedDigit().foregroundStyle(.secondary)
            .lineLimit(1).minimumScaleFactor(0.75)
        }
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.07))
            Capsule().fill(color).frame(width: proxy.size.width * progress)
          }
        }
        .frame(height: 5)
      }
      .font(.system(size: 11, weight: .semibold))
      .padding(.horizontal, 9).padding(.vertical, 2)
      .frame(maxWidth: .infinity)
      .background(
        selectedProvider == provider ? color.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 9)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 9).stroke(
          selectedProvider == provider ? color.opacity(0.75) : PunchGrowColors.line)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(name) 이번 주 사용률 \(percent.map(String.init) ?? "확인 대기"), 로컬 토큰 \(value)")
    .accessibilityAddTraits(selectedProvider == provider ? .isSelected : [])
  }

  private func usageMetric(_ label: String, value: Int) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.system(size: 9.5, weight: .bold, design: .monospaced))
        .foregroundStyle(.secondary)
      Text(value.formatted()).font(.system(size: 11, weight: .semibold, design: .monospaced))
        .lineLimit(1).minimumScaleFactor(0.7)
    }
    .padding(.horizontal, 8).padding(.vertical, 3)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PunchGrowColors.void.opacity(0.62), in: RoundedRectangle(cornerRadius: 8))
  }

  private func segmentWidth(_ value: Int, total: Int, available: CGFloat) -> CGFloat {
    guard total > 0 else { return 0 }
    return available * CGFloat(value) / CGFloat(total)
  }
}

private struct IntegrationBadge: View {
  let name: String
  let provider: TokenProvider
  let status: IntegrationStatus
  let lastReceivedAt: Date?
  let tint: Color
  private var presentation: IntegrationStatusPresentation {
    IntegrationStatusPresentation(status, provider: provider)
  }

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: presentation.symbol)
        .foregroundStyle(statusColor)
      VStack(alignment: .leading, spacing: 1) {
        Text(name).font(.caption.weight(.semibold))
        Group {
          if let lastReceivedAt {
            Text(presentation.label) + Text(" · ") + Text(lastReceivedAt, style: .relative)
          } else {
            Text(presentation.label)
          }
        }
        .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10).padding(.vertical, 6)
    .frame(maxWidth: .infinity)
    .background(PunchGrowColors.surface.opacity(0.8), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(PunchGrowColors.line))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilitySummary)
    .help(presentation.detail)
  }

  private var statusColor: Color {
    integrationStatusColor(for: status, tint: tint)
  }

  private var accessibilitySummary: String {
    guard let lastReceivedAt else {
      return "\(name), \(presentation.label). \(presentation.detail)"
    }
    return "\(name), \(presentation.label). 마지막 수신 \(lastReceivedAt.formatted()). \(presentation.detail)"
  }
}

private struct CreatureHero: View {
  @ObservedObject var store: GameStore
  let presentation: CompactViewState
  let potential: EvolutionPotentialPresentation?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var rarityStyle: RarityVisualStyle {
    RarityVisualStyle(store.currentSpecies?.rarity ?? "PROCESS")
  }

  var body: some View {
    VStack(spacing: 4) {
      HStack {
        if presentation.showsNavigation {
          navigationButton("chevron.left", label: "이전 크리처") { store.selectPreviousCreature() }
        }
        Spacer()
        if let label = presentation.positionLabel {
          Text(label).font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(.secondary)
        }
        Spacer()
        if presentation.showsNavigation {
          navigationButton("chevron.right", label: "다음 크리처") { store.selectNextCreature() }
        }
      }
      .frame(height: 22)

      ZStack {
        RarityAura(style: rarityStyle, reduceMotion: reduceMotion)
        RoundedRectangle(cornerRadius: 18)
          .fill(
            LinearGradient(
              colors: rarityStyle.gradientColors.map { $0.opacity(0.16) },
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
          )
          .frame(width: 108, height: 108)
        RoundedRectangle(cornerRadius: 18)
          .stroke(
            LinearGradient(
              colors: rarityStyle.gradientColors,
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            lineWidth: rarityStyle.tier.rawValue >= RarityVisualTier.oracle.rawValue ? 2 : 1
          )
          .frame(width: 106, height: 106)
        CreatureArtwork(species: store.currentSpecies, size: 104)
          .clipShape(RoundedRectangle(cornerRadius: 14))
      }

      VStack(spacing: 4) {
        HStack(spacing: 7) {
          Text(store.currentSpecies?.koName ?? "아직 깨어난 크리처가 없어요")
            .font(.title2.weight(.bold))
            .lineLimit(1)
            .minimumScaleFactor(0.78)
          if let rarity = store.currentSpecies?.rarity {
            Text("현재 \(rarity)")
              .rarityBadge(rarity)
              .accessibilityLabel("현재 등급 \(rarity)")
          }
        }
        if let potential {
          GrowthPotentialBadge(potential: potential)
        }
        if let creature = store.currentCreature {
          HStack(spacing: 7) {
            if presentation.isRepresentative {
              Label("대표", systemImage: "crown.fill").foregroundStyle(PunchGrowColors.warning)
            } else {
              Button("대표로 지정") { store.setCurrentAsRepresentative() }
                .buttonStyle(.plain).foregroundStyle(PunchGrowColors.calm)
            }
            if creature.uniqueColor { Text("UNIQUE COLOR").foregroundStyle(PunchGrowColors.rival) }
          }
          .font(.caption.weight(.semibold))
        } else {
          Text("가챠로 첫 디지털 동료를 만나보세요.").font(.caption).foregroundStyle(.secondary)
        }
      }

      if let creature = store.currentCreature {
        let isMaximumLevel = creature.level >= GameState.maximumCreatureLevel
        VStack(spacing: 4) {
          ProgressMetric(
            label: isMaximumLevel ? "LV. \(creature.level) · MAX" : "LV. \(creature.level) · XP",
            value: isMaximumLevel ? 1 : creature.experience,
            maximum: isMaximumLevel ? 1 : max(1, creature.level * 100),
            tint: PunchGrowColors.fuel
          )
          ProgressMetric(
            label: "친밀도", value: creature.affection, maximum: 100, tint: PunchGrowColors.rival)
          HStack {
            Label("보유 \(store.state.ownedCreatures.count)", systemImage: "pawprint.fill")
            Spacer()
            Label(
              "도감 \(store.state.discoveredSpeciesIDs.count)/\(store.catalog.count)",
              systemImage: "books.vertical.fill")
          }
          .font(.caption2).foregroundStyle(.secondary)
        }
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 4)
    .background(PunchGrowColors.raised.opacity(0.76), in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).stroke(PunchGrowColors.myth.opacity(0.25)))
  }

  private func navigationButton(_ symbol: String, label: String, action: @escaping () -> Void)
    -> some View
  {
    Button(action: action) {
      Image(systemName: symbol).font(.caption.weight(.bold)).frame(width: 25, height: 25)
        .background(Color.white.opacity(0.08), in: Circle())
    }
    .buttonStyle(.plain).accessibilityLabel(label)
  }
}

private struct GrowthPotentialBadge: View {
  let potential: EvolutionPotentialPresentation

  private var style: RarityVisualStyle {
    RarityVisualStyle(potential.finalSpecies.rarity)
  }

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "sparkles")
        .foregroundStyle(PunchGrowColors.fuel)
      Text("성장 잠재력")
        .foregroundStyle(PunchGrowColors.fuel)
      Text(potential.finalSpecies.rarity)
        .font(.system(size: 10.5, weight: .black, design: .monospaced))
        .foregroundStyle(style.primary)
    }
    .font(.system(size: 10.5, weight: .semibold))
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(
      LinearGradient(
        colors: [PunchGrowColors.fuel.opacity(0.12), style.primary.opacity(0.1)],
        startPoint: .leading,
        endPoint: .trailing
      ),
      in: Capsule()
    )
    .overlay(
      Capsule().stroke(
        LinearGradient(
          colors: [PunchGrowColors.fuel.opacity(0.58), style.primary.opacity(0.52)],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
    )
    .lineLimit(1)
    .accessibilityLabel(
      "성장 잠재력 \(potential.finalSpecies.rarity), 자동 진화 최종 \(potential.finalSpeciesName)"
    )
    .help(potential.pathLabel)
  }
}

private struct RarityAura: View {
  let style: RarityVisualStyle
  let reduceMotion: Bool
  @State private var active = false

  var body: some View {
    ZStack {
      Circle()
        .fill(
          RadialGradient(
            colors: [style.primary.opacity(style.glowOpacity), .clear],
            center: .center,
            startRadius: 18,
            endRadius: 95
          )
        )
        .frame(width: 132, height: 132)
        .scaleEffect(reduceMotion ? 1 : (active ? 1.05 : 0.97))

      if style.tier.rawValue >= RarityVisualTier.oracle.rawValue {
        Circle()
          .stroke(
            AngularGradient(
              colors: style.gradientColors + [style.primary.opacity(0.15), style.primary],
              center: .center
            ),
            style: StrokeStyle(lineWidth: 1.5, dash: [5, 8])
          )
          .frame(width: 126, height: 126)
          .rotationEffect(.degrees(active ? 360 : 0))
      }

      ForEach(0..<style.tier.particleCount, id: \.self) { index in
        Circle()
          .fill(style.gradientColors[index % style.gradientColors.count])
          .frame(width: particleSize(index), height: particleSize(index))
          .offset(particleOffset(index))
          .opacity(reduceMotion ? 0.72 : (active ? 0.9 : 0.48))
      }
    }
    .animation(
      reduceMotion || !style.tier.animates
        ? nil
        : .easeInOut(duration: 2.8).repeatForever(autoreverses: true),
      value: active
    )
    .onAppear { active = !reduceMotion && style.tier.animates }
    .onChange(of: style.tier) { _, newTier in
      active = !reduceMotion && newTier.animates
    }
    .accessibilityHidden(true)
  }

  private func particleSize(_ index: Int) -> CGFloat {
    CGFloat(2 + index % 3)
  }

  private func particleOffset(_ index: Int) -> CGSize {
    let angle = Double(index) / Double(max(1, style.tier.particleCount)) * .pi * 2
    let radius = 55 + Double(index % 2) * 6
    return CGSize(width: cos(angle) * radius, height: sin(angle) * radius)
  }
}

private struct ProgressMetric: View {
  let label: String
  let value: Int
  let maximum: Int
  let tint: Color

  var body: some View {
    VStack(spacing: 4) {
      HStack {
        Text(label).font(.caption.weight(.semibold))
        Spacer()
        Text("\(value) / \(maximum)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
      }
      ProgressView(value: min(Double(value), Double(maximum)), total: Double(maximum)).tint(tint)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label), \(value) / \(maximum)")
  }
}

private struct FooterDockButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 3) {
        Image(systemName: symbol)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(isSelected ? Color.white : Color.white.opacity(0.68))
          .lineLimit(1)
          .minimumScaleFactor(0.9)
      }
      .frame(maxWidth: .infinity, minHeight: MenuPopoverLayout.dockButtonHeight)
      .background(
        isSelected ? tint.opacity(0.14) : Color.white.opacity(0.035),
        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .stroke(isSelected ? tint.opacity(0.48) : Color.white.opacity(0.08), lineWidth: 1)
      )
      .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityValue(isSelected ? "선택됨" : "")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

private struct ActionButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let usesDarkForeground: Bool
  let availability: ActionAvailability
  let repeatAction: (() -> Bool)?
  let showsExplanation: Bool
  let action: () -> Void
  @State private var repeatTask: Task<Void, Never>?
  @State private var repeatedDuringPress = false

  init(
    title: String,
    symbol: String,
    tint: Color,
    usesDarkForeground: Bool,
    availability: ActionAvailability,
    repeatAction: (() -> Bool)? = nil,
    showsExplanation: Bool = true,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.usesDarkForeground = usesDarkForeground
    self.availability = availability
    self.repeatAction = repeatAction
    self.showsExplanation = showsExplanation
    self.action = action
  }

  var body: some View {
    VStack(spacing: 5) {
      Button(action: performSingleAction) {
        Label(title, systemImage: symbol).font(.callout.weight(.bold)).frame(maxWidth: .infinity)
          .padding(.vertical, 6)
      }
      .buttonStyle(
        RepeatPressButtonStyle(
          tint: tint,
          foreground: usesDarkForeground ? .black : .white,
          onPressChanged: handlePressChanged
        )
      )
      .disabled(!availability.isEnabled)
      if showsExplanation {
        Text(availability.explanation).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity, minHeight: 14, alignment: .top)
      }
    }
    .help(repeatAction == nil ? availability.explanation : "\(availability.explanation) · 길게 눌러 연속 실행")
    .onDisappear { stopRepeating() }
  }

  private func performSingleAction() {
    guard !repeatedDuringPress else {
      repeatedDuringPress = false
      return
    }
    action()
  }

  private func startRepeatingIfNeeded() {
    guard repeatTask == nil, availability.isEnabled, let repeatAction else { return }
    repeatedDuringPress = false
    repeatTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(360))
      guard !Task.isCancelled else { return }
      var delay = 110
      while repeatAction() {
        repeatedDuringPress = true
        try? await Task.sleep(for: .milliseconds(delay))
        guard !Task.isCancelled else { return }
        delay = max(45, delay - 8)
      }
      repeatTask = nil
    }
  }

  private func stopRepeating() {
    repeatTask?.cancel()
    repeatTask = nil
  }

  private func handlePressChanged(_ isPressed: Bool) {
    if isPressed {
      startRepeatingIfNeeded()
    } else {
      stopRepeating()
    }
  }
}

private struct RepeatPressButtonStyle: ButtonStyle {
  let tint: Color
  let foreground: Color
  let onPressChanged: (Bool) -> Void

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(foreground)
      .background(
        tint.opacity(configuration.isPressed ? 0.72 : 1),
        in: RoundedRectangle(cornerRadius: 7)
      )
      .scaleEffect(configuration.isPressed ? 0.975 : 1)
      .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
      .onChange(of: configuration.isPressed) { _, isPressed in
        onPressChanged(isPressed)
      }
  }
}

struct EvolutionGuidePopover: View {
  let presentation: EvolutionDexPresentation?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text("EVOLUTION DEX").font(.headline.weight(.black)).tracking(1.2)
        Text("선택한 크리처의 전체 단계와 분기를 직접 확인합니다")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if let presentation {
        HStack(spacing: 7) {
          Text("현재 \(presentation.currentSpecies.rarity)")
            .rarityBadge(presentation.currentSpecies.rarity)
          Image(systemName: "arrow.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.secondary)
          GrowthPotentialBadge(potential: presentation.potential)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
          "현재 등급 \(presentation.currentSpecies.rarity), \(presentation.potential.finalRarityLabel)"
        )

        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(presentation.stages) { stage in
              evolutionStage(stage)
            }
          }
        }
        .scrollIndicators(.visible)
        .frame(maxHeight: 470)

        Divider()
        HStack(spacing: 8) {
          Label(
            "현재 \(presentation.currentSpecies.koName) · Lv.\(presentation.currentLevel) · STAGE \(presentation.currentSpecies.stage)",
            systemImage: "pawprint.fill"
          )
          Spacer(minLength: 4)
          Label("스크롤", systemImage: "arrow.up.and.down")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(PunchGrowColors.calm)
        Text("자동 경로는 현재 게임 규칙이 선택하는 진화입니다. Lv.15·25·40 기준을 충족하면 다음 단계로 진화하며 만렙은 Lv.50입니다.")
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        ContentUnavailableView(
          "확인할 크리처가 없습니다",
          systemImage: "pawprint",
          description: Text("먼저 가챠로 크리처를 만나세요.")
        )
        .frame(maxWidth: .infinity, minHeight: 180)
      }
    }
    .padding(16)
    .frame(width: 372)
    .background(DigitalMythBackground())
    .preferredColorScheme(.dark)
  }

  private func evolutionStage(_ stage: EvolutionDexStage) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text("STAGE \(stage.stage)")
          .font(.system(size: 11, weight: .black, design: .monospaced))
          .tracking(0.8)
        Spacer()
        Text(stage.requiredLevel.map { "Lv.\($0)" } ?? "START")
          .font(.caption.monospacedDigit().weight(.bold))
          .foregroundStyle(stage.requiredLevel == nil ? PunchGrowColors.calm : .secondary)
      }

      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible())],
        spacing: 8
      ) {
        ForEach(stage.entries) { entry in
          evolutionCard(entry)
        }
      }
    }
  }

  private func evolutionCard(_ entry: EvolutionDexEntry) -> some View {
    let style = RarityVisualStyle(entry.species.rarity)
    return VStack(spacing: 3) {
      ZStack(alignment: .top) {
        CreatureArtwork(species: entry.species, size: 60)
          .clipShape(RoundedRectangle(cornerRadius: 9))
        HStack(spacing: 4) {
          if entry.isAutomaticPath {
            Text("AUTO")
              .font(.system(size: 8, weight: .black, design: .monospaced))
              .foregroundStyle(.black)
              .padding(.horizontal, 5).padding(.vertical, 2)
              .background(style.primary, in: Capsule())
          }
          Spacer()
          if entry.isCurrent {
            Text("현재")
              .font(.system(size: 8, weight: .black))
              .foregroundStyle(.black)
              .padding(.horizontal, 5).padding(.vertical, 2)
              .background(PunchGrowColors.fuel, in: Capsule())
          }
        }
        .padding(4)
      }
      Text(entry.species.koName)
        .font(.callout.weight(.bold))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      HStack(spacing: 5) {
        Text(entry.species.rarity).rarityBadge(entry.species.rarity)
        Text(entry.categoryLabel)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      HStack(spacing: 4) {
        Image(systemName: entry.isDiscovered ? "checkmark.circle.fill" : "circle.dashed")
        Text(entry.relationshipLabel)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      .font(.caption2.weight(.semibold))
      .foregroundStyle(entry.isAutomaticPath ? style.primary : .secondary)
    }
    .padding(6)
    .frame(maxWidth: .infinity)
    .background(
      entry.isCurrent ? style.primary.opacity(0.16) : Color.white.opacity(0.04),
      in: RoundedRectangle(cornerRadius: 12)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .stroke(entry.isCurrent ? style.primary.opacity(0.85) : style.primary.opacity(0.18))
    )
    .overlay(alignment: .leading) {
      if entry.isAutomaticPath {
        Capsule()
          .fill(style.primary)
          .frame(width: 3)
          .padding(.vertical, 7)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(entry.species.koName), \(entry.species.rarity), \(entry.categoryLabel), \(entry.relationshipLabel)\(entry.isCurrent ? ", 현재 크리처" : "")\(entry.isAutomaticPath ? ", 자동 진화 경로" : "")"
    )
  }
}

struct RarityGuidePopover: View {
  let rows: [RarityGuideRow]

  private var processRow: RarityGuideRow? { rows.first { $0.tier == .process } }
  private var originRow: RarityGuideRow? { rows.first { $0.tier == .origin } }

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      VStack(alignment: .leading, spacing: 3) {
        Text("RARITY INDEX").font(.headline.weight(.black)).tracking(1.2)
        Text("직접 획득 등급과 자동 진화 잠재력을 구분합니다")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 8) {
        summaryCard(
          title: "직접 획득",
          value: "PROCESS \(processRow?.pullProbabilityLabel ?? "—")",
          symbol: "shippingbox.fill",
          rarity: "PROCESS"
        )
        summaryCard(
          title: "ORIGIN 계보",
          value: originSummary,
          symbol: "sparkles",
          rarity: "ORIGIN"
        )
      }

      VStack(spacing: 6) {
        ForEach(rows) { row in
          rarityRow(row)
        }
      }

      Divider()
      Text("ORIGIN 계보 확률은 ORIGIN 직접 획득 확률이 아닙니다. 모든 가챠 결과는 PROCESS이며 Lv.15·25·40 자동 진화로 최종 잠재 등급에 도달합니다.")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(15)
    .frame(width: 360)
    .background(DigitalMythBackground())
    .preferredColorScheme(.dark)
  }

  private var originSummary: String {
    guard let row = originRow, row.finalPotentialLineageTotal > 0 else { return "—" }
    return "\(row.finalPotentialProbabilityLabel) · \(row.finalPotentialLineageCount)/\(row.finalPotentialLineageTotal)"
  }

  private func summaryCard(
    title: String,
    value: String,
    symbol: String,
    rarity: String
  ) -> some View {
    let style = RarityVisualStyle(rarity)
    return VStack(alignment: .leading, spacing: 4) {
      Label(title, systemImage: symbol)
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.system(size: 12, weight: .black, design: .monospaced))
        .foregroundStyle(style.primary)
        .lineLimit(1)
        .minimumScaleFactor(0.82)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(style.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(style.primary.opacity(0.28)))
    .accessibilityElement(children: .combine)
  }

  private func rarityRow(_ row: RarityGuideRow) -> some View {
    let style = RarityVisualStyle(row.tier.label)
    return VStack(spacing: 4) {
      HStack(spacing: 9) {
        Circle()
          .fill(style.primary)
          .frame(width: 8, height: 8)
          .shadow(color: style.primary.opacity(0.65), radius: 5)
        Text(row.tier.label)
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(style.primary)
        Spacer(minLength: 4)
        Text("직접 \(row.pullProbabilityLabel)")
          .font(.system(size: 10.5, weight: .bold, design: .monospaced))
      }
      HStack(spacing: 6) {
        Text(
          "최종 잠재 \(row.finalPotentialProbabilityLabel) · \(row.finalPotentialLineageCount)/\(row.finalPotentialLineageTotal)"
        )
        Spacer(minLength: 4)
        Text("보유 \(row.ownedCount) · 도감 \(row.discoveredCount)/\(row.catalogCount)")
      }
      .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(style.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(style.primary.opacity(0.22)))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(row.tier.label), 직접 획득 \(row.pullProbabilityLabel), 최종 성장 잠재력 \(row.finalPotentialProbabilityLabel), \(row.finalPotentialLineageCount) 계보 중 \(row.finalPotentialLineageTotal), 보유 \(row.ownedCount), 도감 \(row.discoveredCount) 중 \(row.catalogCount)"
    )
  }
}

private struct EvolutionResultToast: View {
  let feedback: EvolutionFeedback

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.up.forward.circle.fill")
        .foregroundStyle(PunchGrowColors.fuel)
      VStack(alignment: .leading, spacing: 1) {
        Text(feedback.stagesCrossed > 1 ? "MULTI EVOLUTION" : "EVOLUTION COMPLETE")
          .font(.system(size: 9, weight: .bold, design: .monospaced))
          .foregroundStyle(.secondary)
        Text("\(feedback.fromName) → \(feedback.toName)")
          .font(.callout.weight(.bold))
        if feedback.stagesCrossed > 1 {
          Text("\(feedback.stagesCrossed)단계 연속 진화")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(PunchGrowColors.fuel)
        }
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().stroke(PunchGrowColors.fuel, lineWidth: 1))
    .shadow(color: PunchGrowColors.fuel.opacity(0.35), radius: 16)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "진화 완료, \(feedback.fromName)에서 \(feedback.toName), \(feedback.stagesCrossed)단계 진화")
  }
}

private enum PullFeedbackKind: Equatable {
  case ordinary
  case originLineage
}

private struct PullFeedback: Equatable, Identifiable {
  let id = UUID()
  let name: String
  let currentRarity: String
  let potentialRarity: String
  let potentialSpeciesName: String
  let kind: PullFeedbackKind
  let tier: RarityFeedbackTier
}

private struct PullResultToast: View {
  let feedback: PullFeedback
  @State private var animate = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var style: RarityVisualStyle {
    RarityVisualStyle(feedback.potentialRarity)
  }

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: feedback.kind == .originLineage ? "sparkles" : "seal.fill")
        .foregroundStyle(style.primary)
        .scaleEffect(animate ? 1.14 : 1)
      VStack(alignment: .leading, spacing: 2) {
        Text(feedback.kind == .originLineage ? "ORIGIN 계보 발견!" : "새 크리처 획득")
          .font(.system(size: 10, weight: .black, design: .monospaced))
          .foregroundStyle(feedback.kind == .originLineage ? style.primary : .secondary)
        Text("\(feedback.name) · 현재 \(feedback.currentRarity)")
          .font(.callout.weight(.bold))
        Text("성장 잠재력 \(feedback.potentialRarity) · 자동 진화")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(style.primary)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .frame(maxWidth: MenuPopoverLayout.width - 24, alignment: .leading)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14).stroke(
        style.primary, lineWidth: feedback.kind == .originLineage ? 1.5 : 1
      )
    )
    .shadow(color: style.primary.opacity(0.35), radius: 16)
    .help("자동 진화 최종: \(feedback.potentialSpeciesName)")
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      feedback.kind == .originLineage
        ? "ORIGIN 계보 발견, \(feedback.name), 현재 등급 \(feedback.currentRarity), 성장 잠재력 ORIGIN, 자동 진화 최종 \(feedback.potentialSpeciesName)"
        : "새 크리처 획득, \(feedback.name), 현재 등급 \(feedback.currentRarity), 성장 잠재력 \(feedback.potentialRarity), 자동 진화 최종 \(feedback.potentialSpeciesName)"
    )
    .onAppear {
      guard !reduceMotion else { return }
      if feedback.kind == .originLineage {
        withAnimation(.easeInOut(duration: 0.38).repeatCount(1, autoreverses: true)) {
          animate = true
        }
        return
      }
      switch feedback.tier {
      case .pulse:
        withAnimation(.easeInOut(duration: 0.35).repeatCount(1, autoreverses: true)) {
          animate = true
        }
      case .burst:
        withAnimation(.spring(response: 0.28, dampingFraction: 0.45)) { animate = true }
      case .staticAccent, .origin:
        break
      }
    }
  }
}

enum MainDestination: String, CaseIterable, Identifiable {
  case collection
  case connections
  case settings
  var id: Self { self }
  var title: String {
    switch self {
    case .collection: "Collection"
    case .connections: "Connections"
    case .settings: "Data & Settings"
    }
  }
  var symbol: String {
    switch self {
    case .collection: "square.grid.2x2.fill"
    case .connections: "point.3.connected.trianglepath.dotted"
    case .settings: "externaldrive.fill.badge.gearshape"
    }
  }
}

enum MenuDockItem: String, CaseIterable, Identifiable {
  case collection
  case rarity
  case evolution
  case settings
  case quit

  var id: Self { self }

  var title: String {
    switch self {
    case .collection: "도감"
    case .rarity: "등급표"
    case .evolution: "진화"
    case .settings: "설정"
    case .quit: "종료"
    }
  }

  var symbol: String {
    switch self {
    case .collection: "books.vertical.fill"
    case .rarity: "chart.bar.fill"
    case .evolution: "arrow.up.forward.circle.fill"
    case .settings: "gearshape.fill"
    case .quit: "power"
    }
  }

  var destination: MainDestination? {
    switch self {
    case .collection: .collection
    case .settings: .settings
    case .rarity, .evolution, .quit: nil
    }
  }
}

struct MainWindowCommand: Equatable {
  let windowID: String
  let destination: MainDestination
}

@MainActor
final class MainWindowNavigation: ObservableObject {
  @Published var destination: MainDestination? = .collection

  func command(for item: MenuDockItem) -> MainWindowCommand? {
    guard let destination = item.destination else { return nil }
    self.destination = destination
    return MainWindowCommand(windowID: "main", destination: destination)
  }
}

struct MainWindowView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var localUsage: LocalUsageService
  @ObservedObject var integrationStatus: IntegrationStatusProjection
  @ObservedObject var navigation: MainWindowNavigation

  var body: some View {
    NavigationSplitView {
      List(MainDestination.allCases, selection: $navigation.destination) { item in
        NavigationLink(value: item) { Label(item.title, systemImage: item.symbol) }
      }
      .navigationTitle("PUNCHGROW")
      .safeAreaInset(edge: .bottom) {
        VStack(alignment: .leading, spacing: 5) {
          Text("COMING LATER").font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.secondary)
          Text("상점과 상세 통계는 다음 단계에서 열립니다.").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
      }
    } detail: {
      Group {
        switch navigation.destination ?? .collection {
        case .collection: CollectionView(store: store)
        case .connections:
          ConnectionsView(
            store: store, localUsage: localUsage, integrationStatus: integrationStatus)
        case .settings: DataSettingsView(store: store)
        }
      }
      .background(DigitalMythBackground())
    }
    .preferredColorScheme(.dark)
    .frame(minWidth: 900, minHeight: 640)
  }
}

private struct CollectionView: View {
  @ObservedObject var store: GameStore
  @State private var search = ""

  private var filteredCatalog: [CreatureSpecies] {
    CollectionSearch.results(
      catalog: store.catalog,
      discoveredSpeciesIDs: store.state.discoveredSpeciesIDs,
      query: search
    )
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        WindowHeader(
          eyebrow: "FAMILIAR ARCHIVE",
          title: "Collection",
          subtitle: "발견한 크리처의 기록과 보유 현황을 확인합니다."
        )
        HStack(spacing: 10) {
          MetricTile(
            label: "DISCOVERED",
            value: "\(store.state.discoveredSpeciesIDs.count) / \(store.catalog.count)",
            tint: PunchGrowColors.calm)
          MetricTile(
            label: "OWNED", value: store.state.ownedCreatures.count.formatted(),
            tint: PunchGrowColors.fuel)
          MetricTile(
            label: "FOOD", value: store.state.inventory.food.formatted(),
            tint: PunchGrowColors.rival)
        }
        LazyVGrid(
          columns: [GridItem(.adaptive(minimum: 170, maximum: 220), spacing: 12)], spacing: 12
        ) {
          ForEach(filteredCatalog) { species in
            CollectionCard(
              species: species, discovered: store.state.discoveredSpeciesIDs.contains(species.id))
          }
        }
      }
      .padding(24)
    }
    .searchable(text: $search, prompt: "발견한 이름 또는 ID 검색")
    .navigationTitle("Collection")
  }
}

private struct CollectionCard: View {
  let species: CreatureSpecies
  let discovered: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.035)).frame(height: 142)
        if discovered {
          CreatureArtwork(species: species, size: 132)
        } else {
          LockedCreatureSilhouette()
        }
      }
      Text(discovered ? species.koName : "미발견 개체").font(.headline)
      HStack {
        Text(discovered ? species.id : "PG-???")
        Spacer()
        Text(discovered ? species.rarity : "LOCKED")
      }
      .font(.caption.monospaced()).foregroundStyle(.secondary)
    }
    .padding(12)
    .background(PunchGrowColors.surface.opacity(0.84), in: RoundedRectangle(cornerRadius: 16))
    .overlay(
      RoundedRectangle(cornerRadius: 16).stroke(
        discovered ? PunchGrowColors.line : Color.white.opacity(0.05))
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(discovered ? "\(species.koName), \(species.rarity)" : "잠긴 미발견 크리처")
  }
}

private struct LockedCreatureSilhouette: View {
  var body: some View {
    ZStack {
      Circle().fill(Color.black.opacity(0.55)).frame(width: 94, height: 94)
      Image(systemName: "questionmark").font(.system(size: 44, weight: .black)).foregroundStyle(
        Color.white.opacity(0.12))
      Image(systemName: "lock.fill").font(.caption).padding(7).background(
        .black.opacity(0.7), in: Circle()
      ).offset(x: 42, y: 42)
    }
  }
}

private struct ConnectionsView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var localUsage: LocalUsageService
  @ObservedObject var integrationStatus: IntegrationStatusProjection

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        WindowHeader(
          eyebrow: "LOCAL SIGNAL BRIDGE",
          title: "Connections",
          subtitle: "동의한 경우에만 이 Mac의 Claude Code·Codex 사용량 로그를 자동으로 확인합니다."
        )
        SettingsPanel(title: "자동 로컬 수집", symbol: "waveform.path.ecg") {
          Text("PunchGrow는 10초마다 ~/.claude/projects와 ~/.codex/sessions의 변경분을 확인합니다. 프롬프트, 응답, 소스코드, 프로젝트명과 절대 경로는 저장하지 않습니다.")
            .font(.callout).foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Button(localUsage.collectionEnabled ? "수집 중지" : "수집 동의 및 시작") {
              localUsage.collectionEnabled ? localUsage.stop() : localUsage.start()
            }
            .accessibilityHint(
              localUsage.collectionEnabled
                ? "자동 로컬 사용량 확인을 중지합니다."
                : "로컬 로그에서 토큰 수치만 확인하는 데 동의하고 수집을 시작합니다."
            )
            Button("연결 해제 및 캐시 삭제", role: .destructive) {
              localUsage.disconnect()
            }
            .accessibilityHint("수집을 중지하고 PunchGrow의 로컬 증분 캐시를 삭제합니다. 원본 로그는 삭제하지 않습니다.")
          }
          Label(
            localUsage.isRunning ? "자동 수집기 실행 중" : "자동 수집기 중지됨",
            systemImage: localUsage.isRunning ? "checkmark.circle.fill" : "pause.circle.fill"
          )
          .font(.caption.weight(.semibold))
          .foregroundStyle(localUsage.isRunning ? PunchGrowColors.fuel : .secondary)
          if let lastScanAt = localUsage.lastScanAt {
            Text("최근 확인: \(lastScanAt.formatted(date: .abbreviated, time: .standard))")
              .font(.caption.monospaced()).foregroundStyle(.secondary)
          }
          if let error = localUsage.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle.fill")
              .font(.caption).foregroundStyle(PunchGrowColors.warning)
              .accessibilityLabel("자동 수집 확인 필요. \(error)")
          }
        }
        IntegrationPanel(
          name: "Claude Code",
          provider: .claude,
          subtitle: "~/.claude/projects 자동 탐색",
          status: integrationStatus.status(for: .claude),
          tint: PunchGrowColors.calm
        ) {
          Text("Claude Code가 만든 assistant usage 수치만 읽습니다. 기존 기록은 금주 통계의 기준선으로만 표시하고, 동의 이후 새 증가분만 토큰 잔액에 반영합니다.")
            .font(.callout).foregroundStyle(.secondary)
        }
        IntegrationPanel(
          name: "Codex",
          provider: .codex,
          subtitle: "~/.codex/sessions 자동 탐색",
          status: integrationStatus.status(for: .codex),
          tint: PunchGrowColors.rival
        ) {
          Text("Codex 세션의 token_count 수치만 읽으며 캐시 입력을 분리하고 fork replay를 억제합니다. PunchGrow가 Codex를 실행하거나 요청 내용을 받지 않습니다.")
            .font(.callout).foregroundStyle(.secondary)
        }
        Text("진단 전용: 기존 OpenTelemetry 수신기와 PunchGrow 관리형 Codex 기능은 자동 수집의 적립 경로가 아니며 이 화면에서 실행하지 않습니다.")
          .font(.caption).foregroundStyle(.secondary)
        #if DEBUG
          Button("테스트용 Claude 사용량 추가") { store.addDemoUsage() }.font(.caption)
        #endif
      }
      .padding(24).frame(maxWidth: 820, alignment: .leading)
    }
    .navigationTitle("Connections")
  }

}

private struct IntegrationPanel<Content: View>: View {
  let name: String
  let provider: TokenProvider
  let subtitle: String
  let status: IntegrationStatus
  let tint: Color
  let content: Content
  private var presentation: IntegrationStatusPresentation {
    IntegrationStatusPresentation(status, provider: provider)
  }

  init(
    name: String,
    provider: TokenProvider,
    subtitle: String,
    status: IntegrationStatus,
    tint: Color,
    @ViewBuilder content: () -> Content
  ) {
    self.name = name
    self.provider = provider
    self.subtitle = subtitle
    self.status = status
    self.tint = tint
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(name).font(.title3.weight(.bold))
          Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Label(presentation.label, systemImage: presentation.symbol)
          .font(.caption.weight(.semibold)).foregroundStyle(statusColor)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(statusColor.opacity(0.11), in: Capsule())
      }
      Divider().overlay(PunchGrowColors.line)
      content
    }
    .padding(18)
    .background(PunchGrowColors.surface.opacity(0.88), in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).stroke(tint.opacity(0.24)))
    .accessibilityHint(presentation.detail)
  }

  private var statusColor: Color {
    integrationStatusColor(for: status, tint: tint)
  }
}

private struct DataSettingsView: View {
  @ObservedObject var store: GameStore
  @State private var reduceEffects = UserDefaults.standard.bool(forKey: "reduceEffects")
  @State private var notifications =
    UserDefaults.standard.object(forKey: "notifications") as? Bool ?? true
  @State private var sound = UserDefaults.standard.object(forKey: "sound") as? Bool ?? true

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        WindowHeader(
          eyebrow: "LOCAL VAULT",
          title: "Data & Settings",
          subtitle: "게임 데이터의 이동과 화면 연출을 관리합니다."
        )
        SettingsPanel(title: "경험 설정", symbol: "slider.horizontal.3") {
          Toggle("알림", isOn: $notifications).onChange(of: notifications) { _, value in
            UserDefaults.standard.set(value, forKey: "notifications")
          }
          Toggle("사운드", isOn: $sound).onChange(of: sound) { _, value in
            UserDefaults.standard.set(value, forKey: "sound")
          }
          Toggle("빛과 움직임 줄이기", isOn: $reduceEffects).onChange(of: reduceEffects) { _, value in
            UserDefaults.standard.set(value, forKey: "reduceEffects")
          }
          Text("시스템의 ‘동작 줄이기’ 설정도 ORIGIN 연출에 자동 반영됩니다.").font(.caption).foregroundStyle(.secondary)
        }
        SettingsPanel(title: "백업과 복원", symbol: "externaldrive.fill") {
          Text("백업에는 크리처, 토큰, 진행도와 사용량 수치가 포함됩니다. 프롬프트와 코드는 포함되지 않습니다.")
            .font(.callout).foregroundStyle(.secondary)
          HStack {
            Button("백업 내보내기", action: exportBackup)
            Button("백업 복원", action: restoreBackup)
          }
        }
        if let message = store.errorMessage {
          Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(
            .caption)
        }
      }
      .padding(24).frame(maxWidth: 760, alignment: .leading)
    }
    .navigationTitle("Data & Settings")
  }

  private func exportBackup() {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "PunchGrow-Backup.pgrow"
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    store.exportBackup(to: url)
  }

  private func restoreBackup() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    store.restoreBackup(from: url)
  }
}

private struct SettingsPanel<Content: View>: View {
  let title: String
  let symbol: String
  let content: Content

  init(title: String, symbol: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.symbol = symbol
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 13) {
      Label(title, systemImage: symbol).font(.headline)
      Divider().overlay(PunchGrowColors.line)
      content
    }
    .padding(18).panelStyle()
  }
}

struct OriginRevealView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var coordinator: OriginRevealCoordinator
  @Environment(\.dismissWindow) private var dismissWindow
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @State private var phase: OriginRevealPhase = .gathering
  @State private var transition: OriginRevealTransitionState?
  @State private var pulse = false

  private var reduceEffects: Bool {
    systemReduceMotion || UserDefaults.standard.bool(forKey: "reduceEffects")
  }

  private var presentation: OriginRevealPresentation? {
    OriginRevealPresentation(
      request: coordinator.currentRequest,
      state: store.state,
      catalog: store.catalog
    )
  }

  var body: some View {
    ZStack {
      DigitalMythBackground()
      ForEach(0..<3, id: \.self) { index in
        Circle().stroke(PunchGrowColors.myth.opacity(0.28 - Double(index) * 0.06), lineWidth: 1)
          .frame(width: CGFloat(300 + index * 90), height: CGFloat(300 + index * 90))
          .scaleEffect(pulse ? 1.04 : 0.96)
      }
      VStack(spacing: 18) {
        Text("ORIGIN SIGNAL").font(.system(size: 13, weight: .black, design: .monospaced)).tracking(
          4
        ).foregroundStyle(PunchGrowColors.warning)
        if phase == .gathering {
          Image(systemName: "diamond.inset.filled").font(.system(size: 88)).foregroundStyle(
            PunchGrowColors.myth
          )
          .shadow(color: PunchGrowColors.myth, radius: 30)
          Text("고대 신호를 복원하는 중…").font(.title2.weight(.semibold))
        } else {
          CreatureArtwork(species: presentation?.species, size: 330)
            .shadow(color: PunchGrowColors.myth.opacity(0.65), radius: 34)
          Text(presentation?.species.koName ?? "ORIGIN").font(.system(size: 38, weight: .black))
          Text(presentation?.species.lore ?? "새로운 기원이 깨어났습니다.")
            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(
              maxWidth: 520)
          Button("기록 완료") { dismissReveal() }
            .buttonStyle(.borderedProminent).tint(PunchGrowColors.warning).foregroundStyle(.black)
        }
      }
      .padding(40)
      if phase == .gathering {
        VStack {
          HStack {
            Spacer()
            Button("연출 건너뛰기") { complete(.skipped) }.buttonStyle(.bordered)
          }
          Spacer()
        }.padding(22)
      }
    }
    .preferredColorScheme(.dark)
    .frame(minWidth: 760, minHeight: 620)
    .task(id: coordinator.currentRequest?.id) {
      phase = .gathering
      pulse = false
      guard let request = presentation?.request else {
        phase = .revealed
        return
      }
      transition = OriginRevealTransitionState(requestID: request.id)
      transition?.begin(reduceMotion: reduceEffects)
      phase = transition?.phase ?? .gathering
      if reduceEffects {
        complete(.reducedMotion)
      } else {
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulse = true }
        do { try await Task.sleep(for: .seconds(1.8)) } catch { return }
        guard !Task.isCancelled, coordinator.currentRequest?.id == request.id else { return }
        complete(.normal)
      }
    }
    .onDisappear {
      if let requestID = coordinator.currentRequest?.id {
        coordinator.windowDidClose(requestID: requestID)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(phase == .revealed ? "ORIGIN 크리처 공개 완료" : "ORIGIN 크리처 공개 중")
  }

  private func complete(_ path: OriginRevealPath) {
    guard phase != path.completedPhase else { return }
    transition?.complete(path)
    if path == .normal {
      withAnimation(.spring(response: 0.7, dampingFraction: 0.8)) {
        phase = transition?.phase ?? path.completedPhase
      }
    } else {
      phase = transition?.phase ?? path.completedPhase
    }
  }

  private func dismissReveal() {
    guard let transition else { return }
    for command in transition.dismiss() {
      switch command {
      case .dismissWindow(let id): dismissWindow(id: id)
      case .openPopup: break
      }
    }
  }
}

private struct WindowHeader: View {
  let eyebrow: String
  let title: String
  let subtitle: String
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(eyebrow).font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(2)
        .foregroundStyle(PunchGrowColors.calm)
      Text(title).font(.largeTitle.weight(.black))
      Text(subtitle).font(.callout).foregroundStyle(.secondary)
    }
  }
}

private struct MetricTile: View {
  let label: String
  let value: String
  let tint: Color
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(
        .secondary)
      Text(value).font(.title2.monospacedDigit().weight(.bold)).foregroundStyle(tint)
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading).panelStyle()
  }
}

private struct CreatureArtwork: View {
  let species: CreatureSpecies?
  let size: CGFloat
  private var imageURL: URL? {
    guard let species else { return nil }
    return CreatureAssetLocator.imageURL(for: species)
  }
  var body: some View {
    Group {
      if let url = imageURL, let image = CreatureImageCache.shared.image(for: url) {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .antialiased(true)
          .scaledToFit()
      } else {
        Image(systemName: "sparkles").resizable().scaledToFit().foregroundStyle(
          PunchGrowColors.calm
        ).padding(size * 0.25)
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(species?.koName ?? "크리처")
  }
}

@MainActor
final class CreatureImageCache {
  static let shared = CreatureImageCache()
  static let countLimit = 48
  static let costLimit = 64 * 1_024 * 1_024

  private let cache = NSCache<NSURL, NSImage>()
  private let thumbnailCache = NSCache<NSString, NSImage>()

  init() {
    cache.countLimit = Self.countLimit
    cache.totalCostLimit = Self.costLimit
  }

  func image(for url: URL) -> NSImage? {
    if let cached = cache.object(forKey: url as NSURL) { return cached }
    guard let image = NSImage(contentsOf: url) else { return nil }
    let pixels = max(1, Int(image.size.width * image.size.height))
    cache.setObject(image, forKey: url as NSURL, cost: pixels * 4)
    return image
  }

  func thumbnail(for url: URL, points: CGFloat) -> NSImage? {
    let key = "\(url.path)#\(points)" as NSString
    if let cached = thumbnailCache.object(forKey: key) { return cached }
    guard let source = image(for: url) else { return nil }

    let targetSize = NSSize(width: points, height: points)
    let thumbnail = NSImage(size: targetSize, flipped: false) { destination in
      let sourceSize = source.size
      guard sourceSize.width > 0, sourceSize.height > 0 else { return false }
      let scale = min(destination.width / sourceSize.width, destination.height / sourceSize.height)
      let drawnSize = NSSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
      let drawnRect = NSRect(
        x: destination.midX - drawnSize.width / 2,
        y: destination.midY - drawnSize.height / 2,
        width: drawnSize.width,
        height: drawnSize.height
      )
      NSGraphicsContext.current?.imageInterpolation = .high
      source.draw(
        in: drawnRect,
        from: NSRect(origin: .zero, size: sourceSize),
        operation: .sourceOver,
        fraction: 1
      )
      return true
    }
    thumbnail.isTemplate = false
    thumbnailCache.setObject(thumbnail, forKey: key)
    return thumbnail
  }
}

private struct DigitalMythBackground: View {
  var body: some View {
    ZStack {
      PunchGrowColors.void
      RadialGradient(
        colors: [PunchGrowColors.myth.opacity(0.18), .clear], center: .topTrailing, startRadius: 10,
        endRadius: 480)
      LinearGradient(
        colors: [.clear, PunchGrowColors.calm.opacity(0.035)], startPoint: .top,
        endPoint: .bottomLeading)
    }
    .ignoresSafeArea()
  }
}

extension View {
  fileprivate func panelStyle() -> some View {
    background(PunchGrowColors.surface.opacity(0.84), in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(PunchGrowColors.line))
  }

  fileprivate func rarityBadge(_ rarity: String) -> some View {
    let style = RarityVisualStyle(rarity)
    return font(.system(size: 10, weight: .black, design: .monospaced))
      .foregroundStyle(style.primary)
      .padding(.horizontal, 8).padding(.vertical, 3)
      .background(
        LinearGradient(
          colors: style.gradientColors.map { $0.opacity(0.22) },
          startPoint: .leading,
          endPoint: .trailing
        ),
        in: Capsule()
      )
      .overlay(Capsule().stroke(style.primary.opacity(0.72), lineWidth: 1))
      .shadow(
        color: style.primary.opacity(style.tier.rawValue >= RarityVisualTier.oracle.rawValue ? 0.45 : 0),
        radius: 6
      )
  }
}
