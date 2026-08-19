import Darwin
import Foundation

enum NoFollowRegularFileError: Error {
    case invalidFile
}

/// The file itself is synchronized before replacement. Directory synchronization is the
/// final durability confirmation for that replacement, but once `renameat` succeeds the
/// new file is already the live state and cannot safely be reported as an uncommitted write.
enum PersistenceWriteDurability: Equatable, Sendable {
    case confirmed
    case directorySyncUnconfirmed(errorCode: Int32)

    var warningMessage: String? {
        guard case let .directorySyncUnconfirmed(errorCode) = self else { return nil }
        return "저장은 반영되었지만 디스크 동기화를 확인하지 못했습니다(오류 \(errorCode)). "
            + "추가 변경을 막았습니다. Data & Settings에서 백업을 복원해 주세요."
    }

    static func synchronizeDirectory(_ descriptor: Int32) -> Self {
        guard Darwin.fsync(descriptor) == 0 else {
            return .directorySyncUnconfirmed(errorCode: errno)
        }
        return .confirmed
    }
}

final class NoFollowRegularFile {
    struct StableIdentity: Equatable, Sendable {
        let device: UInt64
        let inode: UInt64
    }

    struct Snapshot: Equatable, Sendable {
        let size: UInt64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
        let changedSeconds: Int64
        let changedNanoseconds: Int64

        var modificationDate: Date {
            Date(
                timeIntervalSince1970: TimeInterval(modifiedSeconds)
                    + TimeInterval(modifiedNanoseconds) / 1_000_000_000
            )
        }
    }

    struct Identity: Equatable, Sendable {
        let stable: StableIdentity
        let snapshot: Snapshot

        var modificationDate: Date {
            snapshot.modificationDate
        }
    }

    private(set) var identity: Identity
    private let handle: FileHandle

    private init(handle: FileHandle, identity: Identity) {
        self.handle = handle
        self.identity = identity
    }

    deinit {
        try? handle.close()
    }

