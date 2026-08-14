import CoreGraphics

/// 132pt 포트레이트 안에서 왕관 중심이 놓일 정규화 좌표다. 체형 기본값은 256종
/// 접촉 시트를 전수 확인해 정했고, 머리가 등·꼬리·날개와 멀리 떨어진 종만 예외로 보정한다.
struct LevelMaxCrownPlacement: Equatable {
  static let crownSize = CGSize(width: 30, height: 26)
  static let displayScale: CGFloat = 0.5

  let x: CGFloat
  let y: CGFloat
  let scale: CGFloat

  init(x: CGFloat, y: CGFloat, scale: CGFloat = 1) {
    self.x = x
    self.y = y
    self.scale = scale
  }

  func point(in artworkSize: CGFloat) -> CGPoint {
    CGPoint(x: x * artworkSize, y: y * artworkSize)
  }

  func fitsInsideArtwork(ofSize artworkSize: CGFloat) -> Bool {
    let point = point(in: artworkSize)
    let scaledCrownSize = CGSize(
      width: Self.crownSize.width * scale * Self.displayScale,
      height: Self.crownSize.height * scale * Self.displayScale
    )
    return point.x >= scaledCrownSize.width / 2
      && point.x <= artworkSize - scaledCrownSize.width / 2
      && point.y >= scaledCrownSize.height / 2
      && point.y <= artworkSize - scaledCrownSize.height / 2
  }

  static func placement(for species: CreatureSpecies) -> Self {
    speciesOverrides[species.id]
      ?? bodyFormDefaults[species.bodyForm]
      // 새 체형이 추가돼도 만렙 왕관 자체가 사라지지는 않게 하고, 카탈로그 테스트가
      // 미검증 체형을 즉시 잡아 다음 릴리스 전에 전용 앵커를 정하도록 한다.
      ?? Self(x: 0.4, y: 0.175)
  }

  static func hasVerifiedBodyForm(for species: CreatureSpecies) -> Bool {
    bodyFormDefaults[species.bodyForm] != nil
  }

  static var overrideSpeciesIDs: Set<String> {
    Set(speciesOverrides.keys)
  }

  private static let bodyFormDefaults: [String: Self] = [
    "네발짐승": Self(x: 0.3, y: 0.15),
    "두발짐승": Self(x: 0.5, y: 0.1),
    "조류": Self(x: 0.45, y: 0.175),
    "수생형": Self(x: 0.375, y: 0.15),
    "곤충·기계구조체": Self(x: 0.5, y: 0.3),
    "부유 정령형": Self(x: 0.5, y: 0.175),
    "기타 무정형·식물형": Self(x: 0.5, y: 0.225),
  ]

