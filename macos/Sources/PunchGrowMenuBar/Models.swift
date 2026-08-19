import Foundation

enum TokenProvider: String, Codable, CaseIterable, Sendable {
    case claude
    case codex
    case attendance
    case reward
}

struct TokenUsageEvent: Codable, Hashable, Sendable {
    static let maximumTokensPerEvent = 50_000_000

    let id: UUID
    let provider: TokenProvider
    let sourceEventID: String
    let occurredAt: Date
    let inputTokens: Int
    let cachedTokens: Int
    let outputTokens: Int

    var totalTokens: Int { inputTokens + cachedTokens + outputTokens }

    func validateStored() throws {
        guard !sourceEventID.isEmpty, sourceEventID.count <= 160 else {
            throw GameError.invalidUsageEvent
        }
        let values = [inputTokens, cachedTokens, outputTokens]
        guard values.allSatisfy({ $0 >= 0 && $0 <= Self.maximumTokensPerEvent }) else {
            throw GameError.invalidUsageEvent
        }
        guard totalTokens > 0, totalTokens <= Self.maximumTokensPerEvent else {
            throw GameError.invalidUsageEvent
        }
    }

    func validate(now: Date = .now) throws {
        try validateStored()
        guard occurredAt <= now.addingTimeInterval(300),
              occurredAt >= now.addingTimeInterval(-366 * 24 * 60 * 60) else {
            throw GameError.invalidUsageEvent
        }
    }
}

struct CodexCheckpoint: Codable, Equatable, Sendable {
    static let maximumCumulativeTokens = 9_000_000_000_000_000
    let inputTokens: Int
    let cachedTokens: Int
    let outputTokens: Int
}

struct CreatureSpecies: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let koName: String
    let enName: String
    let lineageId: String
    let rarity: String
    let stage: Int
    let category: String
    let bodyForm: String
    let identity: String
    let lore: String
    let evolutionFrom: [String]
    let imagePath: String

    init(
        id: String,
        koName: String,
        enName: String,
        lineageId: String = "",
        rarity: String,
        stage: Int,
        category: String,
        bodyForm: String,
        identity: String,
        lore: String,
        evolutionFrom: [String] = [],
        imagePath: String
    ) {
        self.id = id
        self.koName = koName
        self.enName = enName
        self.lineageId = lineageId
        self.rarity = rarity
        self.stage = stage
        self.category = category
        self.bodyForm = bodyForm
        self.identity = identity
        self.lore = lore
        self.evolutionFrom = evolutionFrom
        self.imagePath = imagePath
    }

    private enum CodingKeys: String, CodingKey {
        case id, koName, enName, lineageId, rarity, stage, category, bodyForm, identity, lore
        case evolutionFrom, imagePath
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        koName = try container.decode(String.self, forKey: .koName)
        enName = try container.decode(String.self, forKey: .enName)
        lineageId = try container.decode(String.self, forKey: .lineageId)
        rarity = try container.decode(String.self, forKey: .rarity)
        stage = try container.decode(Int.self, forKey: .stage)
        category = try container.decode(String.self, forKey: .category)
        bodyForm = try container.decode(String.self, forKey: .bodyForm)
        identity = try container.decode(String.self, forKey: .identity)
        lore = try container.decode(String.self, forKey: .lore)
        imagePath = try container.decode(String.self, forKey: .imagePath)
        if try container.decodeNil(forKey: .evolutionFrom) {
            evolutionFrom = []
        } else if let source = try? container.decode(String.self, forKey: .evolutionFrom) {
            evolutionFrom = [source]
        } else {
            evolutionFrom = try container.decode([String].self, forKey: .evolutionFrom)
        }
    }
}

