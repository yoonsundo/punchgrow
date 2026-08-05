import Foundation

struct GamePersistence: Sendable {
    let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.fileURL = support.appending(path: "PunchGrow/state.json")
    }

    func load() throws -> GameState {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return GameState() }
        let data = try Data(contentsOf: fileURL)
        let version = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["schemaVersion"] as? Int
        if version == 1 {
            let migrated = try JSONDecoder.punchGrow.decode(LegacyGameStateV1.self, from: data).migrated()
            try migrated.validate()
            return migrated
        }
        let state = try JSONDecoder.punchGrow.decode(GameState.self, from: data)
        try state.validate()
        return state
    }

    func requiresMigrationCommit() throws -> Bool {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return false }
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
        return root?["schemaVersion"] as? Int == 1
    }

    func save(_ state: GameState) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        let data = try JSONEncoder.punchGrow.encode(state)
        let temporary = fileURL.appendingPathExtension("tmp")
        try data.write(to: temporary, options: .atomic)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: fileURL)
        }
    }

    func export(_ state: GameState, to destination: URL) throws {
        let envelope = BackupEnvelope(format: "punchgrow-backup-v1", exportedAt: .now, state: state)
        try JSONEncoder.punchGrow.encode(envelope).write(to: destination, options: .atomic)
    }

    func restore(from source: URL) throws -> GameState {
        let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 20_000_000 else {
            throw GameError.invalidBackup
        }
        let envelope = try JSONDecoder.punchGrow.decode(BackupEnvelope.self, from: Data(contentsOf: source))
        guard envelope.format == "punchgrow-backup-v1" else {
            throw GameError.invalidBackup
        }
        let state = envelope.state
        try state.validate()
        return state
    }
}

private struct LegacyOwnedCreatureV1: Codable {
    let id: UUID
    let speciesID: String
    var level: Int
    var experience: Int
    var affection: Int
    var nickname: String?
    let acquiredAt: Date
}

private struct LegacyGameStateV1: Codable {
    let schemaVersion: Int
    var tokenBalance: Int
    var usageEvents: [TokenUsageEvent]
    var ownedCreatures: [LegacyOwnedCreatureV1]
    var discoveredSpeciesIDs: Set<String>
    var inventory: Inventory
    var pullsSinceOrigin: Int
    var representativeCreatureID: UUID?

    func migrated() throws -> GameState {
        guard schemaVersion == 1 else { throw GameError.invalidBackup }
        for event in usageEvents { try event.validateStored() }
        let keys = Set(usageEvents.map { "\($0.provider.rawValue):\($0.sourceEventID)" })
        var totals: [TokenProvider: Int] = [:]
        for event in usageEvents {
            let addition = totals[event.provider, default: 0].addingReportingOverflow(event.totalTokens)
            guard !addition.overflow else { throw GameError.invalidBackup }
            totals[event.provider] = addition.partialValue
        }
        return GameState(
            schemaVersion: GameState.schemaVersion,
            tokenBalance: tokenBalance,
            usageEvents: Array(usageEvents.suffix(GameState.maximumRetainedUsageEvents)),
            creditedUsageEventKeys: keys,
            lifetimeUsage: totals,
            codexCheckpoints: [:],
            ownedCreatures: ownedCreatures.map {
                OwnedCreature(id: $0.id, speciesID: $0.speciesID, level: $0.level, experience: $0.experience, affection: $0.affection, nickname: $0.nickname, uniqueColor: false, acquiredAt: $0.acquiredAt)
            },
            discoveredSpeciesIDs: discoveredSpeciesIDs,
            inventory: inventory,
            pullsSinceOrigin: pullsSinceOrigin,
            representativeCreatureID: representativeCreatureID
        )
    }
}

extension JSONEncoder {
    static var punchGrow: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var punchGrow: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
