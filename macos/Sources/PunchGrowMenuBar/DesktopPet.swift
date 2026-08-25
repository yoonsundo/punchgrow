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

/// 데스크톱 펫의 크기 프리셋. 자유 슬라이더 대신 4단계로 못 박아, 어떤 값을 골라도
/// 크리처가 알아볼 수 있는 크기로 남고 화면 배치가 예측 가능하게 유지된다.
enum DesktopPetSize: String, CaseIterable, Identifiable, Sendable {
  case tiny
  case small
  case regular
  case large

  /// 크기 조절이 들어오기 전의 펫 크기. `regular`가 이 값과 같아야 기존 사용자의 펫이
  /// 업데이트만으로 달라지지 않는다.
  static let basePanelSize = NSSize(width: 200, height: 220)

  var id: String { rawValue }

  var scale: CGFloat {
    switch self {
    case .tiny: 0.6
    case .small: 0.8
    case .regular: 1
    case .large: 1.3
    }
  }

  var koLabel: String {
    switch self {
    case .tiny: "아주 작게"
    case .small: "작게"
    case .regular: "보통"
    case .large: "크게"
    }
  }

  /// 원본 비율을 그대로 곱한다. 단계마다 비율이 달라지면 크리처가 찌그러진다.
  var panelSize: NSSize {
    NSSize(
      width: Self.basePanelSize.width * scale,
      height: Self.basePanelSize.height * scale
    )
  }

  /// 크리처 그림이 차지하는 정사각 영역.
  var stagePoints: CGFloat { 176 * scale }

  /// 잘라낸 비트맵은 프리셋과 무관하게 가장 큰 단계 기준으로 한 장만 만든다. 잘라내기
  /// 캐시가 크기를 키로 쓰기 때문에, 프리셋마다 따로 만들면 크기를 처음 고를 때마다
  /// Vision 전경 분리가 주 스레드에서 다시 돌아 화면이 멈칫한다. 축소는 SwiftUI 가 한다.
  static let artworkPoints: CGFloat = 164 * DesktopPetSize.large.scale

  /// 글자와 여백처럼 프리셋을 따라 함께 줄어야 하는 값에 쓴다. 그림만 줄고 이름표가
  /// 그대로면 작은 펫에서 글자가 크리처보다 커진다.
  func scaled(_ value: CGFloat) -> CGFloat { value * scale }
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

  /// 잘라내기를 어느 경로가 만들어 냈는지. 마스크가 조용히 실패하면 펫 자리가 빈칸으로
  /// 남는데, 화면 없는 머신(CI)과 실제 Mac 이 서로 다른 경로를 타므로 기록해 둔다.
  enum MaskSource: String {
    case vision
    case localFallback
    case rawSource
  }

  private(set) var lastErrorDescription: String?
  private(set) var lastMaskSource: MaskSource?
  private let cache = NSCache<NSString, NSImage>()
  private let context = CIContext(options: [.cacheIntermediates: false])

  private init() {
    cache.countLimit = 32
    cache.totalCostLimit = 32 * 1_024 * 1_024
  }

  /// 좋은 경로부터 차례로 시도하고, 결과가 사실상 비어 있으면 다음 경로로 넘어간다.
  /// Vision 이 예외 없이 성공하고도 투명한 비트맵을 돌려주는 머신이 있다. 그걸 그대로
  /// 캐시하면 펫 자리가 빈칸으로 남고, 캐시 때문에 앱을 다시 켜도 낫지 않는다.
  func image(for url: URL, points: CGFloat) -> NSImage? {
    let key = "\(url.path)#\(points)" as NSString
    if let cached = cache.object(forKey: key) { return cached }

    lastErrorDescription = nil
    let attempts: [(MaskSource, () -> NSImage?)] = [
      (.vision, { self.visionCutout(for: url, points: points) }),
      (.localFallback, { self.fallbackImage(for: url, points: points) }),
      // 마스크가 둘 다 비면 카드 배경이 남더라도 크리처가 보이는 편이 낫다.
      (.rawSource, { self.rawImage(for: url, points: points) }),
    ]
    for (source, make) in attempts {
      guard let image = make(), !Self.isEffectivelyBlank(image) else { continue }
      image.isTemplate = false
      lastMaskSource = source
      cache.setObject(image, forKey: key, cost: max(1, Int(points * points * 4)))
      return image
    }
    lastMaskSource = nil
    return nil
  }

