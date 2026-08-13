#if DEBUG
import AppKit
import SwiftUI

struct MenuPopoverSnapshotRequest: Equatable {
  static let flag = "--snapshot-menu-popover"
  static let menuFreshFlag = "--snapshot-menu-popover-fresh"
  static let evolutionFlag = "--snapshot-evolution-dex"
  static let evolutionChoiceFlag = "--snapshot-evolution-choice"
  static let mutationOfferFlag = "--snapshot-mutation-offer"
  static let rarityFlag = "--snapshot-rarity-guide"
  static let menuBarHUDFlag = "--snapshot-menu-bar-hud"
  static let grantToastFlag = "--snapshot-grant-toast"
  static let levelMaxFlag = "--snapshot-level-max"

  let kind: Kind
  let outputURL: URL

  init?(arguments: [String]) throws {
    let match: (index: Int, kind: Kind, flag: String)?
    if let index = arguments.firstIndex(of: Self.flag) {
      match = (index, .menu, Self.flag)
    } else if let index = arguments.firstIndex(of: Self.menuFreshFlag) {
      match = (index, .menuFresh, Self.menuFreshFlag)
    } else if let index = arguments.firstIndex(of: Self.evolutionFlag) {
      match = (index, .evolution, Self.evolutionFlag)
    } else if let index = arguments.firstIndex(of: Self.evolutionChoiceFlag) {
      match = (index, .evolutionChoice, Self.evolutionChoiceFlag)
    } else if let index = arguments.firstIndex(of: Self.mutationOfferFlag) {
      match = (index, .mutationOffer, Self.mutationOfferFlag)
    } else if let index = arguments.firstIndex(of: Self.rarityFlag) {
      match = (index, .rarity, Self.rarityFlag)
    } else if let index = arguments.firstIndex(of: Self.menuBarHUDFlag) {
      match = (index, .menuBarHUD, Self.menuBarHUDFlag)
    } else if let index = arguments.firstIndex(of: Self.grantToastFlag) {
      match = (index, .grantToast, Self.grantToastFlag)
    } else if let index = arguments.firstIndex(of: Self.levelMaxFlag) {
      match = (index, .levelMax, Self.levelMaxFlag)
    } else {
      match = nil
    }
    guard let match else { return nil }
    let flagIndex = match.index
    guard arguments.indices.contains(flagIndex + 1), !arguments[flagIndex + 1].isEmpty else {
      throw RequestError.missingOutputPath(flag: match.flag)
    }
    kind = match.kind
    outputURL = URL(fileURLWithPath: arguments[flagIndex + 1]).standardizedFileURL
  }

  enum Kind: Equatable {
    case menu
    case menuFresh
    case evolution
    case evolutionChoice
    case mutationOffer
    case rarity
    case menuBarHUD
    case grantToast
    case levelMax
  }

  var usesFreshSetupFixture: Bool { kind == .menuFresh }
  var usesLevelMaxFixture: Bool { kind == .levelMax }

  enum RequestError: LocalizedError {
    case missingOutputPath(flag: String)

    var errorDescription: String? {
      switch self {
      case .missingOutputPath(let flag): "\(flag) requires an output PNG path"
      }
    }
  }
}

@MainActor
struct MenuPopoverSnapshotFixture {
  let store: GameStore
  private let temporaryDirectory: URL

  fileprivate init(store: GameStore, temporaryDirectory: URL) {
    self.store = store
    self.temporaryDirectory = temporaryDirectory
  }

  func removeTemporaryFiles() {
    try? FileManager.default.removeItem(at: temporaryDirectory)
  }
}

@MainActor
enum MenuPopoverSnapshotRenderer {
  static let size = NSSize(width: MenuPopoverLayout.width, height: MenuPopoverLayout.height)
  static let evolutionSize = NSSize(width: 372, height: 620)
  static let evolutionChoiceSize = NSSize(width: 372, height: 520)
  static let mutationOfferSize = NSSize(width: 372, height: 420)
  static let raritySize = NSSize(width: 360, height: 490)
  static let grantToastSize = NSSize(width: 380, height: 260)

