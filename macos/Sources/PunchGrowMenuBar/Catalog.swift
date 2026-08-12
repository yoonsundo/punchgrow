import Foundation

enum CreatureCatalog {
    private static let expectedSpeciesCount = 256
    private static let expectedStartCount = 64

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
        guard catalog.count == expectedSpeciesCount,
              Set(catalog.map(\.id)).count == expectedSpeciesCount,
              catalog.allSatisfy({ matches($0.id, pattern: #"PG-\d{3}"#) }),
              catalog.filter({ $0.category == "start" }).count == expectedStartCount,
              Set(catalog.filter({ $0.category == "start" }).map(\.id)).count == expectedStartCount
        else { throw GameError.emptyCatalog }
        try validateEvolutionGraph(catalog)
    }

    static func validateEvolutionGraph(_ catalog: [CreatureSpecies]) throws {
        guard Set(catalog.map(\.id)).count == catalog.count else {
            throw GameError.emptyCatalog
        }
        let speciesByID = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })

        let validCategories = Set(["normal_evolution", "branch", "mixed", "special", "mutant"])
        var parentIDsBySpeciesID: [String: [String]] = [:]
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

            let expectedParentCount = species.category == "start"
                ? 0
                : (species.category == "mixed" ? 2 : 1)
            guard species.evolutionFrom.count == expectedParentCount else {
                throw GameError.emptyCatalog
            }

            var resolvedParentIDs: [String] = []
            for source in species.evolutionFrom {
                let parents = resolvedSpecies(for: source, in: catalog, speciesByID: speciesByID)
                guard parents.count == 1, let parent = parents.first,
                      parent.stage == species.stage - 1
                else {
                    throw GameError.emptyCatalog
                }
                resolvedParentIDs.append(parent.id)

                if species.category == "normal_evolution",
                   parent.lineageId != species.lineageId {
                    throw GameError.emptyCatalog
                }
                if species.category != "mixed",
                   parent.bodyForm != species.bodyForm {
                    throw GameError.emptyCatalog
                }
            }
            guard Set(resolvedParentIDs).count == resolvedParentIDs.count else {
                throw GameError.emptyCatalog
            }
            parentIDsBySpeciesID[species.id] = resolvedParentIDs
        }

        guard isAcyclic(parentIDsBySpeciesID),
              catalog.allSatisfy({ reachesStart($0.id, parents: parentIDsBySpeciesID, speciesByID: speciesByID) })
        else { throw GameError.emptyCatalog }
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

    private static func resolvedSpecies(
        for reference: String,
        in catalog: [CreatureSpecies],
        speciesByID: [String: CreatureSpecies]
    ) -> [CreatureSpecies] {
        if matches(reference, pattern: #"PG-\d{3}"#) {
            return speciesByID[reference].map { [$0] } ?? []
        }
        guard let reference = lineageStageReference(reference) else { return [] }
        return catalog.filter {
            $0.lineageId == reference.lineageId && $0.stage == reference.stage
        }
    }

    private static func isAcyclic(_ parents: [String: [String]]) -> Bool {
        enum VisitState { case visiting, visited }
        var states: [String: VisitState] = [:]

        func visit(_ speciesID: String) -> Bool {
            switch states[speciesID] {
            case .visiting: return false
            case .visited: return true
            case nil: break
            }
            states[speciesID] = .visiting
            guard parents[speciesID, default: []].allSatisfy(visit) else { return false }
            states[speciesID] = .visited
            return true
        }

        return parents.keys.allSatisfy(visit)
    }

    private static func reachesStart(
        _ speciesID: String,
        parents: [String: [String]],
        speciesByID: [String: CreatureSpecies]
    ) -> Bool {
        guard let species = speciesByID[speciesID] else { return false }
        if species.category == "start" { return true }
        let parentIDs = parents[speciesID, default: []]
        return !parentIDs.isEmpty && parentIDs.allSatisfy {
            reachesStart($0, parents: parents, speciesByID: speciesByID)
        }
    }
}