  /// 알파가 남은 픽셀이 표본의 1%도 안 되면 마스크가 실패한 것으로 본다. 격자 표본만
  /// 보므로 그림이 커져도 비용이 일정하다.
  static func isEffectivelyBlank(_ image: NSImage, samplesPerAxis: Int = 24) -> Bool {
    var proposedRect = NSRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
    else { return true }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0 else { return true }
    var opaque = 0
    for row in 0..<samplesPerAxis {
      for column in 0..<samplesPerAxis {
        let x = bitmap.pixelsWide * column / samplesPerAxis
        let y = bitmap.pixelsHigh * row / samplesPerAxis
        if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 { opaque += 1 }
      }
    }
    return opaque * 100 < samplesPerAxis * samplesPerAxis
  }

  private func visionCutout(for url: URL, points: CGFloat) -> NSImage? {
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(url: url, options: [:])
    do {
      try handler.perform([request])
      guard let observation = request.results?.first,
            !observation.allInstances.isEmpty
      else {
        lastErrorDescription = "전경 인스턴스를 찾지 못했습니다"
        return nil
      }
      let pixelBuffer = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: true
      )
      let source = CIImage(cvPixelBuffer: pixelBuffer)
      guard let cgImage = context.createCGImage(source, from: source.extent) else {
        lastErrorDescription = "마스크를 비트맵으로 옮기지 못했습니다"
        return nil
      }
      return scaledImage(cgImage, points: points)
    } catch {
      lastErrorDescription = error.localizedDescription
      return nil
    }
  }

  private func rawImage(for url: URL, points: CGFloat) -> NSImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    return scaledImage(cgImage, points: points)
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

/// 펫 위 오른쪽 클릭 메뉴. 컨트롤러 밖의 순수 생성 함수로 두어, 실제 패널을 띄우지 않고도
/// 항목 구성과 체크마크를 검사할 수 있게 한다.
@MainActor
enum DesktopPetContextMenu {
  static let sizeHeaderTitle = "크기"
  static let hideTitle = "펫 숨기기"
  /// 펫을 숨기면 화면에서 완전히 사라진다. 다시 켜는 곳을 알려주지 않으면 되돌릴 방법을
  /// 사용자가 찾지 못한다.
  static let hideHint = "다시 켜기: 설정 → Data & Settings → 데스크톱 펫"

  static func make(
    selected: DesktopPetSize,
    target: AnyObject?,
    sizeAction: Selector,
    hideAction: Selector
  ) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false

    let header = NSMenuItem(title: sizeHeaderTitle, action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)

    for size in DesktopPetSize.allCases {
      let item = NSMenuItem(title: size.koLabel, action: sizeAction, keyEquivalent: "")
      item.target = target
      item.representedObject = size
      item.state = size == selected ? .on : .off
      item.indentationLevel = 1
      menu.addItem(item)
    }

    menu.addItem(.separator())

    let hide = NSMenuItem(title: hideTitle, action: hideAction, keyEquivalent: "")
    hide.target = target
    hide.toolTip = hideHint
    menu.addItem(hide)
    return menu
  }
}

@MainActor
final class DesktopPetController: NSObject, ObservableObject {
  static let visibilityKey = "desktopPetVisible"
  static let sizeKey = "desktopPetSize"
  static let frameAutosaveName = "PunchGrow.DesktopPet"

  @Published var isVisible: Bool {
    didSet {
      guard oldValue != isVisible else { return }
      defaults.set(isVisible, forKey: Self.visibilityKey)
      guard hasStarted else { return }
      syncVisibility()
    }
  }

  @Published var size: DesktopPetSize {
    didSet {
      guard oldValue != size else { return }
      defaults.set(size.rawValue, forKey: Self.sizeKey)
      guard hasStarted else { return }
      applySize()
    }
  }

  /// 검증용 이음새. 크기 변경이 실제 패널까지 도달했는지, 콘텐츠 뷰를 갈아 끼운 뒤에도
  /// 우클릭 메뉴가 살아 있는지 순수 함수만으로는 확인할 수 없다.
  var panelFrame: NSRect? { panel?.frame }
  var panelContentMenuTitles: [String]? { panel?.contentView?.menu?.items.map(\.title) }
  /// 크기를 바꿀 때 콘텐츠 뷰를 통째로 갈아 끼우므로, 드래그를 처리하지 않는 뷰로 바뀌면
  /// 펫을 옮길 수 없게 된다. 우클릭 메뉴와 달리 눈에 띄지 않아 더 오래 방치된다.
  var panelContentIsDraggable: Bool {
    panel?.contentView is DesktopPetDraggableContent && panel?.isMovableByWindowBackground == true
  }
  /// 크기를 바꿀 때 콘텐츠 뷰를 재사용했는지 판별하려면 값이 아니라 객체 정체성을 봐야 한다.
  var panelContentViewIdentity: ObjectIdentifier? { panel?.contentView.map(ObjectIdentifier.init) }
  /// 붙어 있는 메뉴에서 체크된 크기. 제목만 비교하면 체크마크가 옛 크기에 남아 있어도
  /// 눈치채지 못한다.
  var panelContentCheckedSizes: [DesktopPetSize]? {
    panel?.contentView?.menu?.items
      .filter { $0.state == .on }
      .compactMap { $0.representedObject as? DesktopPetSize }
  }