    static func openIfExists(
        _ url: URL,
        maximumByteCount: Int,
        expectedIdentity: Identity? = nil,
        allowsGrowth: Bool = false
    ) throws -> NoFollowRegularFile? {
        do {
            return try open(
                url, maximumByteCount: maximumByteCount,
                expectedIdentity: expectedIdentity, allowsGrowth: allowsGrowth
            )
        } catch let error as NSError
            where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        }
    }

    static func open(
        _ url: URL,
        maximumByteCount: Int,
        expectedIdentity: Identity? = nil,
        allowsGrowth: Bool = false
    ) throws -> NoFollowRegularFile {
        guard maximumByteCount >= 0 else { throw NoFollowRegularFileError.invalidFile }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        }
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return try fromDescriptor(
            descriptor, maximumByteCount: maximumByteCount,
            expectedIdentity: expectedIdentity, allowsGrowth: allowsGrowth
        )
    }

    fileprivate static func fromDescriptor(
        _ descriptor: Int32,
        maximumByteCount: Int,
        expectedIdentity: Identity? = nil,
        allowsGrowth: Bool = false
    ) throws -> NoFollowRegularFile {
        var status = stat()
        guard Darwin.fstat(descriptor, &status) == 0 else {
            let savedError = errno
            Darwin.close(descriptor)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
        }
        guard (status.st_mode & S_IFMT) == S_IFREG,
              status.st_size >= 0,
              UInt64(status.st_size) <= UInt64(maximumByteCount) else {
            Darwin.close(descriptor)
            throw NoFollowRegularFileError.invalidFile
        }
        let identity = identity(for: status)
        if let expectedIdentity {
            let matches = identity.stable == expectedIdentity.stable
                && (allowsGrowth
                    ? identity.snapshot.size >= expectedIdentity.snapshot.size
                    : identity.snapshot == expectedIdentity.snapshot)
            guard matches else {
                Darwin.close(descriptor)
                throw NoFollowRegularFileError.invalidFile
            }
        }
        return NoFollowRegularFile(
            handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true),
            identity: identity
        )
    }

    func close() {
        try? handle.close()
    }

    func seek(toOffset offset: UInt64) throws {
        try handle.seek(toOffset: offset)
    }

    func read(upToCount count: Int) throws -> Data? {
        try handle.read(upToCount: count)
    }

    func readAll(maximumByteCount: Int) throws -> Data {
        guard maximumByteCount >= 0,
              identity.snapshot.size <= UInt64(maximumByteCount) else {
            throw NoFollowRegularFileError.invalidFile
        }
        try seek(toOffset: 0)
        var data = Data()
        data.reserveCapacity(Int(identity.snapshot.size))
        while data.count <= maximumByteCount {
            let remaining = maximumByteCount - data.count
            let request = remaining == 0 ? 1 : min(64 * 1_024, remaining)
            guard request > 0,
                  let chunk = try read(upToCount: request), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        guard data.count <= maximumByteCount,
              data.count == Int(identity.snapshot.size),
              try currentIdentity() == identity else {
            throw NoFollowRegularFileError.invalidFile
        }
        return data
    }

    func restrictPermissions(to mode: mode_t) throws {
        guard Darwin.fchmod(handle.fileDescriptor, mode) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        identity = try currentIdentity()
    }

    private func currentIdentity() throws -> Identity {
        var status = stat()
        guard Darwin.fstat(handle.fileDescriptor, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_size >= 0 else {
            throw NoFollowRegularFileError.invalidFile
        }
        return Self.identity(for: status)
    }

    private static func identity(for status: stat) -> Identity {
        Identity(
            stable: StableIdentity(
                device: UInt64(bitPattern: Int64(status.st_dev)),
                inode: UInt64(status.st_ino)
            ),
            snapshot: Snapshot(
                size: UInt64(status.st_size),
                modifiedSeconds: Int64(status.st_mtimespec.tv_sec),
                modifiedNanoseconds: Int64(status.st_mtimespec.tv_nsec),
                changedSeconds: Int64(status.st_ctimespec.tv_sec),
                changedNanoseconds: Int64(status.st_ctimespec.tv_nsec)
            )
        )
    }
}

final class NoFollowDirectory {
    private let handle: FileHandle

    private init(descriptor: Int32) {
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    deinit {
        try? handle.close()
    }

    static func openIfExists(_ url: URL) throws -> NoFollowDirectory? {
        do {
            return try open(url)
        } catch let error as NSError
            where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        }
    }

    static func open(_ url: URL) throws -> NoFollowDirectory {
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return NoFollowDirectory(descriptor: descriptor)
    }

    static func openAuthorized(_ url: URL) throws -> NoFollowDirectory {
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return NoFollowDirectory(descriptor: descriptor)
    }

    func restrictPermissions(to mode: mode_t) throws {
        guard Darwin.fchmod(handle.fileDescriptor, mode) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }

    func openDirectoryIfExists(components: [String]) throws -> NoFollowDirectory? {
        do {
            return try openDirectory(components: components)
        } catch let error as NSError
            where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        }
    }

    func openDirectory(components: [String]) throws -> NoFollowDirectory {
        guard !components.isEmpty,
              components.allSatisfy({ component in
                  !component.isEmpty && component != "." && component != ".."
                      && !component.contains("/")
              }) else {
            throw NoFollowRegularFileError.invalidFile
        }
        var parentDescriptor = handle.fileDescriptor
        var ownsParentDescriptor = false
        for component in components {
            let nextDescriptor = component.withCString {
                Darwin.openat(
                    parentDescriptor, $0,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
            }
            guard nextDescriptor >= 0 else {
                let savedError = errno
                if ownsParentDescriptor { Darwin.close(parentDescriptor) }
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
            }
            if ownsParentDescriptor { Darwin.close(parentDescriptor) }
            parentDescriptor = nextDescriptor
            ownsParentDescriptor = true
        }
        return NoFollowDirectory(descriptor: parentDescriptor)
    }

    func openOrCreateDirectory(
        components: [String], mode: mode_t = 0o700
    ) throws -> NoFollowDirectory {
        try Self.validate(components: components)
        var parentDescriptor = handle.fileDescriptor
        var ownsParentDescriptor = false
        for component in components {
            let creationResult = component.withCString {
                Darwin.mkdirat(parentDescriptor, $0, mode)
            }
            if creationResult != 0 && errno != EEXIST {
                let savedError = errno
                if ownsParentDescriptor { Darwin.close(parentDescriptor) }
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
            }
            let nextDescriptor = component.withCString {
                Darwin.openat(
                    parentDescriptor, $0,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
            }
            guard nextDescriptor >= 0 else {
                let savedError = errno
                if ownsParentDescriptor { Darwin.close(parentDescriptor) }
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
            }
            guard Darwin.fchmod(nextDescriptor, mode) == 0 else {
                let savedError = errno
                Darwin.close(nextDescriptor)
                if ownsParentDescriptor { Darwin.close(parentDescriptor) }
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
            }
            if ownsParentDescriptor { Darwin.close(parentDescriptor) }
            parentDescriptor = nextDescriptor
            ownsParentDescriptor = true
        }
        return NoFollowDirectory(descriptor: parentDescriptor)
    }

    @discardableResult
    func atomicWrite(
        _ data: Data,
        fileName: String,
        mode: mode_t = 0o600,
        temporaryName: String? = nil,
        directorySynchronizer: (Int32) -> PersistenceWriteDurability =
            PersistenceWriteDurability.synchronizeDirectory
    ) throws -> PersistenceWriteDurability {
        try Self.validate(components: [fileName])
        let temporaryName = temporaryName
            ?? ".\(fileName).\(UUID().uuidString).tmp"
        try Self.validate(components: [temporaryName])

        let descriptor = temporaryName.withCString {
            Darwin.openat(
                handle.fileDescriptor, $0,
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                mode
            )
        }
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var temporaryExists = true
        defer {
            Darwin.close(descriptor)
            if temporaryExists {
                temporaryName.withCString {
                    _ = Darwin.unlinkat(handle.fileDescriptor, $0, 0)
                }
            }
        }

        guard Darwin.fchmod(descriptor, mode) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var destinationStatus = stat()
        let destinationResult = fileName.withCString {
            Darwin.fstatat(
                handle.fileDescriptor, $0, &destinationStatus, AT_SYMLINK_NOFOLLOW
            )
        }
        if destinationResult == 0 {
            guard (destinationStatus.st_mode & S_IFMT) == S_IFREG else {
                throw NoFollowRegularFileError.invalidFile
            }
        } else if errno != ENOENT {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(
                    descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset
                )
                if written < 0 {
                    if errno == EINTR { continue }
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
                guard written > 0 else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(EIO))
                }
                offset += written
            }
        }
        guard Darwin.fsync(descriptor) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let renameResult = temporaryName.withCString { temporaryPointer in
            fileName.withCString { destinationPointer in
                Darwin.renameat(
                    handle.fileDescriptor, temporaryPointer,
                    handle.fileDescriptor, destinationPointer
                )
            }
        }
        guard renameResult == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        temporaryExists = false
        // `renameat` already made the replacement visible. Return an explicit durability
        // result instead of throwing an ordinary failure that would leave callers using
        // stale in-memory state while the new state is live on disk.
        return directorySynchronizer(handle.fileDescriptor)
    }

    func removeRegularFilesIfExists(
        fileNames: [String],
        generatedByAtomicWriteFor atomicFileNames: [String] = []
    ) throws {
        try Self.validate(components: fileNames)
        if !atomicFileNames.isEmpty {
            try Self.validate(components: atomicFileNames)
        }
        var candidates = Set(fileNames)
        if !atomicFileNames.isEmpty {
            for entryName in try directoryEntryNames() {
                if atomicFileNames.contains(where: {
                    Self.isGeneratedTemporaryFile(entryName, for: $0)
                }) {
                    candidates.insert(entryName)
                }
            }
        }

        var existingNames: [String] = []
        for fileName in candidates.sorted() {
            var status = stat()
            let result = fileName.withCString {
                Darwin.fstatat(handle.fileDescriptor, $0, &status, AT_SYMLINK_NOFOLLOW)
            }
            if result == 0 {
                guard (status.st_mode & S_IFMT) == S_IFREG else {
                    throw NoFollowRegularFileError.invalidFile
                }
                existingNames.append(fileName)
            } else if errno != ENOENT {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        }
        for fileName in existingNames {
            let result = fileName.withCString {
                Darwin.unlinkat(handle.fileDescriptor, $0, 0)
            }
            guard result == 0 || errno == ENOENT else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        }
        if !existingNames.isEmpty {
            guard Darwin.fsync(handle.fileDescriptor) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        }
    }

    private func directoryEntryNames() throws -> [String] {
        let descriptor = Darwin.dup(handle.fileDescriptor)
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        guard let directory = Darwin.fdopendir(descriptor) else {
            let savedError = errno
            Darwin.close(descriptor)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(savedError))
        }
        defer { Darwin.closedir(directory) }

        var names: [String] = []
        while true {
            errno = 0
            guard let entry = Darwin.readdir(directory) else {
                guard errno == 0 else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
                return names
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(
                    to: CChar.self, capacity: Int(MAXNAMLEN) + 1
                ) { String(cString: $0) }
            }
            names.append(name)
        }
    }

    private static func isGeneratedTemporaryFile(
        _ candidate: String, for fileName: String
    ) -> Bool {
        let prefix = ".\(fileName)."
        let suffix = ".tmp"
        guard candidate.hasPrefix(prefix), candidate.hasSuffix(suffix) else {
            return false
        }
        let identifierStart = candidate.index(candidate.startIndex, offsetBy: prefix.count)
        let identifierEnd = candidate.index(candidate.endIndex, offsetBy: -suffix.count)
        guard identifierStart < identifierEnd else { return false }
        return UUID(uuidString: String(candidate[identifierStart..<identifierEnd])) != nil
    }

    func openFileIfExists(
        components: [String],
        maximumByteCount: Int,
        expectedIdentity: NoFollowRegularFile.Identity? = nil,
        allowsGrowth: Bool = false
    ) throws -> NoFollowRegularFile? {
        do {
            return try openFile(
                components: components, maximumByteCount: maximumByteCount,
                expectedIdentity: expectedIdentity, allowsGrowth: allowsGrowth
            )
        } catch let error as NSError
            where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        }
    }

    func openFile(
        components: [String],
        maximumByteCount: Int,
        expectedIdentity: NoFollowRegularFile.Identity? = nil,
        allowsGrowth: Bool = false
    ) throws -> NoFollowRegularFile {
        guard maximumByteCount >= 0,
              !components.isEmpty,
              components.allSatisfy({ component in
                  !component.isEmpty && component != "." && component != ".."
                      && !component.contains("/")
              }) else {
            throw NoFollowRegularFileError.invalidFile
        }
        var parentDescriptor = handle.fileDescriptor
        var ownsParentDescriptor = false
        defer {
            if ownsParentDescriptor { Darwin.close(parentDescriptor) }
        }
        for component in components.dropLast() {
            let nextDescriptor = component.withCString {
                Darwin.openat(
                    parentDescriptor, $0,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
            }
            guard nextDescriptor >= 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            if ownsParentDescriptor { Darwin.close(parentDescriptor) }
            parentDescriptor = nextDescriptor
            ownsParentDescriptor = true
        }
        let descriptor = components.last!.withCString {
            Darwin.openat(
                parentDescriptor, $0,
                O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
            )
        }
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return try NoFollowRegularFile.fromDescriptor(
            descriptor, maximumByteCount: maximumByteCount,
            expectedIdentity: expectedIdentity, allowsGrowth: allowsGrowth
        )
    }

    private static func validate(components: [String]) throws {
        guard !components.isEmpty,
              components.allSatisfy({ component in
                  !component.isEmpty && component != "." && component != ".."
                      && !component.contains("/")
              }) else {
            throw NoFollowRegularFileError.invalidFile
        }
    }
}

