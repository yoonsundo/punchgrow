# typed: strict
# frozen_string_literal: true

cask "punchgrow" do
  version "0.2.0"
  sha256 "499b6dab867a2c35bb9bab3fe46035a0141702f689ea011185822172a9fa69aa"

  url "https://github.com/yoonsundo/punchgrow/releases/download/v#{version}/PunchGrow-#{version}-arm64.zip"
  name "PunchGrow"
  desc "Grow digital-myth creatures with local AI coding token usage"
  homepage "https://github.com/yoonsundo/punchgrow"

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "PunchGrow.app"

  zap trash: [
    "~/Library/Application Support/PunchGrow",
    "~/Library/Preferences/app.punchgrow.menubar.plist",
  ]

  caveats <<~EOS
    이 빌드는 아직 Apple 공증(notarization) 전의 ad-hoc 서명 버전입니다.
    macOS Gatekeeper가 첫 실행을 차단하면 아래 명령으로 격리 속성을 제거하세요.
      xattr -d com.apple.quarantine /Applications/PunchGrow.app
  EOS
end
