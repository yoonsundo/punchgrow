import Foundation
import Security

/// Reads the Claude weekly plan utilization straight from the provider.
///
/// The on-disk usage cache that `LocalUsageScanner` falls back to is written by Claude Code's
/// status line, so it only moves while that process happens to render — in practice it can trail
/// the provider's own usage screen by fifteen minutes or more. Asking the endpoint ourselves keeps
/// the percentage in step with what the user sees there.
///
/// Credentials are read but never written: Claude Code owns the refresh cycle, and racing it would
/// risk invalidating the session. An expired or missing token is treated as "no live value", which
/// leaves the cached file reading in place.
struct ClaudeUsageAPIClient: Sendable {
    /// Long enough to ride out a slow response, short enough that a hung request cannot outlive the
    /// scan interval that schedules it.
    static let defaultTimeout: TimeInterval = 10

    private static let dateParser = LockedISO8601Parser()

    private let endpoint: URL
    private let keychainService: String
    private let credentialsURL: URL
    private let timeout: TimeInterval
    private let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    init(
        endpoint: URL = URL(string: "https://api.anthropic.com/api/oauth/usage")!,
        keychainService: String = "Claude Code-credentials",
        credentialsURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".claude/.credentials.json"),
        timeout: TimeInterval = ClaudeUsageAPIClient.defaultTimeout,
        transport: (@Sendable (URLRequest) async throws -> (Data, URLResponse))? = nil
    ) {
        self.endpoint = endpoint
        self.keychainService = keychainService
        self.credentialsURL = credentialsURL
        self.timeout = timeout
        if let transport {
            self.transport = transport
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = timeout
            configuration.waitsForConnectivity = false
            let session = URLSession(configuration: configuration)
            self.transport = { try await session.data(for: $0) }
        }
    }

    /// Returns the current weekly utilization, or `nil` when no live reading is available.
    ///
    /// Every failure path — no credentials, expired token, network error, unexpected status,
    /// malformed body — collapses to `nil` so the caller can fall back to the cached reading
    /// instead of surfacing a transient outage as a usage change.
    func fetchWeeklyQuota(now: Date = .now) async -> ProviderQuotaSnapshot? {
        guard let token = loadAccessToken(now: now) else { return nil }
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        guard let (data, response) = try? await transport(request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let payload = try? JSONDecoder().decode(UsageResponse.self, from: data),
              let utilization = payload.sevenDay?.utilization,
              utilization >= 0, utilization <= 100 else {
            return nil
        }
        return ProviderQuotaSnapshot(
            usedPercent: utilization,
            resetsAt: payload.sevenDay?.resetsAt.flatMap(Self.dateParser.parse),
            observedAt: now
        )
    }

    // MARK: - Credentials

    /// Keychain first — that is the copy Claude Code keeps refreshed. The file is only consulted
    /// when the Keychain lookup yields nothing, which is the case on machines where credentials
    /// were written before the Keychain migration.
    private func loadAccessToken(now: Date) -> String? {
        keychainCredentials().flatMap { unexpiredToken($0, now: now) }
            ?? fileCredentials().flatMap { unexpiredToken($0, now: now) }
    }

    private func unexpiredToken(_ credentials: StoredCredentials, now: Date) -> String? {
        guard let oauth = credentials.claudeAiOauth,
              let token = oauth.accessToken, !token.isEmpty else { return nil }
        // `expiresAt` is milliseconds since epoch. Treat a missing value as usable and let the
        // endpoint reject it, but skip a token we already know is dead to avoid a pointless round trip.
        if let expiresAt = oauth.expiresAt,
           Date(timeIntervalSince1970: expiresAt / 1_000) <= now {
            return nil
        }
        return token
    }

    private func keychainCredentials() -> StoredCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(StoredCredentials.self, from: data)
    }

    private func fileCredentials() -> StoredCredentials? {
        guard let data = try? Data(contentsOf: credentialsURL) else { return nil }
        return try? JSONDecoder().decode(StoredCredentials.self, from: data)
    }

    // MARK: - Wire formats

    private struct StoredCredentials: Decodable {
        let claudeAiOauth: OAuth?

        struct OAuth: Decodable {
            let accessToken: String?
            let expiresAt: Double?
        }
    }

    private struct UsageResponse: Decodable {
        let sevenDay: Window?

        enum CodingKeys: String, CodingKey {
            case sevenDay = "seven_day"
        }

        struct Window: Decodable {
            let utilization: Double?
            let resetsAt: String?

            enum CodingKeys: String, CodingKey {
                case utilization
                case resetsAt = "resets_at"
            }
        }
    }
}
