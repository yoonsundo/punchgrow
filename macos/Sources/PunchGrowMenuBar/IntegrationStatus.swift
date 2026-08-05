import Combine
import Foundation

enum IntegrationStatus: Equatable, Sendable {
    case stopped
    case listening
    case recentlyReceiving
    case error(String)
}

protocol IntegrationStatusCancellation: AnyObject {
    func cancel()
}

@MainActor
protocol IntegrationStatusScheduling {
    func schedule(at date: Date, action: @escaping @MainActor () -> Void) -> IntegrationStatusCancellation
}

private final class DispatchIntegrationStatusCancellation: IntegrationStatusCancellation {
    private let item: DispatchWorkItem

    init(item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
}

@MainActor
struct DispatchIntegrationStatusScheduler: IntegrationStatusScheduling {
    private let now: () -> Date

    init(now: @escaping () -> Date = { .now }) { self.now = now }

    func schedule(at date: Date, action: @escaping @MainActor () -> Void) -> IntegrationStatusCancellation {
        let item = DispatchWorkItem { Task { @MainActor in action() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, date.timeIntervalSince(now())), execute: item)
        return DispatchIntegrationStatusCancellation(item: item)
    }
}

@MainActor
final class IntegrationStatusProjection: ObservableObject {
    static let recentDuration: TimeInterval = 10

    @Published private(set) var statuses: [TokenProvider: IntegrationStatus] = [:]

    private struct SourceState {
        var running = false
        var error: String?
        var recentUntil: Date?
        var generation = 0
        var expiry: IntegrationStatusCancellation?
    }

    private let now: () -> Date
    private let scheduler: IntegrationStatusScheduling
    private var sources: [TokenProvider: SourceState] = [:]

    init(
        now: @escaping () -> Date = { .now },
        scheduler: IntegrationStatusScheduling? = nil
    ) {
        self.now = now
        self.scheduler = scheduler ?? DispatchIntegrationStatusScheduler(now: now)
        statuses[.claude] = .stopped
        statuses[.codex] = .stopped
    }

    func status(for source: TokenProvider) -> IntegrationStatus {
        statuses[source] ?? .stopped
    }

    func serviceDidStart(_ source: TokenProvider) {
        update(source) { value in
            value.running = true
            value.error = nil
        }
    }

    func serviceDidStop(_ source: TokenProvider) {
        update(source) { value in
            value.running = false
            value.error = nil
            value.recentUntil = nil
            value.expiry?.cancel()
            value.expiry = nil
            value.generation += 1
        }
    }

    func serviceDidFail(_ source: TokenProvider, message: String) {
        update(source) { value in
            value.running = false
            value.error = message
            value.recentUntil = nil
            value.expiry?.cancel()
            value.expiry = nil
            value.generation += 1
        }
    }

    func credited(source: TokenProvider, creditedAt: Date, amount: Int) {
        guard amount > 0 else { return }
        var value = sources[source] ?? SourceState()
        value.expiry?.cancel()
        value.running = true
        value.error = nil
        value.generation += 1
        let deadline = creditedAt.addingTimeInterval(Self.recentDuration)
        value.recentUntil = deadline
        let generation = value.generation
        value.expiry = scheduler.schedule(at: deadline) { [weak self] in
            self?.expireRecent(source: source, generation: generation, deadline: deadline)
        }
        sources[source] = value
        publish(source)
    }

    private func expireRecent(source: TokenProvider, generation: Int, deadline: Date) {
        guard var value = sources[source], value.generation == generation,
              value.recentUntil == deadline, now() >= deadline else { return }
        value.recentUntil = nil
        value.expiry = nil
        sources[source] = value
        publish(source)
    }

    private func update(_ source: TokenProvider, mutation: (inout SourceState) -> Void) {
        var value = sources[source] ?? SourceState()
        mutation(&value)
        sources[source] = value
        publish(source)
    }

    private func publish(_ source: TokenProvider) {
        let value = sources[source] ?? SourceState()
        let status: IntegrationStatus
        if let error = value.error {
            status = .error(error)
        } else if !value.running {
            status = .stopped
        } else if let recentUntil = value.recentUntil, now() < recentUntil {
            status = .recentlyReceiving
        } else {
            status = .listening
        }
        statuses[source] = status
    }
}
