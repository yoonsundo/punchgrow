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
        self.uniqueColor = uniqueColor
        self.acquiredAt = acquiredAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, speciesID, originSpeciesID, level, experience, affection, nickname
        case uniqueColor, acquiredAt
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

struct Inventory: Codable, Equatable, Sendable {
    var food = 5
    var largeFood = 0
    var trainingTools = 1
    var evolutionMaterials = 0

    init(food: Int = 5, largeFood: Int = 0, trainingTools: Int = 1, evolutionMaterials: Int = 0) {
        self.food = food
        self.largeFood = largeFood
        self.trainingTools = trainingTools
        self.evolutionMaterials = evolutionMaterials
    }

    private enum CodingKeys: String, CodingKey {
        case food, largeFood, trainingTools, evolutionMaterials
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        food = try container.decodeIfPresent(Int.self, forKey: .food) ?? 5
        largeFood = try container.decodeIfPresent(Int.self, forKey: .largeFood) ?? 0
        trainingTools = try container.decodeIfPresent(Int.self, forKey: .trainingTools) ?? 1
        evolutionMaterials = try container.decodeIfPresent(Int.self, forKey: .evolutionMaterials) ?? 0
    }
}

struct GameState: Codable, Equatable, Sendable {
    static let schemaVersion = 2
    static let gachaCost = 500_000
    static let foodCost = 100_000
    static let largeFoodCost = 500_000
    static let maximumCreatureLevel = 50
    static let originPityThreshold = 300
    static let weeklyUsageForMaximumActivityBonus = 5_000_000
    static let maximumRetainedUsageEvents = 20_000

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

    func validate(now: Date = .now, catalogIDs: Set<String>? = nil) throws {
        guard schemaVersion == Self.schemaVersion,
              tokenBalance >= 0,
              pullsSinceOrigin >= 0,
              pullsSinceOrigin <= Self.originPityThreshold,
              usageEvents.count <= Self.maximumRetainedUsageEvents,
              creditedUsageEventKeys.count <= 1_000_000,
              codexCheckpoints.count <= 10_000,
              ownedCreatures.count <= 100_000,
              inventory.food >= 0,
              inventory.largeFood >= 0,
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
    case noFood
    case noLargeFood
    case inventoryFull
    case invalidBackup

    var errorDescription: String? {
        switch self {
        case .invalidUsageEvent: "허용되지 않은 토큰 사용량 데이터입니다."
        case .duplicateUsageEvent: "이미 반영된 사용량입니다."
        case .insufficientTokens: "필요한 토큰이 부족합니다."
        case .emptyCatalog: "크리처 카탈로그를 불러오지 못했습니다."
        case .creatureNotFound: "보유 크리처를 찾지 못했습니다."
        case .noFood: "먹이가 부족합니다."
        case .noLargeFood: "대형 먹이가 부족합니다."
        case .inventoryFull: "먹이 보유 한도에 도달했습니다."
        case .invalidBackup: "유효한 PunchGrow 백업 파일이 아닙니다."
        }
    }
}
