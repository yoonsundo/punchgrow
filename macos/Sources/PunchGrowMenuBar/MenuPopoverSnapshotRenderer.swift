#if DEBUG
import AppKit
import SwiftUI

struct MenuPopoverSnapshotRequest: Equatable {
  static let flag = "--snapshot-menu-popover"
  static let menuFreshFlag = "--snapshot-menu-popover-fresh"
  static let evolutionFlag = "--snapshot-evolution-dex"
  static let rarityFlag = "--snapshot-rarity-guide"

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
    } else if let index = arguments.firstIndex(of: Self.rarityFlag) {
      match = (index, .rarity, Self.rarityFlag)
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
    case rarity
  }

  var usesFreshSetupFixture: Bool { kind == .menuFresh }

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
  static let raritySize = NSSize(width: 360, height: 490)

  static func makeFixture(freshSetup: Bool = false) throws -> MenuPopoverSnapshotFixture {
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
    let creatures = snapshotSpecies.enumerated().map { index, species in
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
      mainNavigation: mainNavigation
    )
    try render(rootView, size: size, to: outputURL)
  }

  static func renderEvolutionDex(to outputURL: URL) throws {
    let catalog = try CreatureCatalog.load()
    guard catalog.contains(where: { $0.id == "PG-001" }),
          catalog.contains(where: { $0.id == "PG-181" })
    else { throw SnapshotError.insufficientCatalog }
    let creature = OwnedCreature(
      id: UUID(uuidString: "00000000-0000-4000-8000-000000000181")!,
      speciesID: "PG-181",
      originSpeciesID: "PG-001",
      level: 25,
      experience: 0,
      affection: 100,
      nickname: nil,
      uniqueColor: false,
      acquiredAt: Date(timeIntervalSince1970: 1_754_275_200)
    )
    let presentation = EvolutionDexPresentation.make(
      creature: creature,
      catalog: catalog,
      discoveredSpeciesIDs: ["PG-001", "PG-061", "PG-181"]
    )
    try render(
      EvolutionGuidePopover(presentation: presentation),
      size: evolutionSize,
      to: outputURL
    )
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
    to outputURL: URL
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
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
      throw SnapshotError.pngEncodingFailed
    }
    try FileManager.default.createDirectory(
      at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true
    )
    try png.write(to: outputURL, options: .atomic)
    window.close()
    FileHandle.standardOutput.write(Data("\(outputURL.path)\n".utf8))
  }

  private static func deterministicUUID(index: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index + 1))!
  }

  private enum SnapshotError: Error {
    case insufficientCatalog
    case bitmapCreationFailed
    case pngEncodingFailed
  }
}
#endif
