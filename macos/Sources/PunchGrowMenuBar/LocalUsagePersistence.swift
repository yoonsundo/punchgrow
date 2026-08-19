import Foundation

struct LocalUsageCachePersistence: Sendable {
    private static let maximumCacheByteCount = 100_000_000
    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }
    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    let fileURL: URL
    private let readAnchorURL: URL
    private let readComponents: [String]
    private let managesFilePermissions: Bool

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            readAnchorURL = fileURL.deletingLastPathComponent()
            readComponents = [fileURL.lastPathComponent]
            managesFilePermissions = false
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            self.fileURL = support.appending(path: "PunchGrow/local-usage-cache.json")
            readAnchorURL = support
            readComponents = ["PunchGrow", "local-usage-cache.json"]
            managesFilePermissions = true
        }
    }

    init(managedStorageAnchorURL: URL) {
        fileURL = managedStorageAnchorURL.appending(path: "PunchGrow/local-usage-cache.json")
        readAnchorURL = managedStorageAnchorURL
        readComponents = ["PunchGrow", "local-usage-cache.json"]
        managesFilePermissions = true
    }

    func load() throws -> LocalUsageCache {
        let file: NoFollowRegularFile
        do {
            guard let opened = try openCacheFileIfExists() else { return LocalUsageCache() }
            file = opened
        } catch {
            throw CollectorError.invalidPayload
        }
        let data: Data
        do {
            data = try file.readAll(maximumByteCount: Self.maximumCacheByteCount)
        } catch {
            throw CollectorError.invalidPayload
        }
        do {
            let cache: LocalUsageCache
            do {
                cache = try Self.decoder.decode(LocalUsageCache.self, from: data)
            } catch is DecodingError {
                cache = try JSONDecoder.punchGrow.decode(LocalUsageCache.self, from: data)
            }
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
        let data = try Self.encoder.encode(cache)
        if !managesFilePermissions {
            let directory = try NoFollowDirectory.open(readAnchorURL)
            try directory.atomicWrite(data, fileName: readComponents[0])
        } else {
            let anchor = try NoFollowDirectory.open(readAnchorURL)
            let directory = try anchor.openOrCreateDirectory(
                components: Array(readComponents.dropLast())
            )
            try directory.atomicWrite(data, fileName: readComponents.last!)
        }
    }

    func migrateManagedPermissionsIfPresent() {
        guard managesFilePermissions else { return }
        try? migrateManagedPermissions()
    }

    func delete() throws {
        let directory: NoFollowDirectory
        if managesFilePermissions {
            guard let anchor = try NoFollowDirectory.openIfExists(readAnchorURL),
                  let opened = try anchor.openDirectoryIfExists(
                    components: Array(readComponents.dropLast())
                  ) else { return }
            try opened.restrictPermissions(to: 0o700)
            directory = opened
        } else {
            guard let opened = try NoFollowDirectory.openIfExists(readAnchorURL) else { return }
            directory = opened
        }
        let fileName = readComponents.last!
        try directory.removeRegularFilesIfExists(
            fileNames: [fileName, "\(fileName).tmp"],
            generatedByAtomicWriteFor: [fileName]
        )
    }

    private func openCacheFileIfExists() throws -> NoFollowRegularFile? {
        guard let anchor = try NoFollowDirectory.openIfExists(readAnchorURL) else {
            return nil
        }
        guard managesFilePermissions else {
            return try anchor.openFileIfExists(
                components: readComponents,
                maximumByteCount: Self.maximumCacheByteCount
            )
        }
        guard let directory = try anchor.openDirectoryIfExists(
            components: Array(readComponents.dropLast())
        ) else { return nil }
        try directory.restrictPermissions(to: 0o700)
        guard let file = try directory.openFileIfExists(
            components: [readComponents.last!],
            maximumByteCount: Self.maximumCacheByteCount
        ) else { return nil }
        try file.restrictPermissions(to: 0o600)
        return file
    }

    private func migrateManagedPermissions() throws {
        guard let anchor = try NoFollowDirectory.openIfExists(readAnchorURL),
              let directory = try anchor.openDirectoryIfExists(
                components: Array(readComponents.dropLast())
              ) else { return }
        try directory.restrictPermissions(to: 0o700)
        guard let file = try directory.openFileIfExists(
            components: [readComponents.last!], maximumByteCount: Int.max
        ) else { return }
        try file.restrictPermissions(to: 0o600)
        file.close()
    }
}