struct OwnedCreature: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    var speciesID: String
    let originSpeciesID: String?
    var level: Int
    var experience: Int
    var affection: Int
    var nickname: String?
    /// 화면에 그릴 모습. 진화는 개체 하나가 모습을 바꾸는 것이라 과거 형태가 개체로 남지
    /// 않으므로, 지나온 모습으로 보고 싶다는 요구를 종을 되돌리지 않고 표시에서만 받는다.
    /// nil이면 실제 종을 그린다. 성장·진화 계산은 언제나 speciesID만 본다.
    ///
    /// `GameState.validate`가 이 값은 검사하지 않는다. 다른 종 참조와 달리 순수한 표시용이라,
    /// 카탈로그에서 사라진 종을 가리키게 됐다고 세이브 전체를 거부하면 잃는 것이 훨씬 크다.
    /// 대신 `GameEngine.displaySpecies`가 읽는 쪽에서 실제 종으로 되돌린다.
    var displaySpeciesID: String?
    let uniqueColor: Bool
    let acquiredAt: Date

    init(
        id: UUID,
        speciesID: String,
        originSpeciesID: String? = nil,
        level: Int,
        experience: Int,
        affection: Int,
        nickname: String?,
        displaySpeciesID: String? = nil,
        uniqueColor: Bool,
        acquiredAt: Date
    ) {
        self.id = id
        self.speciesID = speciesID
        self.originSpeciesID = originSpeciesID
        self.level = level
        self.experience = experience
        self.affection = affection
        self.nickname = nickname
        self.displaySpeciesID = displaySpeciesID
        self.uniqueColor = uniqueColor
        self.acquiredAt = acquiredAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, speciesID, originSpeciesID, level, experience, affection, nickname
        case displaySpeciesID, uniqueColor, acquiredAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        speciesID = try container.decode(String.self, forKey: .speciesID)
        originSpeciesID = try container.decodeIfPresent(String.self, forKey: .originSpeciesID)
        level = try container.decode(Int.self, forKey: .level)
        experience = try container.decode(Int.self, forKey: .experience)
        affection = try container.decode(Int.self, forKey: .affection)
        nickname = try container.decodeIfPresent(String.self, forKey: .nickname)
        displaySpeciesID = try container.decodeIfPresent(String.self, forKey: .displaySpeciesID)
        uniqueColor = try container.decode(Bool.self, forKey: .uniqueColor)
        acquiredAt = try container.decode(Date.self, forKey: .acquiredAt)
    }
}

struct EvolutionResult: Equatable, Sendable {
    let creatureID: UUID
    let fromSpeciesID: String
    let toSpeciesID: String
    let level: Int
}

/// 변이 재도전 한 번의 결과. 성공·실패 어느 쪽이든 토큰을 쓰므로 차감액을 함께 돌려준다.
struct MutationRetryOutcome: Equatable, Sendable {
    let succeeded: Bool
    /// 성공했을 때 새로 만들어진 개체. 실패하면 nil이다.
    let creatureID: UUID?
    let tokensSpent: Int
    /// 판정 뒤 해당 계보의 누적 실패 횟수. 성공하면 0이다.
    let failureCount: Int
}

/// 재도전·계승처럼 원 개체를 그대로 둔 채 **새 개체를 받아오는** 행동의 결과.
///
/// 진화가 아니라 획득이므로 `EvolutionFeedback`의 from→to 구조로는 표현되지 않는다. 두 행동 모두
/// 실패하든 성공하든 토큰을 소모하기 때문에, 결과를 알리지 않으면 잔액만 줄고 화면은 그대로여서
/// 사용자가 버튼이 먹지 않았다고 읽게 된다.
struct CreatureGrantFeedback: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case mutationRetry
        case inheritance
    }

    let id: UUID
    let kind: Kind
    let succeeded: Bool
    /// 성공해서 새로 얻은 종. 실패하면 nil이다.
    let grantedSpeciesID: String?
    let tokensSpent: Int
    /// 판정 뒤 해당 계보의 누적 실패 횟수. 천장까지 남은 거리를 보여주기 위한 값으로,
    /// 성공했거나 계승이면 0이다.
    let failureCount: Int
}