  static func makeFixture(
    freshSetup: Bool = false,
    levelMaxShowcase: Bool = false
  ) throws -> MenuPopoverSnapshotFixture {
    let catalog = try CreatureCatalog.load()
    let rootSpecies = catalog
      .filter { $0.stage == 1 && $0.evolutionFrom.isEmpty }
      .sorted { $0.id < $1.id }
    guard rootSpecies.count >= 14,
          let featuredSpecies = rootSpecies.first(where: { $0.id == "PG-041" })
    else { throw SnapshotError.insufficientCatalog }
    var snapshotSpecies = Array(rootSpecies.prefix(14))
    snapshotSpecies[9] = featuredSpecies

    let temporaryDirectory = FileManager.default.temporaryDirectory
      .appending(path: "PunchGrowMenuPopoverSnapshot-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.removeItem(at: temporaryDirectory)
    try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)

    let acquiredAt = Date(timeIntervalSince1970: 1_754_275_200)
    var creatures = snapshotSpecies.enumerated().map { index, species in
      OwnedCreature(
        id: deterministicUUID(index: index),
        speciesID: species.id,
        originSpeciesID: species.id,
        level: index == 9 ? 24 : max(1, index + 1),
        experience: index == 9 ? 225 : index * 40,
        affection: index == 9 ? 100 : min(100, 20 + index * 5),
        nickname: nil,
        uniqueColor: false,
        acquiredAt: acquiredAt.addingTimeInterval(TimeInterval(index))
      )
    }
    if levelMaxShowcase {
      // 골드 연출 확인용 만렙 개체. 종착 종을 쓰면 진화 대기 배지가 끼어들지 않아
      // 만렙 표시만 분리해 볼 수 있다.
      guard catalog.contains(where: { $0.id == "PG-092" }) else {
        throw SnapshotError.insufficientCatalog
      }
      creatures[9] = OwnedCreature(
        id: deterministicUUID(index: 9),
        speciesID: "PG-092",
        originSpeciesID: "PG-024",
        level: GameState.maximumCreatureLevel,
        experience: 0,
        affection: 100,
        nickname: nil,
        uniqueColor: false,
        acquiredAt: acquiredAt.addingTimeInterval(9)
      )
    }
    let currentCreature = creatures[9]
    let state = GameState(
      tokenBalance: 39_073_759,
      lifetimeUsage: [.claude: 11_366_566, .codex: 820_481_664],
      ownedCreatures: creatures,
      discoveredSpeciesIDs: Set(creatures.map(\.speciesID)),
      inventory: Inventory(food: 12, largeFood: 4, trainingTools: 1, evolutionMaterials: 0),
      pullsSinceOrigin: 46,
      representativeCreatureID: currentCreature.id
    )
    let persistence = GamePersistence(fileURL: temporaryDirectory.appending(path: "state.json"))
    try persistence.save(state)
    let store = GameStore(persistence: persistence, catalog: catalog, now: { acquiredAt })
    if freshSetup {
      return MenuPopoverSnapshotFixture(store: store, temporaryDirectory: temporaryDirectory)
    }
    store.updateObservedLocalUsage(
      total: [.claude: 11_366_566, .codex: 820_481_664],
      weekly: [.claude: 11_366_566, .codex: 820_481_664],
      weeklyBreakdown: [
        .claude: LocalUsageCounts(inputTokens: 145, cachedTokens: 11_311_632, outputTokens: 54_789),
        .codex: LocalUsageCounts(inputTokens: 71_250_000, cachedTokens: 702_881_664, outputTokens: 46_350_000),
      ],
      quotaSnapshots: [
        .claude: ProviderQuotaSnapshot(usedPercent: 100, resetsAt: nil, observedAt: acquiredAt),
        .codex: ProviderQuotaSnapshot(usedPercent: 48, resetsAt: nil, observedAt: acquiredAt),
      ]
    )
    return MenuPopoverSnapshotFixture(store: store, temporaryDirectory: temporaryDirectory)
  }

