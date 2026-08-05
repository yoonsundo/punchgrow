import CryptoKit
import Foundation

enum CollectorError: Error, Equatable {
    case payloadTooLarge
    case invalidPayload
    case unsupportedMetric
}

struct ClaudeOTLPDecoder {
    static let maximumPayloadBytes = 1_000_000
    static let allowedMetric = "claude_code.token.usage"

    func decode(_ data: Data, receivedAt: Date = .now) throws -> [TokenUsageEvent] {
        guard data.count <= Self.maximumPayloadBytes else { throw CollectorError.payloadTooLarge }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let resources = root["resourceMetrics"] as? [[String: Any]] else {
            throw CollectorError.invalidPayload
        }

        var events: [TokenUsageEvent] = []
        for resource in resources {
            guard let scopes = resource["scopeMetrics"] as? [[String: Any]] else { continue }
            for scope in scopes {
                guard let metrics = scope["metrics"] as? [[String: Any]] else { continue }
                for metric in metrics where metric["name"] as? String == Self.allowedMetric {
                    guard let sum = metric["sum"] as? [String: Any],
                          let points = sum["dataPoints"] as? [[String: Any]] else { continue }
                    for (index, point) in points.enumerated() {
                        if let event = try decodePoint(point, pointIndex: index, receivedAt: receivedAt) { events.append(event) }
                    }
                }
            }
        }
        guard !events.isEmpty else { throw CollectorError.unsupportedMetric }
        return events
    }

    func decodeProtobuf(_ data: Data, receivedAt: Date = .now) throws -> [TokenUsageEvent] {
        guard data.count <= Self.maximumPayloadBytes else { throw CollectorError.payloadTooLarge }
        let root = try ProtoMessage(data)
        var events: [TokenUsageEvent] = []
        for resource in root.messages(1) {
            for scope in resource.messages(2) {
                for metric in scope.messages(2) where metric.string(1) == Self.allowedMetric {
                    for point in metric.message(7)?.messages(1) ?? [] {
                        let attributes: [String: String] = Dictionary(uniqueKeysWithValues: point.messages(7).compactMap { attribute -> (String, String)? in
                            guard let key = attribute.string(1), let value = attribute.message(2)?.string(1) else { return nil }
                            return (key, value)
                        })
                        guard let tokenType = attributes["type"] ?? attributes["token.type"] else { continue }
                        let integerCount = point.fixed64(6).flatMap { Int(exactly: $0) }
                        let doubleCount = point.fixed64(4).flatMap { bits -> Int? in
                            let value = Double(bitPattern: bits)
                            guard value.isFinite, value.rounded() == value, value > 0,
                                  value <= Double(TokenUsageEvent.maximumTokensPerEvent) else { return nil }
                            return Int(value)
                        }
                        let count = integerCount ?? doubleCount
                        guard let count, count > 0, count <= TokenUsageEvent.maximumTokensPerEvent else {
                            throw CollectorError.invalidPayload
                        }
                        let eventID = opaqueIdentifier("\(attributes["event.id"] ?? attributes["request.id"] ?? "missing"):\(tokenType):\(count):\(point.fixed64(3) ?? 0):\(events.count)")
                        events.append(TokenUsageEvent(
                            id: UUID(), provider: .claude, sourceEventID: eventID, occurredAt: receivedAt,
                            inputTokens: tokenType == "input" ? count : 0,
                            cachedTokens: ["cacheRead", "cacheCreation", "cached", "cache_read", "cache_creation"].contains(tokenType) ? count : 0,
                            outputTokens: tokenType == "output" ? count : 0
                        ))
                    }
                }
            }
        }
        guard !events.isEmpty else { throw CollectorError.unsupportedMetric }
        return events
    }