struct GamePersistence: Sendable {
    private static let maximumStateByteCount = 20_000_000
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
            return
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.fileURL = support.appending(path: "PunchGrow/state.json")
        readAnchorURL = support
        readComponents = ["PunchGrow", "state.json"]
        managesFilePermissions = true
    }

    init(managedStorageAnchorURL: URL) {
        fileURL = managedStorageAnchorURL.appending(path: "PunchGrow/state.json")
        readAnchorURL = managedStorageAnchorURL
        readComponents = ["PunchGrow", "state.json"]
        managesFilePermissions = true
    }

    func load() throws -> GameState {
        guard let file = try openStateFileIfExists() else { return GameState() }
        let data = try file.readAll(maximumByteCount: Self.maximumStateByteCount)
        let version = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["schemaVersion"] as? Int
        if version == 1 {
            let migrated = try JSONDecoder.punchGrow.decode(LegacyGameStateV1.self, from: data).migrated()
            try migrated.validate()
            return migrated
        }
        var state = try JSONDecoder.punchGrow.decode(GameState.self, from: data)
        if version == 2 {
            try state.migrateLegacyFoodInventory()
        }
        try state.validate()
        return state
    }

    func requiresMigrationCommit() throws -> Bool {
        guard let file = try openStateFileIfExists() else { return false }
        let data = try file.readAll(maximumByteCount: Self.maximumStateByteCount)
        let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let version = root?["schemaVersion"] as? Int else { return false }
        return version == 1 || version == 2
    }

    @discardableResult
    func save(_ state: GameState) throws -> PersistenceWriteDurability {
        let data = try JSONEncoder.punchGrow.encode(state)
        if !managesFilePermissions {
            // 명시적 fileURL은 테스트·호출자가 고른 경로이므로 예전 계약대로 부모를 만든다.
            // 최종 파일 교체는 이어지는 descriptor 기반 atomicWrite가 계속 검증한다.
            try FileManager.default.createDirectory(
                at: readAnchorURL, withIntermediateDirectories: true
            )
            let directory = try NoFollowDirectory.open(readAnchorURL)
            return try directory.atomicWrite(data, fileName: readComponents[0])
        } else {
            let anchor = try NoFollowDirectory.open(readAnchorURL)
            let directory = try anchor.openOrCreateDirectory(
                components: Array(readComponents.dropLast())
            )
            return try directory.atomicWrite(data, fileName: readComponents.last!)
        }
    }

    private func openStateFileIfExists() throws -> NoFollowRegularFile? {
        guard let anchor = try NoFollowDirectory.openIfExists(readAnchorURL) else {
            return nil
        }
        guard managesFilePermissions else {
            return try anchor.openFileIfExists(
                components: readComponents,
                maximumByteCount: Self.maximumStateByteCount
            )
        }
        guard let directory = try anchor.openDirectoryIfExists(
            components: Array(readComponents.dropLast())
        ) else { return nil }
        try directory.restrictPermissions(to: 0o700)
        guard let file = try directory.openFileIfExists(
            components: [readComponents.last!],
            maximumByteCount: Self.maximumStateByteCount
        ) else { return nil }
        try file.restrictPermissions(to: 0o600)
        return file
    }

    @discardableResult
    func export(_ state: GameState, to destination: URL) throws -> PersistenceWriteDurability {
        let envelope = BackupEnvelope(format: "punchgrow-backup-v1", exportedAt: .now, state: state)
        let data = try JSONEncoder.punchGrow.encode(envelope)
        let directory = try NoFollowDirectory.openAuthorized(
            destination.deletingLastPathComponent()
        )
        return try directory.atomicWrite(data, fileName: destination.lastPathComponent)
    }

    func restore(from source: URL) throws -> GameState {
        let data: Data
        do {
            guard let file = try NoFollowRegularFile.openIfExists(
                source, maximumByteCount: Self.maximumStateByteCount
            ) else { throw GameError.invalidBackup }
            data = try file.readAll(maximumByteCount: Self.maximumStateByteCount)
        } catch {
            throw GameError.invalidBackup
        }
        var state: GameState
        if let envelope = try? JSONDecoder.punchGrow.decode(BackupEnvelope.self, from: data) {
            guard envelope.format == "punchgrow-backup-v1" else {
                throw GameError.invalidBackup
            }
            state = envelope.state
            if state.schemaVersion == 1 || state.schemaVersion == 2 {
                try state.migrateLegacyFoodInventory()
            }
        } else {
            let envelope: LegacyBackupEnvelopeV1
            do {
                envelope = try JSONDecoder.punchGrow.decode(
                    LegacyBackupEnvelopeV1.self, from: data
                )
            } catch {
                throw GameError.invalidBackup
            }
            guard envelope.format == "punchgrow-backup-v1" else {
                throw GameError.invalidBackup
            }
            state = try envelope.state.migrated()
        }
        try state.validate()
        return state
    }
}

