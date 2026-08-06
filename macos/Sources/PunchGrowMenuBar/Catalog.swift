import Foundation

enum CreatureCatalog {
    static func load(bundle: Bundle = .module) throws -> [CreatureSpecies] {
        guard let url = bundle.url(forResource: "creatures", withExtension: "json") else {
            throw GameError.emptyCatalog
        }
        let decoded = try JSONDecoder().decode([CreatureSpecies].self, from: Data(contentsOf: url))
        try validateBundled(decoded)
        return decoded
    }

    static func decodeAndValidateBundled(_ data: Data) throws -> [CreatureSpecies] {
        let decoded = try JSONDecoder().decode([CreatureSpecies].self, from: data)
        try validateBundled(decoded)
        return decoded
    }

    static func validateBundled(_ catalog: [CreatureSpecies]) throws {
        guard catalog.count == 240,
              Set(catalog.map(\.id)).count == 240,
              catalog.allSatisfy({ matches($0.id, pattern: #"PG-\d{3}"#) }),
              catalog.filter({ $0.category == "start" }).count == 60,
              Set(catalog.filter({ $0.category == "start" }).map(\.id)).count == 60
        else { throw GameError.emptyCatalog }
        let speciesByID = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })

        let validCategories = Set(["normal_evolution", "branch", "mixed", "special", "mutant"])
        for species in catalog {
            guard !species.lineageId.isEmpty else { throw GameError.emptyCatalog }
            if species.category == "start" {
                guard species.stage == 1, species.evolutionFrom.isEmpty else {
                    throw GameError.emptyCatalog
                }
            } else {
                guard validCategories.contains(species.category),
                      (2...4).contains(species.stage),
                      !species.evolutionFrom.isEmpty
                else { throw GameError.emptyCatalog }
            }

            for source in species.evolutionFrom {
                if matches(source, pattern: #"PG-\d{3}"#) {
                    guard let sourceSpecies = speciesByID[source], sourceSpecies.stage < species.stage else {
                        throw GameError.emptyCatalog
                    }
                } else if let reference = lineageStageReference(source) {
                    guard reference.stage < species.stage,
                          catalog.contains(where: {
                              $0.lineageId == reference.lineageId && $0.stage == reference.stage
                          })
                    else { throw GameError.emptyCatalog }
                } else {
                    throw GameError.emptyCatalog
                }
            }
        }
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: "^(?:\(pattern))$", options: .regularExpression) != nil
    }

    private static func lineageStageReference(_ value: String) -> (lineageId: String, stage: Int)? {
        guard matches(value, pattern: #"PG-L\d{3}:S[1-3]"#),
              let separator = value.lastIndex(of: ":"),
              let stage = Int(value[value.index(separator, offsetBy: 2)...])
        else { return nil }
        return (String(value[..<separator]), stage)
    }
}
