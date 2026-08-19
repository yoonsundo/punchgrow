import Foundation

/// 점으로 구분된 숫자 버전. 릴리스 태그와 번들 버전을 같은 규칙으로 읽기 위한 최소 구현이다.
///
/// `0.10.0 > 0.9.0`이 성립해야 하므로 문자열 비교가 아니라 숫자 성분별로 비교한다. 성분 개수가
/// 다르면 짧은 쪽을 0으로 채운다(`0.3` == `0.3.0`). 사전 배포 꼬리표(`-beta.1`)와 빌드 메타데이터
/// (`+build`)는 비교에서 잘라낸다 — 그런 릴리스는 애초에 업데이트 후보에서 제외되므로 정렬 순서를
/// 정교하게 맞출 이유가 없다.
struct AppVersion: Comparable, Hashable, CustomStringConvertible, Sendable {
    let components: [Int]

    init?(_ text: String) {
        var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.first == "v" || body.first == "V" { body.removeFirst() }
        if let cut = body.firstIndex(where: { $0 == "-" || $0 == "+" }) {
            body = String(body[body.startIndex..<cut])
        }
        guard !body.isEmpty else { return nil }
        var parsed: [Int] = []
        for part in body.split(separator: ".", omittingEmptySubsequences: false) {
            guard !part.isEmpty, part.allSatisfy(\.isNumber), let value = Int(part) else {
                return nil
            }
            parsed.append(value)
        }
        guard !parsed.isEmpty else { return nil }
        components = parsed
    }

    var description: String { components.map(String.init).joined(separator: ".") }

    static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let width = max(lhs.components.count, rhs.components.count)
        for index in 0..<width {
            let left = index < lhs.components.count ? lhs.components[index] : 0
            let right = index < rhs.components.count ? rhs.components[index] : 0
            if left != right { return left < right }
        }
        return false
    }

    static func == (lhs: AppVersion, rhs: AppVersion) -> Bool {
        !(lhs < rhs) && !(rhs < lhs)
    }

    func hash(into hasher: inout Hasher) {
        var trimmed = components
        while trimmed.count > 1, trimmed.last == 0 { trimmed.removeLast() }
        hasher.combine(trimmed)
    }
}

/// 업데이트 후보로 삼을 수 있는 공개 릴리스 하나.
struct ReleaseInfo: Equatable, Sendable {
    let version: AppVersion
    let tagName: String
    let htmlURL: URL?
    let notes: String?
    let publishedAt: Date?

    /// 릴리스 전용 페이지가 없으면 최신 릴리스 페이지로 보낸다.
    var notesURL: URL { htmlURL ?? UpdateCheck.releasesPageURL }
}

enum UpdateCheckError: Error, Equatable {
    case badResponse(status: Int)
    case untrustedResponseURL
    case responseTooLarge
    case malformedPayload
}

/// 업데이트 확인의 순수 로직. 네트워크와 저장소를 모르며, 서비스와 테스트가 함께 쓴다.
enum UpdateCheck {
    static let repositorySlug = "yoonsundo/punchgrow"
    static let brewUpgradeCommand = "brew upgrade --cask punchgrow"
    static let checkInterval: TimeInterval = 24 * 60 * 60
    static let maximumResponseBytes = 1_000_000

    static let latestReleaseURL = URL(
        string: "https://api.github.com/repos/\(repositorySlug)/releases/latest"
    )!
    static let releasesPageURL = URL(
        string: "https://github.com/\(repositorySlug)/releases/latest"
    )!

    static func isTrustedLatestReleaseResponseURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "api.github.com"
            && (url.port == nil || url.port == 443)
            && url.user == nil
            && url.password == nil
            && url.path == "/repos/\(repositorySlug)/releases/latest"
            && url.query == nil
            && url.fragment == nil
    }

    private static func trustedReleaseNotesURL(_ text: String?, tagName: String) -> URL? {
        let tagComponents = tagName.split(separator: "/", omittingEmptySubsequences: false)
        guard !tagComponents.isEmpty,
              tagComponents.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              let text,
              let url = URL(string: text),
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "github.com",
              url.port == nil || url.port == 443,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path == "/\(repositorySlug)/releases/tag/\(tagName)"
        else { return nil }
        return url
    }

    /// 실행 중인 번들의 버전. 번들 밖(`swift run`, 테스트 러너)에서는 nil이며, 그때는 업데이트
    /// 확인을 아예 하지 않는다. 0.0.0 같은 값으로 채우면 개발 빌드가 매번 "새 버전 있음"이 된다.
    static var runningAppVersion: AppVersion? {
        guard Bundle.main.bundleIdentifier != nil else { return nil }
        let text = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return text.flatMap(AppVersion.init)
    }

    /// GitHub `releases/latest` 응답을 읽는다. 초안·사전 배포·버전을 읽을 수 없는 태그는 nil이다.
    static func parseLatestRelease(_ data: Data) throws -> ReleaseInfo? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw UpdateCheckError.malformedPayload
        }
        if root["draft"] as? Bool == true || root["prerelease"] as? Bool == true { return nil }
        guard let tagName = root["tag_name"] as? String,
              let version = AppVersion(tagName) else { return nil }
        let notes = (root["body"] as? String).flatMap { text in
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return ReleaseInfo(
            version: version,
            tagName: tagName,
            htmlURL: trustedReleaseNotesURL(root["html_url"] as? String, tagName: tagName),
            notes: notes,
            publishedAt: (root["published_at"] as? String).flatMap {
                ISO8601DateFormatter().date(from: $0)
            }
        )
    }

    /// 사용자에게 알릴 릴리스인지 판단한다. 현재 버전 이하이거나 건너뛴 버전 이하이면 알리지 않는다.
    static func availableUpdate(
        latest: ReleaseInfo?,
        current: AppVersion,
        skipping skipped: AppVersion?
    ) -> ReleaseInfo? {
        guard let latest, latest.version > current else { return nil }
        if let skipped, latest.version <= skipped { return nil }
        return latest
    }

    /// 다음 자동 확인까지 남은 시간. 확인한 적이 없거나 주기가 지났으면 0이다.
    static func delayUntilNextCheck(
        lastCheckedAt: Date?,
        now: Date,
        interval: TimeInterval = checkInterval
    ) -> TimeInterval {
        guard let lastCheckedAt else { return 0 }
        // 시계가 뒤로 갔거나 저장값이 미래인 경우까지 기다리게 두면 확인이 영영 멈춘다.
        let elapsed = now.timeIntervalSince(lastCheckedAt)
        guard elapsed >= 0 else { return 0 }
        return max(0, interval - elapsed)
    }
}
