import Foundation

enum CreatureCatalog {
    static func load(bundle: Bundle = .module) throws -> [CreatureSpecies] {
        guard let url = bundle.url(forResource: "creatures", withExtension: "json") else {
            throw GameError.emptyCatalog
        }
        let decoded = try JSONDecoder().decode([CreatureSpecies].self, from: Data(contentsOf: url))
        guard decoded.count == 240, Set(decoded.map(\.id)).count == 240 else {
            throw GameError.emptyCatalog
        }
        return decoded
    }
}