  /// 스냅샷 렌더는 사용자 설정을 읽지도 쓰지도 않는다.
  private static func inertDefaults() -> UserDefaults {
    UserDefaults(suiteName: "app.punchgrow.menubar.snapshot") ?? .standard
  }

  static func render(
    to outputURL: URL,
    store: GameStore,
    integrationStatus: IntegrationStatusProjection,
    originReveal: OriginRevealCoordinator,
    mainNavigation: MainWindowNavigation
  ) throws {
    let rootView = MenuPopoverView(
      store: store,
      integrationStatus: integrationStatus,
      originReveal: originReveal,
      mainNavigation: mainNavigation,
      // 스냅샷은 네트워크를 쓰지 않는다. 버전이 없는 서비스는 확인을 아예 시작하지 않는다.
      updates: UpdateService(currentVersion: nil, defaults: Self.inertDefaults())
    )
    try render(rootView, size: size, to: outputURL, forbidsScrollView: true)
  }

  /// 만렙 골드 연출(포트레이트 링·LV 게이지)과 LEVEL MAX 토스트를 한 장으로 확인한다.
  /// 토스트는 급여 전이 순간에만 살아 있는 상태라 렌더에서 직접 얹는다.
  static func renderLevelMax(
    to outputURL: URL,
    store: GameStore,
    integrationStatus: IntegrationStatusProjection,
    originReveal: OriginRevealCoordinator,
    mainNavigation: MainWindowNavigation
  ) throws {
    guard let creature = store.currentCreature,
          creature.level >= GameState.maximumCreatureLevel,
          let species = store.currentSpecies
    else { throw SnapshotError.insufficientCatalog }
    let rootView = MenuPopoverView(
      store: store,
      integrationStatus: integrationStatus,
      originReveal: originReveal,
      mainNavigation: mainNavigation,
      updates: UpdateService(currentVersion: nil, defaults: Self.inertDefaults())
    )
    .overlay(alignment: .top) {
      LevelMaxToast(
        feedback: MaxLevelFeedback(
          id: deterministicUUID(index: 50),
          creatureID: creature.id,
          creatureName: species.koName
        )
      )
      .padding(12)
    }
    try render(rootView, size: size, to: outputURL, forbidsScrollView: true)
  }

