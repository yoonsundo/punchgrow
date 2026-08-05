import Foundation

@MainActor
protocol AppCollectorStarting: AnyObject {
    func start()
}

extension LocalCollectorService: AppCollectorStarting {}

@MainActor
final class AppServiceStartPolicy {
    private var didStartCollector = false

    func startCollector(_ collector: AppCollectorStarting) {
        guard !didStartCollector else { return }
        didStartCollector = true
        collector.start()
    }
}
