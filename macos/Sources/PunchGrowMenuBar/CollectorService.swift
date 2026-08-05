import Foundation
import Network
import Security

enum CollectorServiceError: LocalizedError {
    case keychain(OSStatus)
    case invalidRequest
    case unauthorized

    var errorDescription: String? {
        switch self {
        case let .keychain(status): "로컬 수집기 비밀키를 읽을 수 없습니다. (\(status))"
        case .invalidRequest: "수집기 요청 형식이 올바르지 않습니다."
        case .unauthorized: "수집기 비밀키가 일치하지 않습니다."
        }
    }
}

struct CollectorHTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    static func parse(_ data: Data) throws -> Self {
        guard data.count <= ClaudeOTLPDecoder.maximumPayloadBytes + 16_384,
              let boundary = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<boundary.lowerBound], encoding: .utf8)
        else { throw CollectorServiceError.invalidRequest }

        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.first?.split(separator: " ") ?? []
        guard requestLine.count == 3 else { throw CollectorServiceError.invalidRequest }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let separator = line.firstIndex(of: ":") else { throw CollectorServiceError.invalidRequest }
            let key = line[..<separator].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        let body = Data(data[boundary.upperBound...])
        guard let declaredLength = headers["content-length"].flatMap(Int.init), declaredLength == body.count
        else { throw CollectorServiceError.invalidRequest }
        return Self(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body)
    }
}

struct CollectorListenerGenerationGate {
    private(set) var current: UUID?

    mutating func begin() -> UUID {
        let generation = UUID()
        current = generation
        return generation
    }

    func accepts(_ generation: UUID) -> Bool { current == generation }

    @discardableResult
    mutating func finish(_ generation: UUID) -> Bool {
        guard accepts(generation) else { return false }
        current = nil
        return true
    }

    mutating func cancel() { current = nil }
}

struct CollectorSecretStore {
    private let service = "dev.punchgrow.collector"
    private let account = "local-otel-secret"

    func loadOrCreate() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            return value
        }
        guard status == errSecItemNotFound else { throw CollectorServiceError.keychain(status) }

        var bytes = [UInt8](repeating: 0, count: 32)
        let randomStatus = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard randomStatus == errSecSuccess else { throw CollectorServiceError.keychain(randomStatus) }
        let value = Data(bytes).base64EncodedString()
        let insert: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else { throw CollectorServiceError.keychain(insertStatus) }
        return value
    }
}

@MainActor
final class LocalCollectorService: ObservableObject {
    static let port: UInt16 = 4318

    @Published private(set) var isRunning = false
    @Published private(set) var lastError: String?
    @Published private(set) var setupCommand = ""
    private var listener: NWListener?
    private var listenerGate = CollectorListenerGenerationGate()
    private var secret = ""
    private let onEvents: ([TokenUsageEvent]) -> TokenIngestionResult
    private let onLifecycleState: (IntegrationStatus) -> Void

    init(
        autoStart: Bool = false,
        onLifecycleState: @escaping (IntegrationStatus) -> Void = { _ in },
        onEvents: @escaping ([TokenUsageEvent]) -> TokenIngestionResult
    ) {
        self.onLifecycleState = onLifecycleState
        self.onEvents = onEvents
        if autoStart {
            Task { @MainActor [weak self] in self?.start() }
        }
    }

    func start() {
        guard listener == nil else { return }
        do {
            secret = try CollectorSecretStore().loadOrCreate()
            setupCommand = ""
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
            let listener = try NWListener(using: parameters)
            let generation = listenerGate.begin()
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.listenerGate.accepts(generation) else { return }
                    switch state {
                    case .ready:
                        self.isRunning = true; self.lastError = nil
                        self.setupCommand = Self.command(secret: self.secret)
                        self.onLifecycleState(.listening)
                    case .failed:
                        self.listenerGate.finish(generation)
                        self.listener = nil
                        self.isRunning = false; self.setupCommand = ""
                        self.lastError = "로컬 수집기를 시작하지 못했습니다. 4318 포트 사용 여부를 확인해 주세요."
                        self.onLifecycleState(.error(self.lastError!))
                    case .cancelled:
                        self.listenerGate.finish(generation)
                        self.listener = nil
                        self.isRunning = false; self.setupCommand = ""
                        self.onLifecycleState(.stopped)
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.receive(connection, generation: generation)
            }
            listener.start(queue: DispatchQueue(label: "dev.punchgrow.collector"))
            self.listener = listener
        } catch {
            setupCommand = ""
            lastError = "로컬 수집기를 시작하지 못했습니다. Keychain 접근과 4318 포트를 확인해 주세요."
            onLifecycleState(.error(lastError!))
        }
    }

