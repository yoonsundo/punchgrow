import Combine
import Foundation

enum CodexPublishedFailure {
    case invalidWorkspace
    case startup
    case startupTimeout
    case protocolFailure
    case decoderFailure
    case persistence
    case unexpectedExit

    var message: String {
        switch self {
        case .invalidWorkspace: "유효한 작업 폴더를 선택해 주세요."
        case .startup: "관리형 Codex를 시작하지 못했습니다. Codex 설치와 실행 권한을 확인해 주세요."
        case .startupTimeout: "관리형 Codex 준비 시간이 초과되었습니다. 작업 폴더와 Codex 상태를 확인한 뒤 다시 시작해 주세요."
        case .protocolFailure: "관리형 Codex 통신에 실패했습니다."
        case .decoderFailure: "Codex 토큰 사용량을 읽지 못했습니다."
        case .persistence: TokenIngestionResult.persistenceFailureMessage
        case .unexpectedExit: "관리형 Codex가 예기치 않게 종료되었습니다."
        }
    }
}

@MainActor
protocol CodexTransport: AnyObject {
    var onStdout: ((Data) -> Void)? { get set }
    var onStderr: ((Data) -> Void)? { get set }
    var onExit: (() -> Void)? { get set }
    func start(executable: URL) throws
    func write(_ data: Data)
    func stop()
}

@MainActor
final class ProcessCodexTransport: CodexTransport {
    var onStdout: ((Data) -> Void)?
    var onStderr: ((Data) -> Void)?
    var onExit: (() -> Void)?
    private var process: Process?
    private var input: FileHandle?

    func start(executable: URL) throws {
        let process = Process(), stdout = Pipe(), stdin = Pipe(), stderr = Pipe()
        process.executableURL = executable
        process.arguments = ["app-server", "--stdio"]
        process.standardOutput = stdout; process.standardInput = stdin; process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.onStdout?(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.onStderr?(data) }
        }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.onExit?() } }
        try process.run()
        self.process = process
        input = stdin.fileHandleForWriting
    }

    func write(_ data: Data) { input?.write(data) }

    func stop() {
        (process?.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        (process?.standardError as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        input?.closeFile()
        if process?.isRunning == true { process?.terminate() }
        process = nil; input = nil
    }
}

@MainActor
final class CodexManagedService: ObservableObject {
    static let maximumProtocolLineBytes = 1_000_000
    static let startupTimeout: Duration = .seconds(15)
    @Published private(set) var isRunning = false
    @Published private(set) var isStarting = false
    @Published private(set) var isReady = false
    @Published private(set) var status = "중지됨"
    @Published private(set) var version = "확인 전"

    private var transport: CodexTransport?
    private var threadID: String?
    private var buffer = Data()
    private var requestID = 10
    private var generation = UUID()
    private var userRequestedStop = false
    private var startupTask: Task<Void, Never>?
    private var startupTimeoutTask: Task<Void, Never>?
    private let onSnapshot: (CodexTokenSnapshot) -> TokenIngestionResult
    private let onLifecycleState: (IntegrationStatus) -> Void
    private let makeTransport: @MainActor () -> CodexTransport
    private let prepareExecutable: @Sendable (Date) async throws -> URL

    var isActive: Bool { isStarting || isRunning }

    init(
        onLifecycleState: @escaping (IntegrationStatus) -> Void = { _ in },
        makeTransport: @escaping @MainActor () -> CodexTransport = { ProcessCodexTransport() },
        prepareExecutable: @escaping @Sendable (Date) async throws -> URL = {
            try await prepareCodexExecutable(deadline: $0)
        },
        onSnapshot: @escaping (CodexTokenSnapshot) -> TokenIngestionResult
    ) {
        self.onLifecycleState = onLifecycleState
        self.makeTransport = makeTransport
        self.prepareExecutable = prepareExecutable
        self.onSnapshot = onSnapshot
    }

    func start(workspace: String) {
        guard transport == nil, startupTask == nil else { return }
        let normalized = URL(fileURLWithPath: workspace).standardized.path
        var isDirectory: ObjCBool = false
        guard normalized.hasPrefix("/"),
              FileManager.default.fileExists(atPath: normalized, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            fail(.invalidWorkspace)
            return
        }
        let currentGeneration = UUID()
        generation = currentGeneration
        userRequestedStop = false
        isStarting = true
        isRunning = false
        isReady = false
        status = "관리형 Codex 시작 중"
        let deadline = Date().addingTimeInterval(Self.startupTimeout.timeInterval)
        startupTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.startupTimeout)
            guard !Task.isCancelled, let self, self.generation == currentGeneration,
                  self.isActive, !self.isReady else { return }
            self.startupDidTimeOut()
        }
        startupTask = Task { @MainActor [weak self, prepareExecutable] in
            do {
                let executable = try await prepareExecutable(deadline)
                try Task.checkCancellation()
                guard let self, self.generation == currentGeneration else { return }
                try self.launch(executable: executable, workspace: normalized, generation: currentGeneration)
                self.startupTask = nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.generation == currentGeneration else { return }
                self.fail(.startup)
            }
        }
    }

    func submit(_ prompt: String) {
        guard let threadID, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        requestID += 1
        send(id: requestID, method: "turn/start", params: ["threadId": threadID, "input": [["type": "text", "text": prompt]]])
        status = "Codex 작업 중"
    }

    func stop() {
        guard isActive || transport != nil || startupTask != nil else {
            status = "중지됨"
            onLifecycleState(.stopped)
            return
        }
        userRequestedStop = true
        generation = UUID()
        finishStopped()
    }

    func consume(_ data: Data) {
        guard data.count <= Self.maximumProtocolLineBytes,
              buffer.count <= Self.maximumProtocolLineBytes - data.count else {
            fail(.protocolFailure)
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0a) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            guard line.count <= Self.maximumProtocolLineBytes else {
                fail(.protocolFailure)
                return
            }
            guard let root = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                fail(.protocolFailure)
                return
            }
            if root["method"] as? String == "thread/tokenUsage/updated" {
                do {
                    if let snapshot = try CodexAppServerDecoder().decode(line) {
                        if case .failed = onSnapshot(snapshot) {
                            fail(.persistence)
                            return
                        }
                    }
                } catch {
                    fail(.decoderFailure)
                    return
                }
            }
            if root["id"] as? Int != nil, root["error"] != nil {
                fail(.protocolFailure)
                return
            }
            if (root["id"] as? Int) == 2,
               let result = root["result"] as? [String: Any],
               let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String {
                threadID = id
                isReady = true
                status = "관리형 Codex 준비됨"
                startupTimeoutTask?.cancel()
                startupTimeoutTask = nil
                onLifecycleState(.listening)
            } else if root["method"] as? String == "turn/completed" { status = "관리형 Codex 준비됨" }
        }
    }

    private func send(id: Int? = nil, method: String, params: [String: Any]) {
        var value: [String: Any] = ["method": method, "params": params]
        if let id { value["id"] = id }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else {
            fail(.protocolFailure)
            return
        }
        transport?.write(data + Data([0x0a]))
    }

    private func tearDown() {
        startupTask?.cancel()
        startupTask = nil
        startupTimeoutTask?.cancel()
        startupTimeoutTask = nil
        transport?.onStdout = nil
        transport?.onStderr = nil
        transport?.onExit = nil
        transport?.stop()
        transport = nil
        threadID = nil
        isReady = false
        buffer.removeAll()
        isStarting = false
        isRunning = false
    }

    private func finishStopped() {
        tearDown()
        status = "중지됨"
        onLifecycleState(.stopped)
    }

    func consumeStderr(_ data: Data) {
        // stderr can contain prompts, paths, source snippets, or raw protocol data.
        // It is intentionally drained without entering observable or persisted state.
        _ = data
    }

    func processDidExitUnexpectedly() {
        fail(.unexpectedExit)
    }

    func startupDidTimeOut() {
        guard isActive, !isReady else { return }
        fail(.startupTimeout)
    }

    private func launch(executable: URL, workspace: String, generation currentGeneration: UUID) throws {
        version = "확인됨"
        let transport = makeTransport()
        transport.onStdout = { [weak self] data in
            guard self?.generation == currentGeneration else { return }
            self?.consume(data)
        }
        transport.onStderr = { [weak self] data in
            guard self?.generation == currentGeneration else { return }
            self?.consumeStderr(data)
        }
        transport.onExit = { [weak self] in
            guard let self, self.generation == currentGeneration else { return }
            if self.userRequestedStop { self.finishStopped() }
            else { self.processDidExitUnexpectedly() }
        }
        self.transport = transport
        try transport.start(executable: executable)
        isStarting = false; isRunning = true
        send(id: 1, method: "initialize", params: ["clientInfo": ["name": "punchgrow", "title": "PunchGrow", "version": "0.3.0"]])
        send(method: "initialized", params: [:])
        send(id: 2, method: "thread/start", params: ["cwd": workspace, "approvalPolicy": "never", "sandbox": "workspace-write", "ephemeral": false])
    }

    private func fail(_ failure: CodexPublishedFailure) {
        generation = UUID()
        tearDown()
        status = failure.message
        onLifecycleState(.error(failure.message))
    }

}