  static func renderEvolutionDex(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    guard catalog.contains(where: { $0.id == "PG-024" }),
          catalog.contains(where: { $0.id == "PG-092" })
    else { throw SnapshotError.insufficientCatalog }
    let creature = OwnedCreature(
      id: UUID(uuidString: "00000000-0000-4000-8000-000000000092")!,
      speciesID: "PG-092",
      originSpeciesID: "PG-024",
      level: 40,
      experience: 0,
      affection: 100,
      nickname: nil,
      uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1_754_275_200)
    )
    guard let presentation = EvolutionDexPresentation.make(
      creature: creature,
      catalog: catalog,
      discoveredSpeciesIDs: ["PG-024", "PG-090", "PG-091", "PG-092"]
    ) else { throw SnapshotError.insufficientCatalog }
    let entries = Dictionary(
      uniqueKeysWithValues: presentation.stages.flatMap(\.entries).map { ($0.id, $0) })
    guard presentation.stages.count == 4,
          presentation.stages.first(where: { $0.stage == 2 })?.entries.count == 3,
          entries.count == 6,
          entries["PG-024"]?.isFormOwned == true,
          entries["PG-024"]?.canPreviewForm == true,
          entries["PG-090"]?.isFormOwned == true,
          entries["PG-091"]?.isFormOwned == true,
          entries["PG-091"]?.canPreviewForm == true,
          entries["PG-092"]?.isCurrent == true,
          entries["PG-092"]?.canPreviewForm == false,
          entries["PG-200"]?.isFormOwned == false,
          entries["PG-200"]?.canPreviewForm == false,
          entries["PG-235"]?.isFormOwned == false,
          entries["PG-235"]?.canPreviewForm == false
    else { throw SnapshotError.insufficientCatalog }
    try render(
      EvolutionGuidePopover(presentation: presentation),
      size: evolutionSize,
      to: outputURL
    )
  }

  // 갈림길에서 멈춘 제피락 계보(PG-117 Lv.25)를 쓴다. 후보 PG-118은 발견 상태,
  // 종착 후보 PG-205는 미발견이라 한 장의 스냅샷에서 두 카드 상태를 모두 확인할 수 있다.
  static func renderEvolutionChoice(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    let creature = OwnedCreature(
      id: UUID(uuidString: "00000000-0000-4000-8000-000000000117")!,
      speciesID: "PG-117",
      originSpeciesID: "PG-034",
      level: 25,
      experience: 0,
      affection: 100,
      nickname: nil,
      uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1_754_275_200)
    )
    guard let choice = GameEngine.pendingEvolutionChoice(for: creature, catalog: catalog)
    else { throw SnapshotError.insufficientCatalog }
    let presentation = EvolutionChoicePresentation.make(
      choice: choice,
      catalog: catalog,
      discoveredSpeciesIDs: ["PG-034", "PG-117", "PG-118"]
    )
    try render(
      EvolutionChoiceSheet(presentation: presentation)
        .frame(
          width: evolutionChoiceSize.width,
          height: evolutionChoiceSize.height
        )
        .background(Color(red: 7 / 255, green: 6 / 255, blue: 13 / 255)),
      size: evolutionChoiceSize,
      to: outputURL
    )
  }

  // 에일루 계보(PG-001 Lv.15)에서 변이 PG-216이 발동한 순간을 쓴다. 거절 대상 PG-061은
  // 미발견 상태라 은닉 문구까지 한 장에서 확인된다.
  /// 재도전 성공·실패와 계승을 한 장에 세로로 쌓아, 세 결과가 서로 구분되는지 한눈에 본다.
  static func renderGrantToast(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    guard let mutation = catalog.first(where: { $0.id == "PG-216" }),
          let origin = catalog.first(where: { $0.id == "PG-001" })
    else { throw SnapshotError.insufficientCatalog }
    let samples = [
      CreatureGrantFeedback(
        id: UUID(), kind: .mutationRetry, succeeded: true,
        grantedSpeciesID: mutation.id, tokensSpent: GameState.mutationRetryCost,
        failureCount: 0),
      CreatureGrantFeedback(
        id: UUID(), kind: .mutationRetry, succeeded: false,
        grantedSpeciesID: nil, tokensSpent: GameState.mutationRetryCost,
        failureCount: 7),
      CreatureGrantFeedback(
        id: UUID(), kind: .inheritance, succeeded: true,
        grantedSpeciesID: origin.id, tokensSpent: GameState.inheritCost,
        failureCount: 0),
    ]
    try render(
      VStack(spacing: 16) {
        ForEach(samples) { CreatureGrantToast(feedback: $0, catalog: catalog) }
      }
      .frame(width: grantToastSize.width, height: grantToastSize.height)
      .background(Color(red: 7 / 255, green: 6 / 255, blue: 13 / 255)),
      size: grantToastSize,
      to: outputURL
    )
  }

  static func renderMutationOffer(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    let offer = PendingMutationOffer(
      creatureID: UUID(uuidString: "00000000-0000-4000-8000-000000000216")!,
      fromSpeciesID: "PG-001",
      mutationSpeciesID: "PG-216",
      plannedTargetSpeciesID: "PG-061"
    )
    guard let presentation = MutationOfferPresentation.make(
      offer: offer, catalog: catalog, discoveredSpeciesIDs: ["PG-001"]
    ) else { throw SnapshotError.insufficientCatalog }
    try render(
      MutationOfferSheet(presentation: presentation)
        .frame(width: mutationOfferSize.width, height: mutationOfferSize.height)
        .background(Color(red: 7 / 255, green: 6 / 255, blue: 13 / 255)),
      size: mutationOfferSize,
      to: outputURL
    )
  }

  // 메뉴바 HUD를 구도가 다른 세 스프라이트(세로형·가로형·장신형)로, 어두운/밝은 메뉴바
  // 배경 위에 렌더한다. 각 배경마다 위 줄은 크롭 없는 기준선, 아래 줄은 현재 썸네일이다.
  // 비배경 픽셀 비율도 stdout으로 출력해 크롭·밝기 보정 효과를 수치로 확인한다.
  static func renderMenuBarHUD(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    let entries: [(id: String, current: NSImage, baseline: NSImage)] =
      try ["PG-001", "PG-044", "PG-130"].map { id in
        guard let species = catalog.first(where: { $0.id == id }),
          let url = CreatureAssetLocator.imageURL(for: species),
          let source = NSImage(contentsOf: url),
          let current = CreatureImageCache.shared.thumbnail(for: url, points: 20)
        else { throw SnapshotError.insufficientCatalog }
        return (id, current, CreatureThumbnailDiagnostics.uncroppedThumbnail(of: source, points: 20))
      }

    for entry in entries {
      let line = "HUD-COVERAGE \(entry.id)"
        + " cropped=\(CreatureThumbnailDiagnostics.contentCoverage(of: entry.current))"
        + " baseline=\(CreatureThumbnailDiagnostics.contentCoverage(of: entry.baseline))\n"
      FileHandle.standardOutput.write(Data(line.utf8))
    }

    struct HUDRow {
      let background: NSColor
      let creatures: [NSImage]
    }
    let backgrounds = [
      NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1),
      NSColor(srgbRed: 0.55, green: 0.78, blue: 0.80, alpha: 1),
    ]
    let rows = backgrounds.flatMap { background in
      [
        HUDRow(background: background, creatures: entries.map(\.baseline)),
        HUDRow(background: background, creatures: entries.map(\.current)),
      ]
    }
    let cell = NSSize(width: MenuBarHUDRenderer.size.width + 24, height: 44)
    let composite = NSImage(
      size: NSSize(
        width: cell.width * CGFloat(entries.count),
        height: cell.height * CGFloat(rows.count)
      ),
      flipped: false
    ) { bounds in
      for (rowIndex, row) in rows.enumerated() {
        let y = cell.height * CGFloat(rows.count - 1 - rowIndex)
        row.background.setFill()
        NSRect(x: 0, y: y, width: bounds.width, height: cell.height).fill()
        for (column, creature) in row.creatures.enumerated() {
          MenuBarHUDRenderer.render(
            creature: creature, claudeProgressPercent: 25, codexProgressPercent: 100
          ).draw(
            at: NSPoint(x: cell.width * CGFloat(column) + 12, y: y + 11),
            from: .zero, operation: .sourceOver, fraction: 1
          )
        }
      }
      return !bounds.isEmpty
    }
    try writePNG(composite, scale: 2, to: outputURL)
  }

  private static func writePNG(_ image: NSImage, scale: CGFloat, to outputURL: URL) throws {
    guard let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: Int((image.size.width * scale).rounded()),
      pixelsHigh: Int((image.size.height * scale).rounded()),
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    ) else { throw SnapshotError.bitmapCreationFailed }
    bitmap.size = image.size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(origin: .zero, size: image.size))
    NSGraphicsContext.restoreGraphicsState()
    try writeSnapshotPNG(bitmap, to: outputURL)
  }

  private static func writeSnapshotPNG(_ bitmap: NSBitmapImageRep, to outputURL: URL) throws {
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
      throw SnapshotError.pngEncodingFailed
    }
    try FileManager.default.createDirectory(
      at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true
    )
    try png.write(to: outputURL, options: .atomic)
    FileHandle.standardOutput.write(Data("\(outputURL.path)\n".utf8))
  }

  static func renderRarityGuide(to outputURL: URL, store: GameStore) throws {
    let rows = RarityGuidePresentation.rows(state: store.state, catalog: store.catalog)
    try render(
      RarityGuidePopover(rows: rows)
        .frame(width: raritySize.width, height: raritySize.height, alignment: .top),
      size: raritySize,
      to: outputURL
    )
  }

  private static func render<Content: View>(
    _ rootView: Content,
    size: NSSize,
    to outputURL: URL,
    forbidsScrollView: Bool = false
  ) throws {
    let hostingView = NSHostingView(rootView: rootView)
    hostingView.frame = NSRect(origin: .zero, size: size)

    let window = NSWindow(
      contentRect: NSRect(origin: NSPoint(x: -10_000, y: -10_000), size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.isReleasedWhenClosed = false
    window.backgroundColor = .clear
    window.contentView = hostingView
    window.layoutIfNeeded()
    hostingView.layoutSubtreeIfNeeded()
    hostingView.displayIfNeeded()

    if forbidsScrollView, containsScrollView(in: hostingView) {
      throw SnapshotError.unexpectedScrollView
    }

    guard let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: Int(size.width),
      pixelsHigh: Int(size.height),
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    ) else { throw SnapshotError.bitmapCreationFailed }
    bitmap.size = size
    hostingView.cacheDisplay(in: hostingView.bounds, to: bitmap)
    try writeSnapshotPNG(bitmap, to: outputURL)
    window.close()
  }

  private static func containsScrollView(in view: NSView) -> Bool {
    view is NSScrollView || view.subviews.contains { containsScrollView(in: $0) }
  }

  private static func deterministicUUID(index: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index + 1))!
  }

  private enum SnapshotError: Error {
    case insufficientCatalog
    case bitmapCreationFailed
    case pngEncodingFailed
    case unexpectedScrollView
  }
}