struct PendingEvolutionChoice: Identifiable, Equatable, Sendable {
    let creatureID: UUID
    let fromSpecies: CreatureSpecies
    let candidates: [CreatureSpecies]

    var id: UUID { creatureID }
}

/// 진화 순간 확률로 발동한 변이 제안. 세션 한정이며 **저장하지 않는다.**
/// 발동 시 진화를 적용하기 전에 멈추므로, 답하기 전에 앱이 죽어도 당첨이 증발하지 않고
/// 다음 급여에서 같은 지점이 다시 판정된다.
struct PendingMutationOffer: Identifiable, Equatable, Sendable {
    let creatureID: UUID
    /// 발동 시점의 현재 종(stage 1).
    let fromSpeciesID: String
    let mutationSpeciesID: String
    /// 거절하면 진행할 원래 대상. 발동 시점에 선택·예약으로 이미 확정된 값이라
    /// 해결 시점에 다시 계산하지 않는다.
    let plannedTargetSpeciesID: String

    var id: UUID { creatureID }
}

/// 급여·선택의 결과. 변이가 발동하면 진화를 적용하지 않고 `mutationOffer`만 채워 돌아온다.
struct FeedOutcome: Equatable, Sendable {
    let evolutions: [EvolutionResult]
    let mutationOffer: PendingMutationOffer?
    /// 이번 급여로 만렙에 **처음 도달한** 개체. 이미 만렙인 개체를 먹여도 다시 담기지 않아,
    /// 축전이 도달 순간에 한 번만 뜬다.
    let reachedMaximumLevelCreatureID: UUID?

    init(
        evolutions: [EvolutionResult] = [],
        mutationOffer: PendingMutationOffer? = nil,
        reachedMaximumLevelCreatureID: UUID? = nil
    ) {
        self.evolutions = evolutions
        self.mutationOffer = mutationOffer
        self.reachedMaximumLevelCreatureID = reachedMaximumLevelCreatureID
    }
}

struct EvolutionFeedback: Identifiable, Equatable, Sendable {
    let id: UUID
    let creatureID: UUID
    let fromSpeciesID: String
    let toSpeciesID: String
    let fromName: String
    let toName: String
    let rarity: String
    let stagesCrossed: Int
}

/// 비활성 동작 버튼을 눌렀을 때 알려주는 사유. 진화 토스트와 같은 자리에 잠시 떠 있다 사라진다.
struct ActionNotice: Identifiable, Equatable, Sendable {
    let id: UUID
    let message: String
}

/// 만렙(Lv.50) 도달 순간의 축전. 진화 토스트와 같은 자리에 잠시 떠 있다 사라진다.
struct MaxLevelFeedback: Identifiable, Equatable, Sendable {
    let id: UUID
    let creatureID: UUID
    /// 별명이 있으면 별명, 없으면 현재 종 이름.
    let creatureName: String
}

struct Inventory: Codable, Equatable, Sendable {
    /// 스키마 1·2에서만 쓰던 일반 먹이 수량. 현재 스키마로 옮길 때 가치 보존 변환에
    /// 소비하며, 새 세이브에는 다시 기록하지 않는다.
    var legacyNormalFood = 0
    var largeFood = 1
    var extraLargeFood = 0
    var trainingTools = 1
    var evolutionMaterials = 0

    init(
        largeFood: Int = 1,
        extraLargeFood: Int = 0,
        trainingTools: Int = 1,
        evolutionMaterials: Int = 0
    ) {
        self.largeFood = largeFood
        self.extraLargeFood = extraLargeFood
        self.trainingTools = trainingTools
        self.evolutionMaterials = evolutionMaterials
    }

