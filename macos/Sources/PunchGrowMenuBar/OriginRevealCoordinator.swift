import Combine
import Foundation

struct OriginRevealRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let creatureID: UUID
    let generation: Int
}

struct OriginWindowCommand: Equatable, Sendable {
    let windowID: String
    let requestID: UUID
}

struct OriginRevealOutcome: Equatable, Sendable {
    let request: OriginRevealRequest
    let windowCommand: OriginWindowCommand
}

enum OriginRevealTransitionCommand: Equatable, Sendable {
    case dismissWindow(String)
    case openPopup
}

struct OriginRevealTransitionState: Equatable, Sendable {
    let requestID: UUID
    private(set) var phase: OriginRevealPhase = .gathering

    mutating func begin(reduceMotion: Bool) {
        phase = reduceMotion ? .revealed : .gathering
    }

    mutating func complete(_ path: OriginRevealPath) {
        phase = path.completedPhase
    }

    func dismiss() -> [OriginRevealTransitionCommand] {
        [.dismissWindow("origin-reveal")]
    }
}

struct OriginRevealPresentation: Equatable {
    let request: OriginRevealRequest
    let creature: OwnedCreature
    let species: CreatureSpecies

    init?(request: OriginRevealRequest?, state: GameState, catalog: [CreatureSpecies]) {
        guard let request,
              let creature = state.ownedCreatures.first(where: { $0.id == request.creatureID }),
              let species = catalog.first(where: { $0.id == creature.speciesID }),
              species.rarity.uppercased() == "ORIGIN" else { return nil }
        self.request = request
        self.creature = creature
        self.species = species
    }
}

@MainActor
final class OriginRevealCoordinator: ObservableObject {
    @Published private(set) var currentRequest: OriginRevealRequest?
    @Published private(set) var lastWindowCommand: OriginWindowCommand?
    private(set) var issuedWindowCommandCount = 0
    private var generation = 0

    @discardableResult
    func requestReveal(for creature: OwnedCreature, species: CreatureSpecies) -> OriginRevealOutcome? {
        guard species.rarity.uppercased() == "ORIGIN" else { return nil }
        generation += 1
        let request = OriginRevealRequest(id: UUID(), creatureID: creature.id, generation: generation)
        let command = OriginWindowCommand(windowID: "origin-reveal", requestID: request.id)
        currentRequest = request
        issuedWindowCommandCount += 1
        lastWindowCommand = command
        return OriginRevealOutcome(request: request, windowCommand: command)
    }

    func windowDidClose(requestID: UUID) {
        guard currentRequest?.id == requestID else { return }
        // Closing is presentation-only. Keep the request as the next manual window target.
    }
}