private extension GameState {
    /// 일반 먹이를 없앤 스키마 3으로 한 번만 옮긴다. 다섯 개는 가격이 같은 대형 먹이
    /// 하나로 바꾸고 남은 수량은 구매가 그대로 환급해 사용자가 쌓아 둔 가치를 잃지 않는다.
    mutating func migrateLegacyFoodInventory() throws {
        guard schemaVersion == 1 || schemaVersion == 2,
              tokenBalance >= 0,
              inventory.legacyNormalFood >= 0,
              inventory.largeFood >= 0,
              inventory.extraLargeFood >= 0 else {
            throw GameError.invalidBackup
        }

        let convertedLargeFood = inventory.legacyNormalFood / Self.legacyNormalFoodPerLargeFood
        let refundableNormalFood = inventory.legacyNormalFood % Self.legacyNormalFoodPerLargeFood
        let nextLargeFood = inventory.largeFood.addingReportingOverflow(convertedLargeFood)
        let refund = refundableNormalFood.multipliedReportingOverflow(
            by: Self.legacyNormalFoodUnitCost
        )
        guard !nextLargeFood.overflow, !refund.overflow else {
            throw GameError.invalidBackup
        }
        let nextBalance = tokenBalance.addingReportingOverflow(refund.partialValue)
        guard !nextBalance.overflow else { throw GameError.invalidBackup }

        inventory.legacyNormalFood = 0
        inventory.largeFood = nextLargeFood.partialValue
        tokenBalance = nextBalance.partialValue
        schemaVersion = Self.schemaVersion
    }
}

