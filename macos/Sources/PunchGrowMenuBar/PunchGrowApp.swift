import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  static var onTerminate: (() -> Void)?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
  }

  func applicationWillTerminate(_ notification: Notification) {
    Self.onTerminate?()
  }
}

@main
struct PunchGrowApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var store: GameStore
  @StateObject private var collector: LocalCollectorService
  @StateObject private var codex: CodexManagedService
  @StateObject private var localUsage: LocalUsageService
  @StateObject private var integrationStatus: IntegrationStatusProjection
  @StateObject private var originReveal: OriginRevealCoordinator

  init() {
    let integrationStatus = IntegrationStatusProjection()
    let store = GameStore(onCreditedEvent: { source, creditedAt, amount in
      integrationStatus.credited(source: source, creditedAt: creditedAt, amount: amount)
    })
    _integrationStatus = StateObject(wrappedValue: integrationStatus)
    _store = StateObject(wrappedValue: store)
    _originReveal = StateObject(wrappedValue: OriginRevealCoordinator())
    let collector = LocalCollectorService(
      autoStart: false,
      onLifecycleState: { status in Self.apply(status, source: .claude, to: integrationStatus) },
      onEvents: { _ in .duplicate }
    )
    let codex = CodexManagedService(
      onLifecycleState: { status in Self.apply(status, source: .codex, to: integrationStatus) },
      onSnapshot: { _ in .duplicate }
    )
    let localUsage = LocalUsageService(
      onObservedTotals: { [weak store] total, weekly, breakdown, quotas in
        store?.updateObservedLocalUsage(
          total: total, weekly: weekly, weeklyBreakdown: breakdown,
          quotaSnapshots: quotas
        )
      },
      onDiscoveredProviders: { providers in
        for source in [TokenProvider.claude, .codex] {
          if providers.contains(source) {
            integrationStatus.serviceDidStart(source)
          } else {
            integrationStatus.serviceDidStop(source)
          }
        }
      },
      onScanError: { message in
        integrationStatus.serviceDidFail(.claude, message: message)
        integrationStatus.serviceDidFail(.codex, message: message)
      },
      onProviderScanError: { provider, message in
        integrationStatus.serviceDidFail(provider, message: message)
      },
      onEvents: { [weak store] events in
        store?.ingestCollectedEvents(events) ?? .failed
      }
    )
    _collector = StateObject(wrappedValue: collector)
    _codex = StateObject(wrappedValue: codex)
    _localUsage = StateObject(wrappedValue: localUsage)
    localUsage.resumeIfEnabled()
    AppDelegate.onTerminate = { [weak collector, weak codex, weak localUsage] in
      collector?.stop()
      codex?.stop()
      localUsage?.shutdown()
    }
  }

  var body: some Scene {
    MenuBarExtra {
      MenuPopoverView(store: store, integrationStatus: integrationStatus, originReveal: originReveal)
    } label: {
      MenuBarStatusLabel(store: store)
    }
    .menuBarExtraStyle(.window)

    Window("PunchGrow", id: "main") {
      MainWindowView(
        store: store,
        localUsage: localUsage,
        integrationStatus: integrationStatus
      )
    }
    .defaultSize(width: 960, height: 680)

    Window("ORIGIN Reveal", id: "origin-reveal") {
      OriginRevealView(store: store, coordinator: originReveal)
    }
    .defaultSize(width: 860, height: 700)
    .windowResizability(.contentMinSize)
  }

  private static func apply(
    _ status: IntegrationStatus,
    source: TokenProvider,
    to projection: IntegrationStatusProjection
  ) {
    switch status {
    case .listening, .recentlyReceiving: projection.serviceDidStart(source)
    case .stopped: projection.serviceDidStop(source)
    case .error(let message): projection.serviceDidFail(source, message: message)
    }
  }
}
