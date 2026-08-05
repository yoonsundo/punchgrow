import Foundation

struct LocalUsageCachePersistence: Sendable {
    let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            self.fileURL = support.appending(path: "PunchGrow/local-usage-cache.json")
        }
    }

    func load() throws -> LocalUsageCache {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return LocalUsageCache()
        }
        let values = try fileURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              (values.fileSize ?? Int.max) <= 100_000_000 else {
            throw CollectorError.invalidPayload
        }
        do {
            let cache = try JSONDecoder.punchGrow.decode(LocalUsageCache.self, from: Data(contentsOf: fileURL))
            try cache.validate()
            return cache
        } catch is DecodingError {
            return LocalUsageCache()
        } catch CollectorError.invalidPayload {
            return LocalUsageCache()
        }
    }

    func save(_ cache: LocalUsageCache) throws {
        try cache.validate()
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        let data = try JSONEncoder.punchGrow.encode(cache)
        let temporary = fileURL.appendingPathExtension("tmp")
        try data.write(to: temporary, options: .atomic)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: fileURL)
        }
    }
}
