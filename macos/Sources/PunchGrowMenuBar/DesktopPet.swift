import AppKit
import CoreImage
import ImageIO
import SwiftUI
import Vision

enum DesktopPetSpeciesResolver {
  static func resolve(
    representative: OwnedCreature?,
    current: OwnedCreature?,
    catalog: [CreatureSpecies]
  ) -> CreatureSpecies? {
    guard let creature = representative ?? current else { return nil }
    return GameEngine.displaySpecies(for: creature, catalog: catalog)
  }
}

enum DesktopPetMotionPolicy {
  static func allowsIdleMotion(
    appReduceEffects: Bool,
    systemReduceMotion: Bool
  ) -> Bool {
    !appReduceEffects && !systemReduceMotion
  }
}

@MainActor
final class DesktopPetCutoutCache {
  static let shared = DesktopPetCutoutCache()
  private(set) var lastErrorDescription: String?
  private let cache = NSCache<NSString, NSImage>()
  private let context = CIContext(options: [.cacheIntermediates: false])

  private init() {
    cache.countLimit = 32
    cache.totalCostLimit = 32 * 1_024 * 1_024
  }

  func image(for url: URL, points: CGFloat) -> NSImage? {
    let key = "\(url.path)#\(points)" as NSString
    if let cached = cache.object(forKey: key) { return cached }

    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(url: url, options: [:])
    do {
      lastErrorDescription = nil
      try handler.perform([request])
      guard let observation = request.results?.first,
            !observation.allInstances.isEmpty
      else { return nil }
      let pixelBuffer = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: true
      )
      let source = CIImage(cvPixelBuffer: pixelBuffer)
      guard let cgImage = context.createCGImage(source, from: source.extent) else { return nil }
      let image = scaledImage(cgImage, points: points)
      image.isTemplate = false
      cache.setObject(
        image,
        forKey: key,
        cost: max(1, Int(points * points * 4))
      )
      return image
    } catch {
      lastErrorDescription = error.localizedDescription
      guard let image = fallbackImage(for: url, points: points) else { return nil }
      cache.setObject(
        image,
        forKey: key,
        cost: max(1, Int(points * points * 4))
      )
      return image
    }
  }

  private func fallbackImage(for url: URL, points: CGFloat) -> NSImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    let width = cgImage.width
    let height = cgImage.height
    let bytesPerRow = width * 4
    guard width > 2, height > 2,
          let bitmap = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              | CGBitmapInfo.byteOrder32Big.rawValue
          ),
          let rawData = bitmap.data
    else { return nil }
    bitmap.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    let pixels = rawData.assumingMemoryBound(to: UInt8.self)
    let pixelCount = width * height
    var background = [Bool](repeating: false, count: pixelCount)
    var queue = [Int](repeating: 0, count: pixelCount)
    var head = 0
    var tail = 0

    func addSeed(_ index: Int) {
      guard !background[index] else { return }
      background[index] = true
      queue[tail] = index
      tail += 1
    }

    for x in 0..<width {
      addSeed(x)
      addSeed((height - 1) * width + x)
    }
    for y in 0..<height {
      addSeed(y * width)
      addSeed(y * width + width - 1)
    }

    var borderRed = 0
    var borderGreen = 0
    var borderBlue = 0
    let sampleSize = min(8, min(width, height))
    var sampleCount = 0
    for y in 0..<sampleSize {
      for x in 0..<sampleSize {
        for sampleX in [x, width - 1 - x] {
          for sampleY in [y, height - 1 - y] {
            let offset = (sampleY * width + sampleX) * 4
            borderRed += Int(pixels[offset])
            borderGreen += Int(pixels[offset + 1])
            borderBlue += Int(pixels[offset + 2])
            sampleCount += 1
          }
        }
      }
    }
    borderRed /= max(1, sampleCount)
    borderGreen /= max(1, sampleCount)
    borderBlue /= max(1, sampleCount)

    func canJoinBackground(_ candidate: Int, from current: Int) -> Bool {
      let candidateOffset = candidate * 4
      let currentOffset = current * 4
      let red = Int(pixels[candidateOffset])
      let green = Int(pixels[candidateOffset + 1])
      let blue = Int(pixels[candidateOffset + 2])
      let localDistance = abs(red - Int(pixels[currentOffset]))
        + abs(green - Int(pixels[currentOffset + 1]))
        + abs(blue - Int(pixels[currentOffset + 2]))
      let borderDistance = abs(red - borderRed)
        + abs(green - borderGreen)
        + abs(blue - borderBlue)
      return localDistance <= 12
        && (borderDistance <= 100 || max(red, max(green, blue)) <= 70)
    }

    while head < tail {
      let current = queue[head]
      head += 1
      let x = current % width
      let y = current / width
      if x > 0 {
        let candidate = current - 1
        if !background[candidate], canJoinBackground(candidate, from: current) {
          addSeed(candidate)
        }
      }
      if x + 1 < width {
        let candidate = current + 1
        if !background[candidate], canJoinBackground(candidate, from: current) {
          addSeed(candidate)
        }
      }
      if y > 0 {
        let candidate = current - width
        if !background[candidate], canJoinBackground(candidate, from: current) {
          addSeed(candidate)
        }
      }
      if y + 1 < height {
        let candidate = current + width
        if !background[candidate], canJoinBackground(candidate, from: current) {
          addSeed(candidate)
        }
      }
    }

    for index in 0..<pixelCount {
      let offset = index * 4
      if background[index] {
        pixels[offset] = 0
        pixels[offset + 1] = 0
        pixels[offset + 2] = 0
        pixels[offset + 3] = 0
        continue
      }
      let x = index % width
      let y = index / width
      var adjacentBackground = 0
      for neighborY in max(0, y - 1)...min(height - 1, y + 1) {
        for neighborX in max(0, x - 1)...min(width - 1, x + 1)
        where background[neighborY * width + neighborX] {
          adjacentBackground += 1
        }
      }
      guard adjacentBackground > 0 else { continue }
      let alpha = UInt8(max(72, 255 - adjacentBackground * 22))
      pixels[offset] = UInt8(Int(pixels[offset]) * Int(alpha) / 255)
      pixels[offset + 1] = UInt8(Int(pixels[offset + 1]) * Int(alpha) / 255)
      pixels[offset + 2] = UInt8(Int(pixels[offset + 2]) * Int(alpha) / 255)
      pixels[offset + 3] = alpha
    }

    guard let result = bitmap.makeImage() else { return nil }
    return scaledImage(result, points: points)
  }

  private func scaledImage(_ cgImage: CGImage, points: CGFloat) -> NSImage {
    let sourceSize = NSSize(width: cgImage.width, height: cgImage.height)
    let scale = points / max(sourceSize.width, sourceSize.height)
    return NSImage(
      cgImage: cgImage,
      size: NSSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    )
  }
}