    private func decodePoint(_ point: [String: Any], pointIndex: Int, receivedAt: Date) throws -> TokenUsageEvent? {
        let attributes = (point["attributes"] as? [[String: Any]] ?? []).reduce(into: [String: String]()) {
            guard let key = $1["key"] as? String,
                  let value = $1["value"] as? [String: Any],
                  let text = value["stringValue"] as? String else { return }
            $0[key] = text
        }
        guard let tokenType = attributes["type"] ?? attributes["token.type"] else { return nil }
        let count = integerValue(point["asInt"]) ?? integerValue(point["asDouble"])
        guard let count, count > 0, count <= TokenUsageEvent.maximumTokensPerEvent else {
            throw CollectorError.invalidPayload
        }
        let requestID = attributes["event.id"] ?? attributes["request.id"] ?? "missing"
        let eventID = opaqueIdentifier(
            "\(requestID):\(tokenType):\(count):\(point["timeUnixNano"] ?? receivedAt.timeIntervalSince1970):\(pointIndex)"
        )
        return TokenUsageEvent(
            id: UUID(), provider: .claude, sourceEventID: eventID, occurredAt: receivedAt,
            inputTokens: tokenType == "input" ? count : 0,
            cachedTokens: ["cacheRead", "cacheCreation", "cached"].contains(tokenType) ? count : 0,
            outputTokens: tokenType == "output" ? count : 0
        )
    }

    private func integerValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? String { return Int(value) }
        if let value = value as? Double, value.rounded() == value { return Int(value) }
        return nil
    }
}

private struct ProtoMessage {
    private struct Field { let number: Int; let wire: Int; let value: Data }
    private let fields: [Field]

    init(_ data: Data) throws {
        var cursor = data.startIndex
        var parsed: [Field] = []
        while cursor < data.endIndex {
            let key = try Self.varint(data, cursor: &cursor)
            let number = Int(key >> 3), wire = Int(key & 7)
            guard number > 0 else { throw CollectorError.invalidPayload }
            switch wire {
            case 1:
                guard data.distance(from: cursor, to: data.endIndex) >= 8 else { throw CollectorError.invalidPayload }
                let end = data.index(cursor, offsetBy: 8); parsed.append(Field(number: number, wire: wire, value: data[cursor..<end])); cursor = end
            case 2:
                let length = try Self.varint(data, cursor: &cursor)
                guard length <= UInt64(data.distance(from: cursor, to: data.endIndex)) else { throw CollectorError.invalidPayload }
                let end = data.index(cursor, offsetBy: Int(length)); parsed.append(Field(number: number, wire: wire, value: data[cursor..<end])); cursor = end
            case 0:
                let start = cursor; _ = try Self.varint(data, cursor: &cursor); parsed.append(Field(number: number, wire: wire, value: data[start..<cursor]))
            case 5:
                guard data.distance(from: cursor, to: data.endIndex) >= 4 else { throw CollectorError.invalidPayload }
                let end = data.index(cursor, offsetBy: 4); parsed.append(Field(number: number, wire: wire, value: data[cursor..<end])); cursor = end
            default: throw CollectorError.invalidPayload
            }
        }
        fields = parsed
    }

    func messages(_ number: Int) -> [ProtoMessage] { fields.filter { $0.number == number && $0.wire == 2 }.compactMap { try? ProtoMessage($0.value) } }
    func message(_ number: Int) -> ProtoMessage? { messages(number).first }
    func string(_ number: Int) -> String? { fields.first { $0.number == number && $0.wire == 2 }.flatMap { String(data: $0.value, encoding: .utf8) } }
    func fixed64(_ number: Int) -> UInt64? {
        guard let data = fields.first(where: { $0.number == number && $0.wire == 1 })?.value, data.count == 8 else { return nil }
        return data.enumerated().reduce(0) { $0 | (UInt64($1.element) << UInt64($1.offset * 8)) }
    }

    private static func varint(_ data: Data, cursor: inout Data.Index) throws -> UInt64 {
        var result: UInt64 = 0, shift: UInt64 = 0
        while cursor < data.endIndex, shift < 64 {
            let byte = data[cursor]; cursor = data.index(after: cursor)
            result |= UInt64(byte & 0x7f) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
        }
        throw CollectorError.invalidPayload
    }
}

