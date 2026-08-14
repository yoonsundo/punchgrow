# typed: strict
# frozen_string_literal: true

cask "punchgrow" do
  version "0.3.0"
  sha256 "758976484afd60e4e586e7710235bf8b29b0451d12d65b6fbffa3bc245861d4a"

  url "https://github.com/yoonsundo/punchgrow/releases/download/v#{version}/PunchGrow-#{version}-arm64.zip"
  name "PunchGrow"
  desc "Grow digital-myth creatures with local AI coding token usage"
  homepage "https://punchgrow.thundo.kr/"

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "PunchGrow.app"

  zap trash: [
    "~/Library/Application Support/PunchGrow",
    "~/Library/Preferences/app.punchgrow.menubar.plist",
  ]

  caveats <<~EOS
    This v#{version} build is ad-hoc signed and has not been Apple-notarized.
    It contains the 240-creature catalog published with that release; the
    current main branch and public dex contain 256 creatures.
    If macOS Gatekeeper blocks the first launch, remove the quarantine attribute:
      xattr -d com.apple.quarantine /Applications/PunchGrow.app
  EOS
end