@MainActor
final class DesktopPetController: NSObject, ObservableObject {
  static let visibilityKey = "desktopPetVisible"
  static let frameAutosaveName = "PunchGrow.DesktopPet"
  static let panelSize = NSSize(width: 200, height: 220)

  @Published var isVisible: Bool {
    didSet {
      guard oldValue != isVisible else { return }
      defaults.set(isVisible, forKey: Self.visibilityKey)
      guard hasStarted else { return }
      syncVisibility()
    }
  }

  private let store: GameStore
  private let defaults: UserDefaults
  private var panel: DesktopPetPanel?
  private var hasStarted = false

  init(store: GameStore, defaults: UserDefaults = .standard, defaultVisible: Bool = true) {
    self.store = store
    self.defaults = defaults
    if defaults.object(forKey: Self.visibilityKey) == nil {
      isVisible = defaultVisible
    } else {
      isVisible = defaults.bool(forKey: Self.visibilityKey)
    }
    super.init()
  }

  func start() {
    guard !hasStarted else {
      syncVisibility()
      return
    }
    hasStarted = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(screenParametersDidChange),
      name: NSApplication.didChangeScreenParametersNotification,
      object: nil
    )
    syncVisibility()
  }

  func stop() {
    NotificationCenter.default.removeObserver(
      self,
      name: NSApplication.didChangeScreenParametersNotification,
      object: nil
    )
    destroyPanel()
    hasStarted = false
  }

  static func clampedOrigin(
    for frame: NSRect,
    within visibleFrame: NSRect,
    margin: CGFloat = 12
  ) -> NSPoint {
    let minimumX = visibleFrame.minX + margin
    let minimumY = visibleFrame.minY + margin
    let maximumX = max(minimumX, visibleFrame.maxX - margin - frame.width)
    let maximumY = max(minimumY, visibleFrame.maxY - margin - frame.height)
    return NSPoint(
      x: min(max(frame.minX, minimumX), maximumX),
      y: min(max(frame.minY, minimumY), maximumY)
    )
  }

  private func syncVisibility() {
    guard isVisible else {
      destroyPanel()
      return
    }
    let panel = panel ?? makePanel()
    self.panel = panel
    clampToAvailableScreen(panel)
    panel.orderFrontRegardless()
  }

  private func destroyPanel() {
    guard let panel else { return }
    panel.saveFrame(usingName: Self.frameAutosaveName)
    panel.orderOut(nil)
    panel.contentView = nil
    panel.close()
    self.panel = nil
  }

  @objc private func screenParametersDidChange() {
    guard isVisible, let panel else { return }
    clampToAvailableScreen(panel)
  }

  private func makePanel() -> DesktopPetPanel {
    let initialVisibleFrame = NSScreen.main?.visibleFrame
      ?? NSScreen.screens.first?.visibleFrame
      ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
    let initialFrame = NSRect(
      x: initialVisibleFrame.maxX - Self.panelSize.width - 24,
      y: initialVisibleFrame.minY + 24,
      width: Self.panelSize.width,
      height: Self.panelSize.height
    )
    let panel = DesktopPetPanel(
      contentRect: initialFrame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .floating
    panel.collectionBehavior = [
      .canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary, .ignoresCycle,
    ]
    panel.hidesOnDeactivate = false
    panel.canHide = false
    panel.isReleasedWhenClosed = false
    panel.isMovableByWindowBackground = true
    panel.animationBehavior = .utilityWindow
    panel.becomesKeyOnlyIfNeeded = true
    panel.contentView = DesktopPetHostingView(rootView: DesktopPetView(store: store))

    _ = panel.setFrameUsingName(Self.frameAutosaveName, force: true)
    clampToAvailableScreen(panel)
    panel.setFrameAutosaveName(Self.frameAutosaveName)
    return panel
  }

  private func clampToAvailableScreen(_ panel: NSPanel) {
    let screens = NSScreen.screens
    guard !screens.isEmpty else { return }
    let frame = panel.frame
    let target = screens.max { lhs, rhs in
      Self.screenScore(lhs.visibleFrame, for: frame) < Self.screenScore(rhs.visibleFrame, for: frame)
    } ?? screens[0]
    let origin = Self.clampedOrigin(for: frame, within: target.visibleFrame)
    guard origin != frame.origin else { return }
    panel.setFrameOrigin(origin)
    panel.saveFrame(usingName: Self.frameAutosaveName)
  }

  private static func screenScore(_ visibleFrame: NSRect, for windowFrame: NSRect) -> CGFloat {
    let intersection = visibleFrame.intersection(windowFrame)
    if !intersection.isNull {
      return intersection.width * intersection.height
    }
    let deltaX = visibleFrame.midX - windowFrame.midX
    let deltaY = visibleFrame.midY - windowFrame.midY
    return -((deltaX * deltaX) + (deltaY * deltaY))
  }
}