    func stop() {
        let current = listener
        listenerGate.cancel()
        listener = nil
        isRunning = false
        setupCommand = ""
        current?.cancel()
        onLifecycleState(.stopped)
    }

    private nonisolated func receive(_ connection: NWConnection, generation: UUID) {
        connection.start(queue: DispatchQueue(label: "dev.punchgrow.collector.connection"))
        receiveChunk(connection, accumulated: Data(), generation: generation)
    }

    private nonisolated func receiveChunk(_ connection: NWConnection, accumulated: Data, generation: UUID) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, error == nil else { connection.cancel(); return }
            var next = accumulated
            if let data { next.append(data) }
            guard next.count <= ClaudeOTLPDecoder.maximumPayloadBytes + 16_384 else {
                connection.cancel(); return
            }
            if Self.hasCompleteRequest(next) || complete {
                Task { @MainActor in self.handle(next, on: connection, generation: generation) }
            } else {
                self.receiveChunk(connection, accumulated: next, generation: generation)
            }
        }
    }

    private nonisolated static func hasCompleteRequest(_ data: Data) -> Bool {
        guard let boundary = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<boundary.lowerBound], encoding: .utf8)
        else { return false }
        let lengthLine = head.components(separatedBy: "\r\n").first {
            $0.lowercased().hasPrefix("content-length:")
        }
        guard let lengthLine,
              let length = Int(lengthLine.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces))
        else { return false }
        return data.count - boundary.upperBound >= length
    }

    private func handle(_ data: Data, on connection: NWConnection, generation: UUID) {
        guard listenerGate.accepts(generation), listener != nil else {
            connection.cancel()
            return
        }
        do {
            let request = try CollectorHTTPRequest.parse(data)
            guard request.method == "POST", request.path == "/v1/metrics" else {
                throw CollectorServiceError.invalidRequest
            }
            guard request.headers["authorization"] == "Bearer \(secret)" else {
                throw CollectorServiceError.unauthorized
            }
            let contentType = request.headers["content-type"]?.lowercased() ?? ""
            let events: [TokenUsageEvent]
            if contentType.contains("application/x-protobuf") {
                events = try ClaudeOTLPDecoder().decodeProtobuf(request.body)
            } else if contentType.contains("application/json") {
                events = try ClaudeOTLPDecoder().decode(request.body)
            } else { throw CollectorServiceError.invalidRequest }
            switch onEvents(events) {
            case .credited:
                lastError = nil
                respond(status: "200 OK", body: "{}", on: connection)
            case .duplicate:
                respond(status: "200 OK", body: "{}", on: connection)
            case .failed:
                lastError = TokenIngestionResult.persistenceFailureMessage
                onLifecycleState(.error(TokenIngestionResult.persistenceFailureMessage))
                respond(status: "503 Service Unavailable", body: "{}", on: connection)
            }
        } catch CollectorServiceError.unauthorized {
            lastError = CollectorServiceError.unauthorized.localizedDescription
            onLifecycleState(.error(lastError!))
            respond(status: "401 Unauthorized", body: "{}", on: connection)
        } catch {
            lastError = "수신한 Claude 토큰 지표를 해석하지 못했습니다. Claude 설정 명령을 다시 복사해 실행해 주세요."
            onLifecycleState(.error(lastError!))
            respond(status: "400 Bad Request", body: "{}", on: connection)
        }
    }

    static func command(secret: String) -> String {
        "CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=none OTEL_TRACES_EXPORTER=none OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta OTEL_METRICS_INCLUDE_SESSION_ID=false OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false OTEL_METRICS_INCLUDE_VERSION=false OTEL_METRICS_INCLUDE_ENTRYPOINT=false OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:\(port)/v1/metrics OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer \(secret)' claude"
    }

    private func respond(status: String, body: String, on connection: NWConnection) {
        let payload = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(payload.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
}
