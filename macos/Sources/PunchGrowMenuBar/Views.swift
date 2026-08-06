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

enum RarityVisualTier: Int, CaseIterable, Equatable {
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
    let url = Bundle.module.url(forResource: species.id, withExtension: "png")
      ?? Bundle.module.url(forResource: species.id, withExtension: "png", subdirectory: "Creatures")
    return url.flatMap { CreatureImageCache.shared.thumbnail(for: $0, points: 18) }
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

struct MenuPopoverView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var integrationStatus: IntegrationStatusProjection
  @ObservedObject var originReveal: OriginRevealCoordinator
  @Environment(\.openWindow) private var openWindow
  @State private var pullFeedback: PullFeedback?
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

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      CreatureHero(store: store, presentation: presentation)
      WeeklyUsageCard(
        state: store.state,
        usage: weeklyUsage,
        localBreakdown: store.observedLocalWeeklyBreakdown,
        quotaSnapshots: store.observedQuotaSnapshots
      )
      connectionStrip
      actionRow
      if let message = store.errorMessage {
        Label(message, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.red)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
      }
      footer
    }
    .padding(.horizontal, 14)
    .padding(.top, 14)
    .padding(.bottom, 26)
    .frame(width: 398, height: 670)
    .background(DigitalMythBackground())
    .preferredColorScheme(.dark)
    .overlay(alignment: .top) {
      if let evolutionFeedback = store.evolutionFeedback {
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
    HStack(spacing: 12) {
      Button {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
      } label: {
        Label("도감 · 연결 · 설정", systemImage: "rectangle.on.rectangle")
      }
      Spacer()
      Button {
        showsEvolutionGuide.toggle()
      } label: {
        Label("진화 단계", systemImage: "arrow.up.forward.circle.fill")
      }
      .popover(isPresented: $showsEvolutionGuide, arrowEdge: .bottom) {
        EvolutionGuidePopover(
          species: store.currentSpecies,
          level: store.currentCreature?.level
        )
      }
      .help("현재 크리처의 진화 레벨 보기")
      Button {
        NSApplication.shared.terminate(nil)
      } label: {
        Image(systemName: "power")
      }
      .help("PunchGrow 종료")
    }
    .buttonStyle(.plain)
    .font(.system(size: 12, weight: .semibold))
    .foregroundStyle(.secondary)
    .padding(.top, 4)
    .padding(.bottom, 6)
    .fixedSize(horizontal: false, vertical: true)
    .layoutPriority(2)
  }

  private func performPull() {
    guard let creature = store.pull(),
          let species = store.catalog.first(where: { $0.id == creature.speciesID }) else { return }
    let tier = RarityFeedbackTier(rarity: species.rarity)
    if tier == .origin {
      if let outcome = originReveal.requestReveal(for: creature, species: species) {
        openWindow(id: outcome.windowCommand.windowID)
        NSApp.activate(ignoringOtherApps: true)
      }
    } else {
      withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
        pullFeedback = PullFeedback(name: species.koName, rarity: species.rarity, tier: tier)
      }
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(2.4))
        withAnimation { pullFeedback = nil }
      }
    }
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
    VStack(alignment: .leading, spacing: 9) {
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
      VStack(spacing: 6) {
        providerProgressButton(.claude, name: "Claude", value: claude, color: PunchGrowColors.calm)
        providerProgressButton(.codex, name: "Codex", value: codex, color: PunchGrowColors.rival)
      }
      HStack(spacing: 7) {
        usageMetric("INPUT", value: selectedUsage.inputTokens)
        usageMetric("CACHE", value: selectedUsage.cachedTokens)
        usageMetric("OUTPUT", value: selectedUsage.outputTokens)
      }
      if total == 0, state.tokenBalance > 0 {
        Text("보유 토큰에는 시작 보너스가 포함됩니다. 위 사용량은 이번 주에 실제로 측정된 Claude/Codex 토큰만 보여줘요.")
          .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
      VStack(spacing: 4) {
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
      .padding(.horizontal, 9).padding(.vertical, 5)
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
    .padding(.horizontal, 8).padding(.vertical, 6)
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
    .padding(.horizontal, 10).padding(.vertical, 8)
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var rarityStyle: RarityVisualStyle {
    RarityVisualStyle(store.currentSpecies?.rarity ?? "PROCESS")
  }

  var body: some View {
    VStack(spacing: 8) {
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
      .frame(height: 26)

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
          .frame(width: 142, height: 142)
        RoundedRectangle(cornerRadius: 18)
          .stroke(
            LinearGradient(
              colors: rarityStyle.gradientColors,
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            lineWidth: rarityStyle.tier.rawValue >= RarityVisualTier.oracle.rawValue ? 2 : 1
          )
          .frame(width: 140, height: 140)
        CreatureArtwork(species: store.currentSpecies, size: 138)
          .clipShape(RoundedRectangle(cornerRadius: 16))
      }

      VStack(spacing: 5) {
        HStack(spacing: 7) {
          Text(store.currentSpecies?.koName ?? "아직 깨어난 크리처가 없어요")
            .font(.title2.weight(.bold))
          if let rarity = store.currentSpecies?.rarity {
            Text(rarity).rarityBadge(rarity)
          }
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
        VStack(spacing: 7) {
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
    .padding(12)
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
        .frame(width: 166, height: 166)
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
          .frame(width: 154, height: 154)
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
    let radius = 70 + Double(index % 2) * 7
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
          .padding(.vertical, 7)
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

private struct EvolutionGuidePopover: View {
  let species: CreatureSpecies?
  let level: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("EVOLUTION PATH").font(.headline.weight(.black)).tracking(1.2)
        Text("계보에 다음 진화체가 있으면 자동으로 진화합니다")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      VStack(spacing: 7) {
        ForEach(EvolutionMilestone.all) { milestone in
          HStack(spacing: 8) {
            Image(systemName: (species?.stage ?? 0) >= milestone.stage
                  ? "checkmark.circle.fill" : "circle")
              .foregroundStyle((species?.stage ?? 0) >= milestone.stage
                ? PunchGrowColors.fuel : .secondary)
            Text("STAGE \(milestone.stage)")
              .font(.callout.monospaced().weight(.bold))
            Spacer()
            Text("Lv.\(milestone.level)")
              .font(.callout.monospacedDigit().weight(.bold))
          }
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        }
      }

      Divider()
      Label(
        "현재 \(species?.koName ?? "크리처 없음") · Lv.\(level ?? 0) · STAGE \(species?.stage ?? 0)",
        systemImage: "pawprint.fill"
      )
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
      Text("Lv.15·25·40은 공통 진화 기준입니다. 계보에 따라 2·3단계에서 완성될 수 있으며, 가챠는 1단계만 등장합니다. 만렙은 Lv.50입니다.")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
    .padding(16)
    .frame(width: 330)
    .background(DigitalMythBackground())
    .preferredColorScheme(.dark)
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

private struct PullFeedback: Equatable {
  let name: String
  let rarity: String
  let tier: RarityFeedbackTier
}

private struct PullResultToast: View {
  let feedback: PullFeedback
  @State private var animate = false

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: feedback.tier == .burst ? "sparkles" : "seal.fill")
        .foregroundStyle(feedback.tier == .burst ? PunchGrowColors.warning : PunchGrowColors.calm)
        .scaleEffect(animate && feedback.tier != .staticAccent ? 1.14 : 1)
      VStack(alignment: .leading, spacing: 1) {
        Text("NEW SIGNAL ACQUIRED").font(.system(size: 9, weight: .bold, design: .monospaced))
          .foregroundStyle(.secondary)
        Text("\(feedback.name) · \(feedback.rarity)").font(.callout.weight(.bold))
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(
      Capsule().stroke(
        feedback.tier == .burst ? PunchGrowColors.warning : PunchGrowColors.calm, lineWidth: 1)
    )
    .shadow(
      color: (feedback.tier == .burst ? PunchGrowColors.warning : PunchGrowColors.calm).opacity(
        0.35), radius: 16
    )
    .onAppear {
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

struct MainWindowView: View {
  @ObservedObject var store: GameStore
  @ObservedObject var localUsage: LocalUsageService
  @ObservedObject var integrationStatus: IntegrationStatusProjection
  @State private var destination: MainDestination? = .collection

  var body: some View {
    NavigationSplitView {
      List(MainDestination.allCases, selection: $destination) { item in
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
        switch destination ?? .collection {
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
    return Bundle.module.url(forResource: species.id, withExtension: "png")
      ?? Bundle.module.url(forResource: species.id, withExtension: "png", subdirectory: "Creatures")
  }
  var body: some View {
    Group {
      if let url = imageURL, let image = CreatureImageCache.shared.image(for: url) {
        Image(nsImage: image).resizable().scaledToFit()
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