// 스냅샷 CLI와 테스트가 함께 쓰는 썸네일 진단 도구. 로직이 두 곳으로 갈라지지 않도록
// 여기 한 곳에만 둔다.
@MainActor
enum CreatureThumbnailDiagnostics {
  static let cardBackground = (red: 8, green: 17, blue: 31)

  static func uncroppedThumbnail(of source: NSImage, points: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: points, height: points), flipped: false) { destination in
      NSGraphicsContext.current?.imageInterpolation = .high
      source.draw(
        in: destination,
        from: NSRect(origin: .zero, size: source.size),
        operation: .sourceOver,
        fraction: 1
      )
      return true
    }
  }

  static func contentCoverage(of image: NSImage) -> Double {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(
        data: nil, width: cgImage.width, height: cgImage.height,
        bitsPerComponent: 8, bytesPerRow: cgImage.width * 4, space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else { return 0 }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
    guard let data = context.data else { return 0 }

    let pixels = data.bindMemory(to: UInt8.self, capacity: cgImage.width * cgImage.height * 4)
    var contentCount = 0
    for index in 0..<(cgImage.width * cgImage.height) {
      let base = index * 4
      guard pixels[base + 3] >= 32 else { continue }
      if abs(Int(pixels[base]) - cardBackground.red) > 30
        || abs(Int(pixels[base + 1]) - cardBackground.green) > 30
        || abs(Int(pixels[base + 2]) - cardBackground.blue) > 30
      {
        contentCount += 1
      }
    }
    return Double(contentCount) / Double(cgImage.width * cgImage.height)
  }
}
#endif