private final class DesktopPetPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class DesktopPetHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }
}

private struct DesktopPetView: View {
  @ObservedObject var store: GameStore
  @AppStorage("reduceEffects") private var reduceEffects = false
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @State private var isFloating = false

  private let calm = Color(red: 77 / 255, green: 225 / 255, blue: 1)
  private let fuel = Color(red: 198 / 255, green: 248 / 255, blue: 78 / 255)

  private var creature: OwnedCreature? {
    store.representativeCreature ?? store.currentCreature
  }

  private var species: CreatureSpecies? {
    DesktopPetSpeciesResolver.resolve(
      representative: store.representativeCreature,
      current: store.currentCreature,
      catalog: store.catalog
    )
  }

  private var creatureImage: NSImage? {
    guard let species, let url = CreatureAssetLocator.imageURL(for: species) else { return nil }
    return DesktopPetCutoutCache.shared.image(for: url, points: 164)
  }

  private var reducesMotion: Bool {
    !DesktopPetMotionPolicy.allowsIdleMotion(
      appReduceEffects: reduceEffects,
      systemReduceMotion: systemReduceMotion
    )
  }

  var body: some View {
    VStack(spacing: 8) {
      ZStack {
        if let creatureImage {
          Image(nsImage: creatureImage)
            .resizable()
            .interpolation(.high)
            .antialiased(true)
            .scaledToFit()
            .shadow(color: calm.opacity(0.34), radius: 10, y: 5)
        } else {
          VStack(spacing: 10) {
            Image(systemName: "sparkles")
              .font(.system(size: 44, weight: .semibold))
              .foregroundStyle(calm)
            Text("첫 크리처를\n뽑아 주세요")
              .font(.system(size: 14, weight: .bold, design: .rounded))
              .multilineTextAlignment(.center)
              .foregroundStyle(.white.opacity(0.88))
          }
        }
      }
      .frame(width: 176, height: 176)
      .offset(y: reducesMotion ? 0 : (isFloating ? -3 : 3))

      HStack(spacing: 6) {
        Text(store.representativeCreature == nil ? "현재" : "대표")
          .foregroundStyle(fuel)
        Text(creature?.nickname ?? species?.koName ?? "PUNCHGROW")
          .lineLimit(1)
          .foregroundStyle(.white.opacity(0.92))
      }
      .font(.system(size: 11, weight: .bold, design: .rounded))
      .shadow(color: .black.opacity(0.95), radius: 3, y: 1)
    }
    .frame(width: DesktopPetController.panelSize.width, height: DesktopPetController.panelSize.height)
    .contentShape(Rectangle())
    .onAppear { updateMotion() }
    .onChange(of: reducesMotion) { _, _ in updateMotion() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      species.map { "데스크톱 펫, \(creature?.nickname ?? $0.koName)" }
        ?? "데스크톱 펫, 첫 크리처를 뽑아 주세요"
    )
  }

  private func updateMotion() {
    if reducesMotion {
      withAnimation(nil) { isFloating = false }
    } else {
      isFloating = false
      DispatchQueue.main.async {
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
          isFloating = true
        }
      }
    }
  }
}