func resolveCodexExecutable(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
    fileManager: FileManager = .default
) throws -> URL {
    let pathCandidates = (environment["PATH"] ?? "").split(separator: ":").map {
        URL(fileURLWithPath: String($0), isDirectory: true).appending(path: "codex").path
    }
    let candidates = pathCandidates + [
        homeDirectory.appending(path: "homebrew/bin/codex").path,
        homeDirectory.appending(path: ".local/bin/codex").path,
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    ]
    guard let path = candidates.first(where: { fileManager.isExecutableFile(atPath: $0) }) else {
        throw CollectorServiceError.invalidRequest
    }
    return URL(fileURLWithPath: path)
}

func prepareCodexExecutable(
    deadline: Date,
    resolver: @escaping @Sendable () throws -> URL = { try resolveCodexExecutable() }
) async throws -> URL {
    let preparation = Task.detached(priority: .userInitiated) {
        try Task.checkCancellation()
        guard Date() < deadline else { throw CollectorServiceError.invalidRequest }
        let executable = try resolver()
        guard Date() < deadline else { throw CollectorServiceError.invalidRequest }
        let verification = Process()
        verification.executableURL = executable; verification.arguments = ["--version"]
        verification.standardOutput = FileHandle.nullDevice
        verification.standardError = FileHandle.nullDevice
        try verification.run()
        while verification.isRunning {
            if Task.isCancelled || Date() >= deadline {
                verification.terminate()
                throw Task.isCancelled ? CancellationError() : CollectorServiceError.invalidRequest
            }
            do {
                try await Task.sleep(for: .milliseconds(10))
            } catch {
                if verification.isRunning { verification.terminate() }
                throw error
            }
        }
        guard verification.terminationStatus == 0 else {
            throw CollectorServiceError.invalidRequest
        }
        return executable
    }
    return try await withTaskCancellationHandler {
        try await preparation.value
    } onCancel: {
        preparation.cancel()
    }
}

private extension Duration {
    var timeInterval: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
