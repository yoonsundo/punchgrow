import XCTest

@testable import PunchGrowMenuBar

final class PerformancePolicyTests: XCTestCase {
  func testEligibleRarityUsesOneFiniteRevealPulse() {
    XCTAssertEqual(
      RarityAuraAnimationPolicy.motion(tier: .daemon, reduceMotion: false),
      .revealPulse
    )
    XCTAssertEqual(
      RarityAuraAnimationPolicy.motion(tier: .origin, reduceMotion: false),
      .revealPulse
    )
  }

  func testStaticRarityAndReducedMotionNeverCreateContinuousWork() {
    XCTAssertEqual(
      RarityAuraAnimationPolicy.motion(tier: .agent, reduceMotion: false),
      .staticOnly
    )
    XCTAssertEqual(
      RarityAuraAnimationPolicy.motion(tier: .origin, reduceMotion: true),
      .staticOnly
    )
  }
}