struct CodexTokenSnapshot: Codable, Equatable, Sendable {
    let threadID: String
    let inputTokens: Int
    let cachedTokens: Int
    let outputTokens: Int
}

struct CodexAppServerDecoder {
    func decode(_ line: Data) throws -> CodexTokenSnapshot? {
        guard line.count <= 1_000_000,
              let root = try JSONSerialization.jsonObject(with: line) as? [String: Any],
              root["method"] as? String == "thread/tokenUsage/updated",
              let params = root["params"] as? [String: Any],
              let threadID = params["threadId"] as? String,
              !threadID.isEmpty, threadID.count <= 160,
              let tokenUsage = (params["tokenUsage"] as? [String: Any]) ?? (params["usage"] as? [String: Any])
        else { return nil }

        let usage = (tokenUsage["total"] as? [String: Any]) ?? tokenUsage

        let input = boundedInt(usage["inputTokens"])
        let cachedRead = boundedInt(usage["cachedInputTokens"] ?? usage["cachedTokens"])
        let cachedWrite = boundedInt(usage["cacheWriteInputTokens"] ?? 0)
        let output = boundedInt(usage["outputTokens"])
        guard let input, let cachedRead, let cachedWrite, let output else {
            throw CollectorError.invalidPayload
        }
        let cachedSum = cachedRead.addingReportingOverflow(cachedWrite)
        guard !cachedSum.overflow,
              cachedSum.partialValue <= CodexCheckpoint.maximumCumulativeTokens else {
            throw CollectorError.invalidPayload
        }
        return CodexTokenSnapshot(
            threadID: opaqueIdentifier(threadID), inputTokens: input,
            cachedTokens: cachedSum.partialValue, outputTokens: output
        )
    }

    private func boundedInt(_ value: Any?) -> Int? {
        let result: Int?
        if let value = value as? Int { result = value }
        else if let value = value as? String { result = Int(value) }
        else { result = nil }
        guard let result, result >= 0, result <= CodexCheckpoint.maximumCumulativeTokens else { return nil }
        return result
    }
}

private func opaqueIdentifier(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

struct CodexDeltaTracker: Sendable {
    private var lastSnapshots: [String: CodexTokenSnapshot] = [:]

    mutating func event(from snapshot: CodexTokenSnapshot, at date: Date = .now) throws -> TokenUsageEvent? {
        let prior = lastSnapshots[snapshot.threadID]
        lastSnapshots[snapshot.threadID] = snapshot
        let inputResult = snapshot.inputTokens.subtractingReportingOverflow(prior?.inputTokens ?? 0)
        let cachedResult = snapshot.cachedTokens.subtractingReportingOverflow(prior?.cachedTokens ?? 0)
        let outputResult = snapshot.outputTokens.subtractingReportingOverflow(prior?.outputTokens ?? 0)
        let input = inputResult.partialValue, cached = cachedResult.partialValue, output = outputResult.partialValue
        guard !inputResult.overflow, !cachedResult.overflow, !outputResult.overflow,
              input >= 0, cached >= 0, output >= 0 else { throw CollectorError.invalidPayload }
        let subtotal = input.addingReportingOverflow(cached)
        let total = subtotal.partialValue.addingReportingOverflow(output)
        guard !subtotal.overflow, !total.overflow,
              total.partialValue <= TokenUsageEvent.maximumTokensPerEvent else { throw CollectorError.invalidPayload }
        guard total.partialValue > 0 else { return nil }
        return TokenUsageEvent(
            id: UUID(), provider: .codex,
            sourceEventID: "\(snapshot.threadID):\(snapshot.inputTokens):\(snapshot.cachedTokens):\(snapshot.outputTokens)",
            occurredAt: date, inputTokens: input, cachedTokens: cached, outputTokens: output
        )
    }
}