  private static let speciesOverrides: [String: Self] = [
    // 네발짐승
    "PG-018": Self(x: 0.325, y: 0.35),
    "PG-026": Self(x: 0.425, y: 0.15),
    "PG-031": Self(x: 0.25, y: 0.275),
    "PG-037": Self(x: 0.225, y: 0.425),
    "PG-042": Self(x: 0.375, y: 0.125),
    "PG-048": Self(x: 0.225, y: 0.375),
    "PG-049": Self(x: 0.3, y: 0.3),
    "PG-061": Self(x: 0.3, y: 0.225),
    "PG-078": Self(x: 0.325, y: 0.275),
    "PG-081": Self(x: 0.425, y: 0.15),
    "PG-082": Self(x: 0.425, y: 0.15),
    "PG-083": Self(x: 0.475, y: 0.15),
    "PG-099": Self(x: 0.25, y: 0.3),
    "PG-100": Self(x: 0.25, y: 0.3),
    "PG-101": Self(x: 0.275, y: 0.3),
    "PG-126": Self(x: 0.375, y: 0.425),
    "PG-127": Self(x: 0.375, y: 0.425),
    "PG-128": Self(x: 0.375, y: 0.425),
    "PG-141": Self(x: 0.375, y: 0.175),
    "PG-147": Self(x: 0.25, y: 0.425),
    "PG-158": Self(x: 0.225, y: 0.425),
    "PG-161": Self(x: 0.225, y: 0.425),
    "PG-169": Self(x: 0.25, y: 0.4),
    "PG-171": Self(x: 0.5, y: 0.175),
    "PG-204": Self(x: 0.175, y: 0.4),
    "PG-207": Self(x: 0.375, y: 0.5),
    "PG-212": Self(x: 0.5, y: 0.2),
    "PG-232": Self(x: 0.375, y: 0.1),
    "PG-236": Self(x: 0.5, y: 0.15),
    "PG-246": Self(x: 0.4, y: 0.1),
    "PG-247": Self(x: 0.4, y: 0.1),
    "PG-248": Self(x: 0.425, y: 0.1),

    // 두발짐승
    "PG-002": Self(x: 0.4, y: 0.125),
    "PG-044": Self(x: 0.35, y: 0.325),
    "PG-053": Self(x: 0.3, y: 0.35),
    "PG-059": Self(x: 0.425, y: 0.125),
    "PG-071": Self(x: 0.4, y: 0.2),
    "PG-093": Self(x: 0.4, y: 0.175),
    "PG-094": Self(x: 0.4, y: 0.175),
    "PG-095": Self(x: 0.4, y: 0.175),
    "PG-145": Self(x: 0.3, y: 0.35),
    "PG-152": Self(x: 0.3, y: 0.4),
    "PG-162": Self(x: 0.3, y: 0.425),
    "PG-179": Self(x: 0.325, y: 0.325),
    "PG-191": Self(x: 0.425, y: 0.175),
    "PG-200": Self(x: 0.425, y: 0.15),
    "PG-214": Self(x: 0.3, y: 0.425),
    "PG-217": Self(x: 0.5, y: 0.2),

    // 수생형
    "PG-010": Self(x: 0.5, y: 0.15),
    "PG-017": Self(x: 0.5, y: 0.2),
    "PG-021": Self(x: 0.375, y: 0.275),
    "PG-033": Self(x: 0.225, y: 0.35),
    "PG-040": Self(x: 0.5, y: 0.2),
    "PG-046": Self(x: 0.225, y: 0.325),
    "PG-051": Self(x: 0.3, y: 0.35),
    "PG-057": Self(x: 0.25, y: 0.375),
    "PG-070": Self(x: 0.5, y: 0.15),
    "PG-077": Self(x: 0.5, y: 0.225),
    "PG-087": Self(x: 0.5, y: 0.175),
    "PG-088": Self(x: 0.5, y: 0.175),
    "PG-089": Self(x: 0.5, y: 0.175),
    "PG-108": Self(x: 0.25, y: 0.375),
    "PG-109": Self(x: 0.25, y: 0.375),
    "PG-110": Self(x: 0.25, y: 0.375),
    "PG-129": Self(x: 0.25, y: 0.35),
    "PG-130": Self(x: 0.25, y: 0.35),
    "PG-131": Self(x: 0.25, y: 0.35),
    "PG-143": Self(x: 0.3, y: 0.325),
    "PG-150": Self(x: 0.25, y: 0.375),
    "PG-157": Self(x: 0.275, y: 0.35),
    "PG-164": Self(x: 0.2, y: 0.35),
    "PG-170": Self(x: 0.3, y: 0.35),
    "PG-177": Self(x: 0.25, y: 0.375),
    "PG-190": Self(x: 0.5, y: 0.125),
    "PG-199": Self(x: 0.45, y: 0.2),
    "PG-202": Self(x: 0.5, y: 0.225),
    "PG-210": Self(x: 0.5, y: 0.175),
    "PG-225": Self(x: 0.5, y: 0.125),
    "PG-241": Self(x: 0.375, y: 0.225),

    // 조류
    "PG-008": Self(x: 0.35, y: 0.275),
    "PG-032": Self(x: 0.2, y: 0.3),
    "PG-038": Self(x: 0.5, y: 0.25),
    "PG-050": Self(x: 0.5, y: 0.25),
    "PG-056": Self(x: 0.25, y: 0.35),
    "PG-068": Self(x: 0.35, y: 0.225),
    "PG-084": Self(x: 0.2, y: 0.3),
    "PG-085": Self(x: 0.2, y: 0.3),
    "PG-086": Self(x: 0.2, y: 0.3),
    "PG-102": Self(x: 0.525, y: 0.15),
    "PG-103": Self(x: 0.525, y: 0.15),
    "PG-104": Self(x: 0.425, y: 0.225),
    "PG-132": Self(x: 0.5, y: 0.25),
    "PG-133": Self(x: 0.5, y: 0.25),
    "PG-134": Self(x: 0.5, y: 0.25),
    "PG-148": Self(x: 0.225, y: 0.4),
    "PG-156": Self(x: 0.5, y: 0.25),
    "PG-167": Self(x: 0.5, y: 0.25),
    "PG-176": Self(x: 0.225, y: 0.4),
    "PG-203": Self(x: 0.275, y: 0.4),
    "PG-208": Self(x: 0.5, y: 0.225),
    "PG-215": Self(x: 0.525, y: 0.125),
    "PG-223": Self(x: 0.35, y: 0.225),
    "PG-239": Self(x: 0.2, y: 0.325),
    "PG-249": Self(x: 0.5, y: 0.1),
    "PG-250": Self(x: 0.5, y: 0.1),
    "PG-251": Self(x: 0.5, y: 0.1),
    "PG-252": Self(x: 0.5, y: 0.1),

    // 곤충·기계구조체
    "PG-005": Self(x: 0.225, y: 0.35),
    "PG-014": Self(x: 0.5, y: 0.1),
    "PG-024": Self(x: 0.5, y: 0.4, scale: 0.54),
    "PG-029": Self(x: 0.2, y: 0.4),
    "PG-041": Self(x: 0.225, y: 0.4),
    "PG-047": Self(x: 0.35, y: 0.35),
    "PG-052": Self(x: 0.45, y: 0.425),
    "PG-058": Self(x: 0.275, y: 0.425),
    "PG-065": Self(x: 0.2, y: 0.4),
    "PG-074": Self(x: 0.5, y: 0.1),
    "PG-090": Self(x: 0.5, y: 0.38, scale: 0.54),
    "PG-091": Self(x: 0.5, y: 0.38, scale: 0.54),
    "PG-092": Self(x: 0.5, y: 0.38, scale: 0.54),
    "PG-138": Self(x: 0.2, y: 0.375),
    "PG-139": Self(x: 0.2, y: 0.375),
    "PG-140": Self(x: 0.175, y: 0.375),
    "PG-149": Self(x: 0.225, y: 0.35),
    "PG-151": Self(x: 0.35, y: 0.425),
    "PG-155": Self(x: 0.35, y: 0.35),
    "PG-159": Self(x: 0.3, y: 0.425),
    "PG-166": Self(x: 0.325, y: 0.35),
    "PG-172": Self(x: 0.425, y: 0.35),
    "PG-175": Self(x: 0.3, y: 0.425),
    "PG-178": Self(x: 0.2, y: 0.35),
    "PG-185": Self(x: 0.2, y: 0.4),
    "PG-194": Self(x: 0.5, y: 0.1),
    "PG-198": Self(x: 0.225, y: 0.3),
    "PG-211": Self(x: 0.2, y: 0.35),
    "PG-220": Self(x: 0.3, y: 0.375),
    "PG-229": Self(x: 0.5, y: 0.1),
    "PG-235": Self(x: 0.5, y: 0.19, scale: 0.72),

    // 부유 정령형
    "PG-023": Self(x: 0.5, y: 0.3),
    "PG-043": Self(x: 0.5, y: 0.1),
    "PG-054": Self(x: 0.4, y: 0.4),
    "PG-096": Self(x: 0.5, y: 0.275),
    "PG-097": Self(x: 0.5, y: 0.25),
    "PG-123": Self(x: 0.5, y: 0.3),
    "PG-124": Self(x: 0.5, y: 0.275),
    "PG-125": Self(x: 0.5, y: 0.25),
    "PG-146": Self(x: 0.35, y: 0.425),
    "PG-154": Self(x: 0.5, y: 0.1),
    "PG-173": Self(x: 0.5, y: 0.1),
    "PG-180": Self(x: 0.35, y: 0.4),
    "PG-201": Self(x: 0.275, y: 0.275),
    "PG-206": Self(x: 0.5, y: 0.275),
    "PG-213": Self(x: 0.5, y: 0.1),
    "PG-230": Self(x: 0.5, y: 0.25),

    // 기타 무정형·식물형
    "PG-009": Self(x: 0.5, y: 0.1),
    "PG-013": Self(x: 0.5, y: 0.1),
    "PG-020": Self(x: 0.225, y: 0.25),
    "PG-027": Self(x: 0.275, y: 0.3),
    "PG-060": Self(x: 0.5, y: 0.3),
    "PG-069": Self(x: 0.5, y: 0.1),
    "PG-073": Self(x: 0.5, y: 0.1),
    "PG-080": Self(x: 0.225, y: 0.225),
    "PG-105": Self(x: 0.275, y: 0.3),
    "PG-106": Self(x: 0.275, y: 0.3),
    "PG-107": Self(x: 0.275, y: 0.3),
    "PG-121": Self(x: 0.5, y: 0.125),
    "PG-122": Self(x: 0.5, y: 0.325),
    "PG-144": Self(x: 0.5, y: 0.4),
    "PG-168": Self(x: 0.5, y: 0.4),
    "PG-189": Self(x: 0.5, y: 0.1),
    "PG-193": Self(x: 0.5, y: 0.1),
    "PG-196": Self(x: 0.5, y: 0.1),
    "PG-224": Self(x: 0.5, y: 0.1),
    "PG-228": Self(x: 0.5, y: 0.1),
    "PG-233": Self(x: 0.225, y: 0.225),
    "PG-238": Self(x: 0.4, y: 0.3),
  ]
}