  private let store: GameStore
  private let defaults: UserDefaults
  /// 기본값은 실제 앱이 쓰는 이름. 검증에서는 다른 이름을 넘겨, 확인 작업이 사용자가
  /// 옮겨 둔 펫 위치를 덮어쓰지 않게 한다.
  private let frameAutosaveName: String
  private var panel: DesktopPetPanel?
  private var hasStarted = false

  init(
    store: GameStore,
    defaults: UserDefaults = .standard,
    defaultVisible: Bool = true,
    frameAutosaveName: String = DesktopPetController.frameAutosaveName
  ) {
    self.store = store
    self.defaults = defaults
    self.frameAutosaveName = frameAutosaveName
    if defaults.object(forKey: Self.visibilityKey) == nil {
      isVisible = defaultVisible
    } else {
      isVisible = defaults.bool(forKey: Self.visibilityKey)
    }
    // 알 수 없는 값이 저장돼 있어도 펫을 잃지 않고 보통으로 돌아온다.
    size = defaults.string(forKey: Self.sizeKey)
      .flatMap(DesktopPetSize.init(rawValue:)) ?? .regular
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

  /// 프리셋을 바꿨을 때의 새 프레임. 발밑 가운데를 고정점으로 삼아 펫이 서 있던 자리를
  /// 지키고, 커진 경우에도 가시영역 안으로 밀어 넣는다. 테두리도 스크롤도 없는 바탕화면
  /// 창이라 한 번 화면 밖으로 나가면 사용자가 되돌릴 방법이 없다.
  static func resizedFrame(
    from frame: NSRect,
    to size: DesktopPetSize,
    within visibleFrame: NSRect,
    margin: CGFloat = 12
  ) -> NSRect {
    let panelSize = size.panelSize
    let anchored = NSRect(
      x: frame.midX - panelSize.width / 2,
      y: frame.minY,
      width: panelSize.width,
      height: panelSize.height
    )
    return NSRect(
      origin: clampedOrigin(for: anchored, within: visibleFrame, margin: margin),
      size: panelSize
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

  /// 메뉴에서 고른 크기. 항목에 실어 둔 프리셋을 그대로 쓴다.
  @objc func selectSizeFromMenu(_ sender: NSMenuItem) {
    guard let selected = sender.representedObject as? DesktopPetSize else { return }
    size = selected
  }

  @objc func hideFromMenu(_ sender: Any?) {
    isVisible = false
  }

  func contextMenu() -> NSMenu {
    DesktopPetContextMenu.make(
      selected: size,
      target: self,
      sizeAction: #selector(selectSizeFromMenu(_:)),
      hideAction: #selector(hideFromMenu(_:))
    )
  }

  private func applySize() {
    guard isVisible, let panel else { return }
    // 콘텐츠를 먼저 갈아 끼운 뒤 크기를 바꾼다. 순서가 반대면 새 크기의 창에 이전 크기의
    // 그림이 한 프레임 그려져 화면이 튄다.
    let target = Self.resizedFrame(
      from: panel.frame, to: size, within: visibleFrame(nearest: panel.frame))
    installContentView(on: panel)
    panel.setFrame(target, display: false)
    panel.displayIfNeeded()
    panel.saveFrame(usingName: frameAutosaveName)
  }

  /// 콘텐츠 뷰를 만들거나 갱신하는 유일한 자리. 우클릭 메뉴 부착도 여기 한 곳에만 두어,
  /// 크기 변경 뒤에만 메뉴가 사라지는 결함이 생기지 않게 한다.
  private func installContentView(on panel: NSPanel) {
    // 이미 같은 뷰가 붙어 있으면 내용만 갈아 끼운다. 통째로 새로 만들면 대기 애니메이션이
    // 크기를 바꿀 때마다 처음부터 다시 시작해 펫이 한 번 튄다.
    if let existing = panel.contentView as? DesktopPetHostingView<DesktopPetView> {
      existing.rootView = DesktopPetView(store: store, size: size)
      existing.menu = contextMenu()
      return
    }
    let view = DesktopPetHostingView(rootView: DesktopPetView(store: store, size: size))
    view.menu = contextMenu()
    panel.contentView = view
  }

  private func destroyPanel() {
    guard let panel else { return }
    panel.saveFrame(usingName: frameAutosaveName)
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
      x: initialVisibleFrame.maxX - size.panelSize.width - 24,
      y: initialVisibleFrame.minY + 24,
      width: size.panelSize.width,
      height: size.panelSize.height
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
    installContentView(on: panel)

    // 저장된 프레임에는 이전 프리셋의 크기가 들어 있다. 위치만 살리고 크기는 지금 프리셋으로
    // 다시 맞춰야 프리셋마다 위치가 갈라지지 않는다.
    _ = panel.setFrameUsingName(frameAutosaveName, force: true)
    panel.setFrame(
      Self.resizedFrame(from: panel.frame, to: size, within: visibleFrame(nearest: panel.frame)),
      display: false
    )
    clampToAvailableScreen(panel)
    panel.setFrameAutosaveName(frameAutosaveName)
    return panel
  }

  /// 주어진 프레임이 가장 많이 걸쳐 있는 화면의 가시영역. 화면이 없으면 마지막으로 알려진
  /// 기본 크기를 쓴다.
  private func visibleFrame(nearest frame: NSRect) -> NSRect {
    let screens = NSScreen.screens
    guard !screens.isEmpty else { return NSRect(x: 0, y: 0, width: 1_440, height: 900) }
    let target = screens.max { lhs, rhs in
      Self.screenScore(lhs.visibleFrame, for: frame) < Self.screenScore(rhs.visibleFrame, for: frame)
    } ?? screens[0]
    return target.visibleFrame
  }

  private func clampToAvailableScreen(_ panel: NSPanel) {
    guard !NSScreen.screens.isEmpty else { return }
    let frame = panel.frame
    let origin = Self.clampedOrigin(for: frame, within: visibleFrame(nearest: frame))
    guard origin != frame.origin else { return }
    panel.setFrameOrigin(origin)
    panel.saveFrame(usingName: frameAutosaveName)
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

/// 창 배경 드래그로 펫을 옮기는 콘텐츠 뷰라는 표시.
protocol DesktopPetDraggableContent {}

private final class DesktopPetPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class DesktopPetHostingView<Content: View>: NSHostingView<Content>,
  DesktopPetDraggableContent
{
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }

  /// 활성화되지 않는 패널이라 기본 우클릭 경로를 믿을 수 없다. 직접 띄운다.
  override func rightMouseDown(with event: NSEvent) {
    guard let menu else {
      super.rightMouseDown(with: event)
      return
    }
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }
}

struct DesktopPetView: View {
  @ObservedObject var store: GameStore
  var size: DesktopPetSize = .regular
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
    return DesktopPetCutoutCache.shared.image(for: url, points: DesktopPetSize.artworkPoints)
  }

  private var reducesMotion: Bool {
    !DesktopPetMotionPolicy.allowsIdleMotion(
      appReduceEffects: reduceEffects,
      systemReduceMotion: systemReduceMotion
    )
  }

  var body: some View {
    VStack(spacing: size.scaled(8)) {
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
              .font(.system(size: size.scaled(44), weight: .semibold))
              .foregroundStyle(calm)
            Text("첫 크리처를\n뽑아 주세요")
              .font(.system(size: size.scaled(14), weight: .bold, design: .rounded))
              .multilineTextAlignment(.center)
              .foregroundStyle(.white.opacity(0.88))
          }
        }
      }
      .frame(width: size.stagePoints, height: size.stagePoints)
      .offset(y: reducesMotion ? 0 : (isFloating ? -3 : 3))

      HStack(spacing: 6) {
        Text(store.representativeCreature == nil ? "현재" : "대표")
          .foregroundStyle(fuel)
        Text(creature?.nickname ?? species?.koName ?? "PUNCHGROW")
          .lineLimit(1)
          .foregroundStyle(.white.opacity(0.92))
      }
      .font(.system(size: size.scaled(11), weight: .bold, design: .rounded))
      .shadow(color: .black.opacity(0.95), radius: 3, y: 1)
    }
    .frame(width: size.panelSize.width, height: size.panelSize.height)
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