    private enum CodingKeys: String, CodingKey {
        case food, largeFood, extraLargeFood, trainingTools, evolutionMaterials
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        legacyNormalFood = try container.decodeIfPresent(Int.self, forKey: .food) ?? 0
        largeFood = try container.decodeIfPresent(Int.self, forKey: .largeFood) ?? 0
        extraLargeFood = try container.decodeIfPresent(Int.self, forKey: .extraLargeFood) ?? 0
        trainingTools = try container.decodeIfPresent(Int.self, forKey: .trainingTools) ?? 1
        evolutionMaterials = try container.decodeIfPresent(Int.self, forKey: .evolutionMaterials) ?? 0
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(largeFood, forKey: .largeFood)
        try container.encode(extraLargeFood, forKey: .extraLargeFood)
        try container.encode(trainingTools, forKey: .trainingTools)
        try container.encode(evolutionMaterials, forKey: .evolutionMaterials)
    }
}

struct GameState: Codable, Equatable, Sendable {
    static let schemaVersion = 3
    static let gachaCost = 500_000
    static let legacyNormalFoodUnitCost = 100_000
    static let legacyNormalFoodPerLargeFood = 5
    static let largeFoodCost = 500_000
    static let extraLargeFoodCost = 2_500_000
    static let largeFoodExperience = 200
    static let largeFoodAffection = 10
    static let extraLargeFoodExperience = 1_000
    static let extraLargeFoodAffection = 50
    static let maximumCreatureLevel = 50
    static let originPityThreshold = 300
    static let weeklyUsageForMaximumActivityBonus = 5_000_000
    static let maximumRetainedUsageEvents = 20_000
    /// 변이 밸런스 수치는 조정 여지가 있어 한 곳에 모아 둔다. 코드·문구 어디에서도
    /// 0.1 · 1_000_000 · 30을 직접 쓰지 않는다.
    static let mutationTriggerRate = 0.1
    static let mutationRetryCost = 1_000_000
    static let mutationRetryPityThreshold = 30
    static let inheritCost = 5_000_000
    /// `validate`가 거부하는 보유 한도와 같은 값. 개체를 새로 만드는 경로는 이 선을
    /// 넘기기 전에 멈춰야 한다 — 넘기면 저장 전체가 잠긴다.
    static let maximumOwnedCreatures = 100_000

    var schemaVersion = Self.schemaVersion
    var tokenBalance = 2_000_000
    var usageEvents: [TokenUsageEvent] = []
    var creditedUsageEventKeys: Set<String> = []
    var lifetimeUsage: [TokenProvider: Int] = [:]
    var codexCheckpoints: [String: CodexCheckpoint] = [:]
    var ownedCreatures: [OwnedCreature] = []
    var discoveredSpeciesIDs: Set<String> = []
    var inventory = Inventory()
    var pullsSinceOrigin = 0
    var representativeCreatureID: UUID?
    /// 계보(시작종 id)별 변이 재도전 누적 실패 횟수.
    ///
    /// **반드시 옵셔널이어야 한다.** `GameState`는 커스텀 `init(from:)` 없이 합성 Codable을
    /// 쓰는데, 합성 디코더는 프로퍼티 기본값을 쓰지 않으므로 비옵셔널 필드를 더하면 이 키가
    /// 없는 기존 세이브가 전부 디코딩에 실패한다. `nil`은 빈 사전과 같게 다룬다.
    var mutationRetryFailures: [String: Int]?

    /// `nil`을 빈 사전으로 접어 주는 접근자. 호출부에 `?? [:]`가 흩어지지 않게 한다.
    func mutationRetryFailureCount(forOrigin originSpeciesID: String) -> Int {
        mutationRetryFailures?[originSpeciesID] ?? 0
    }

    mutating func recordMutationRetryFailure(forOrigin originSpeciesID: String) {
        var failures = mutationRetryFailures ?? [:]
        failures[originSpeciesID, default: 0] += 1
        mutationRetryFailures = failures
    }

    /// 키를 지워 0으로 되돌린다. 값이 없던 계보는 사전을 만들지 않는다.
    mutating func resetMutationRetryFailures(forOrigin originSpeciesID: String) {
        guard var failures = mutationRetryFailures, failures[originSpeciesID] != nil else { return }
        failures[originSpeciesID] = nil
        mutationRetryFailures = failures
    }