private struct LegacyOwnedCreatureV1: Codable {
    let id: UUID
    let speciesID: String
    var level: Int
    var experience: Int
    var affection: Int
    var nickname: String?
    let acquiredAt: Date
}

private struct LegacyGameStateV1: Codable {
    let schemaVersion: Int
    var tokenBalance: Int
    var usageEvents: [TokenUsageEvent]
    var ownedCreatures: [LegacyOwnedCreatureV1]
    var discoveredSpeciesIDs: Set<String>
    var inventory: Inventory
    var pullsSinceOrigin: Int
    var representativeCreatureID: UUID?

    func migrated() throws -> GameState {
        guard schemaVersion == 1 else { throw GameError.invalidBackup }
        for event in usageEvents { try event.validateStored() }
        let keys = Set(usageEvents.map { "\($0.provider.rawValue):\($0.sourceEventID)" })
        var totals: [TokenProvider: Int] = [:]
        for event in usageEvents {
            let addition = totals[event.provider, default: 0].addingReportingOverflow(event.totalTokens)
            guard !addition.overflow else { throw GameError.invalidBackup }
            totals[event.provider] = addition.partialValue
        }
        var state = GameState(
            schemaVersion: schemaVersion,
            tokenBalance: tokenBalance,
            usageEvents: Array(usageEvents.suffix(GameState.maximumRetainedUsageEvents)),
            creditedUsageEventKeys: keys,
            lifetimeUsage: totals,
            codexCheckpoints: [:],
            ownedCreatures: ownedCreatures.map {
                OwnedCreature(id: $0.id, speciesID: $0.speciesID, level: $0.level, experience: $0.experience, affection: $0.affection, nickname: $0.nickname, uniqueColor: false, acquiredAt: $0.acquiredAt)
            },
            discoveredSpeciesIDs: discoveredSpeciesIDs,
            inventory: inventory,
            pullsSinceOrigin: pullsSinceOrigin,
            representativeCreatureID: representativeCreatureID
        )
        try state.migrateLegacyFoodInventory()
        return state
    }
}

private struct LegacyBackupEnvelopeV1: Codable {
    let format: String
    let exportedAt: Date
    let state: LegacyGameStateV1
}

extension JSONEncoder {
    static var punchGrow: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var punchGrow: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