    func validate(now: Date = .now, catalogIDs: Set<String>? = nil) throws {
        guard schemaVersion == Self.schemaVersion,
              tokenBalance >= 0,
              pullsSinceOrigin >= 0,
              pullsSinceOrigin <= Self.originPityThreshold,
              usageEvents.count <= Self.maximumRetainedUsageEvents,
              creditedUsageEventKeys.count <= 1_000_000,
              codexCheckpoints.count <= 10_000,
              ownedCreatures.count <= 100_000,
              inventory.legacyNormalFood == 0,
              inventory.largeFood >= 0,
              inventory.extraLargeFood >= 0,
              inventory.trainingTools >= 0,
              inventory.evolutionMaterials >= 0
        else { throw GameError.invalidBackup }
        for event in usageEvents { try event.validateStored() }
        let usageKeys = usageEvents.map { "\($0.provider.rawValue):\($0.sourceEventID)" }
        guard Set(usageKeys).count == usageKeys.count else { throw GameError.invalidBackup }
        guard Set(usageKeys).isSubset(of: creditedUsageEventKeys),
              lifetimeUsage.values.allSatisfy({ $0 >= 0 }),
              codexCheckpoints.allSatisfy({ key, value in
                  !key.isEmpty && key.count <= 160 &&
                  [value.inputTokens, value.cachedTokens, value.outputTokens].allSatisfy { $0 >= 0 && $0 <= CodexCheckpoint.maximumCumulativeTokens }
              })
        else { throw GameError.invalidBackup }
        let ownedIDs = ownedCreatures.map(\.id)
        guard Set(ownedIDs).count == ownedIDs.count,
              ownedCreatures.allSatisfy({ $0.level >= 1 && $0.level <= 100 && $0.experience >= 0 && $0.affection >= 0 && $0.affection <= 100 })
        else { throw GameError.invalidBackup }
        if let catalogIDs {
            guard ownedCreatures.allSatisfy({ catalogIDs.contains($0.speciesID) }),
                  ownedCreatures.allSatisfy({ creature in
                      creature.originSpeciesID.map(catalogIDs.contains) ?? true
                  }),
                  discoveredSpeciesIDs.isSubset(of: catalogIDs)
            else { throw GameError.invalidBackup }
        }
    }
}

struct BackupEnvelope: Codable, Sendable {
    let format: String
    let exportedAt: Date
    let state: GameState
}

enum GameError: LocalizedError, Equatable {
    case invalidUsageEvent
    case duplicateUsageEvent
    case insufficientTokens
    case emptyCatalog
    case creatureNotFound
    case noLargeFood
    case noExtraLargeFood
    case inventoryFull
    case invalidBackup
    case invalidEvolutionChoice
    case evolutionChoiceRequired
    case creatureActionUnavailable
    case creatureLimitReached

    var errorDescription: String? {
        switch self {
        case .invalidUsageEvent: "허용되지 않은 토큰 사용량 데이터입니다."
        case .duplicateUsageEvent: "이미 반영된 사용량입니다."
        case .insufficientTokens: "필요한 토큰이 부족합니다."
        case .emptyCatalog: "크리처 카탈로그를 불러오지 못했습니다."
        case .creatureNotFound: "보유 크리처를 찾지 못했습니다."
        case .noLargeFood: "대형 먹이가 부족합니다."
        case .noExtraLargeFood: "특대형 먹이가 부족합니다."
        case .inventoryFull: "먹이 보유 한도에 도달했습니다."
        case .invalidBackup: "유효한 PunchGrow 백업 파일이 아닙니다."
        case .invalidEvolutionChoice: "지금 고를 수 없는 진화 대상입니다."
        case .evolutionChoiceRequired: "진화 방향을 먼저 선택해 주세요."
        case .creatureActionUnavailable: "지금 이 크리처로는 할 수 없는 동작입니다."
        case .creatureLimitReached: "보유 크리처 한도에 도달했습니다."
        }
    }
}
