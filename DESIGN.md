# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-11
- Primary product surfaces: macOS ambient menu-bar badge and popup, macOS large window, dedicated ORIGIN reveal window, mobile app
- Evidence reviewed: `.omx/plans/prd-macos-ux-redesign.md`, `.omx/plans/test-spec-macos-ux-redesign.md`, `문서/WIREFRAMES.md`, `문서/DECISIONS.md`, the existing SwiftUI views, evolution catalog, creature assets, and fresh 398×670 populated/fresh-state menu snapshots from 2026-08-11
- Scope note: the approved PRD and wireframes remain authoritative for product behavior. This file summarizes their design contract.

## Brand

- Personality: premium digital myth; mysterious, alive, precise, and warm rather than ominous
- Trust signals: truthful connection labels, explicit token provenance, local-first privacy copy, and visible action costs
- Avoid: generic admin-dashboard chrome, neon overload, identity-revealing locked cards, misleading “connected” claims, and motion that cannot be skipped

## Product goals

- Goals: make the current creature and grow/draw loop immediately understandable; distinguish current rarity from automatic-evolution potential at a glance; make integration state trustworthy; keep collection and data management easy to find
- Non-goals: shop, detailed statistics, combat, evolution, or economy changes in this macOS iteration
- Success signals: users can distinguish balance from usage, navigate creatures, choose a representative, understand disabled actions, and configure Claude/Codex without guessing

## Personas and jobs

- Primary personas: people using Claude Code or PunchGrow-managed Codex who want a lightweight ambient companion
- User jobs: see progress at a glance, grow or draw a creature, inspect the collection, verify token collection, and back up local progress
- Key contexts of use: short menu-bar visits and occasional focused configuration in the large window

## Information architecture

- Primary navigation: ambient menu-bar badge for glanceable progress, compact popup for play; large-window sidebar for Collection, Connections, and Data & Settings
- Core routes/screens: menu popup, `Window(id: "main")`, and `Window(id: "origin-reveal")`
- Content hierarchy: representative creature, weekly total and Claude/Codex share in the menu bar; balance and weekly usage; connection truth; current creature and progress; immediate actions; deeper destinations

## Design principles

- Creature first: artwork and growth state dominate the compact surface.
- Current state before future promise: label the acquired creature's current rarity separately from its final automatic-evolution potential so potential is never mistaken for a direct pull result.
- Truth over optimism: status and usage labels reflect only measured evidence.
- Durable intent is explicit: browsing does not change the representative.
- Spectacle converges: normal, reduced-motion, and skipped reveals end in the same usable state.
- Tradeoffs: compact density favors scanability over exhaustive controls; detailed configuration belongs in the large window.

## Visual language

- Color: near-black violet background, layered plum surfaces, lime growth accent, cyan Claude accent, magenta Codex accent; rarity tokens progress through slate PROCESS, cyan AGENT, violet DAEMON, magenta ORACLE, metallic amber ARCHITECT, and lime-cyan iridescent ORIGIN. The compact action deck uses muted, medium-dark semantic fills rather than full-bright provider/rarity accents: moss for normal food, violet for large food, rose for draw, amber for purchases, indigo for mutation retry, and teal for inheritance. All action labels use white for consistent contrast.
- Typography: strong geometric headings, monospaced micro-labels and values, readable Korean body copy
- Spacing/layout rhythm: compact 8–16 point rhythm; large-window 12–24 point rhythm
- Shape/radius/elevation: soft 10–18 point radii, subtle one-pixel borders, restrained colored glows for hierarchy
- Motion: PROCESS and AGENT remain static; DAEMON adds a slow pulse, ORACLE adds a restrained orbit, ARCHITECT intensifies the metallic ring, and ORIGIN uses the richest aura/particle field plus the dedicated skippable reveal; Reduce Motion freezes all ambient animation
- Imagery/iconography: the representative creature appears as a tiny full-color menu-bar familiar and at large scale in play surfaces; SF Symbols support controls and status; generic silhouettes protect undiscovered identities

## Components

- Existing components to reuse: SwiftUI navigation, buttons, progress views, AppKit file panels, bundled creature PNGs
- New/changed components: ambient menu-bar status label, compact presentation projection, one-line integration status chips, rarity-token creature hero with overlaid navigation and unified badge/frame/aura, automatic-evolution potential label, compact rarity/probability popover, three-row normal/large food, draw, retry, and inheritance action deck with press-and-hold acceleration, collection cards, settings panels, rarity feedback, ORIGIN-lineage feedback, ORIGIN reveal
- Menu-bar status label: a native-height, single-row ambient pet HUD with an 18-point representative creature plus independent cyan `C n%` and magenta `X n%` actual plan-limit percentages; unavailable provider quota data renders as an em dash rather than an estimate.
- Variants and states: empty/one/many creatures; enabled/disabled actions; stopped/listening/recent/error integrations; ordinary pull, ORIGIN-lineage pull, and actual ORIGIN reveal feedback
- Token/component ownership: macOS visual tokens and components remain in `macos/Sources/PunchGrowMenuBar/Views.swift`

## Accessibility

- Target standard: usable with VoiceOver, keyboard navigation, increased contrast expectations, and reduced motion
- Keyboard/focus behavior: native SwiftUI controls retain standard focus and activation behavior
- Contrast/readability: text accompanies every color-coded state; secondary text remains legible on dark panels
- Screen-reader semantics: combined labels state provider, status meaning, creature name, current rarity, final automatic-evolution potential, creature progress, and locked identity
- Reduced motion and sensory considerations: system Reduce Motion and the app preference bypass staged ORIGIN effects; skip remains available

## Responsive behavior

- Supported breakpoints/devices: macOS 14+; fixed compact popup and resizable large/reveal windows
- Layout adaptations: the 398×670 popup stays below the menu bar and its main play surface contains no scroll container. The populated and fresh states must show the complete hero, both provider percentages, both connection states, all seven actions, and all five dock destinations without clipping or action/dock overlap. Creature navigation overlays the artwork zone, mutation/evolution attention shares one priority slot, provider controls share one row, setup clarification stays to one visible line with full text in help, and compact labels remain at least 9.5 points while actionable/supporting copy remains at least 10.5 points. Detailed collection, rarity, evolution, and settings surfaces may use their own appropriately bounded scrolling.
- Touch/hover differences: desktop-native focus, hover help, tooltips, and pointer-sized controls; normal/large feed and purchase use one click for one action and continuous press for accelerating repeat, with release stopping immediately

## Interaction states

- Loading: catalog failures surface an explanatory error and disable draw
- Empty: compact surface invites the first draw and hides invalid navigation/growth actions
- Error: visible text and symbol accompany error color
- Success: a successful draw focuses the acquired creature and reports both `현재 <등급>` and `성장 잠재력 <최종 자동 진화 등급>`; an ORIGIN lineage receives distinct compact feedback without invoking the actual-ORIGIN reveal window
- Disabled: cost or prerequisite explanations remain visible beside disabled actions
- Repeated action: hold feedback remains native and stops immediately on pointer release, disable, inventory exhaustion, or insufficient balance
- Offline/slow network: integrations are local; stopped, listening, recent, and error states derive from the shared projection

## Content voice

- Tone: concise, calm, encouraging, and technically honest
- Terminology: “보유 토큰” for spendable balance; “금주 사용량” for measured Claude/Codex usage; “대표” for persisted identity; “현재 <등급>” for the owned species now; “성장 잠재력 <등급>” for the final species selected by the deterministic automatic-evolution path; “ORIGIN 계보” only when that final path reaches ORIGIN
- Microcopy rules: explain setup as copy then Terminal execution; name the managed-session boundary; never imply prompt/code persistence

## Implementation constraints

- Framework/styling system: SwiftUI plus existing AppKit bridges
- Design-token constraints: extend repo-native constants; add no UI dependency or parallel design-system package
- Performance constraints: reuse the bounded creature image cache for the menu-bar thumbnail, keep popup animation brief, and honor reduced motion
- Compatibility constraints: preserve G001 APIs, schema version 2 saves, probabilities, pity, and local-first security boundaries; older saves decode the new large-food inventory as zero
- Test/screenshot expectations: deterministic presentation helpers cover semantic state; populated and fresh 398×670 menu snapshots reject any main-surface `NSScrollView` and verify that the complete third action row and five-item dock occupy their fixed bands; release build, full tests, and all 240 assets are verification gates when the Xcode/CLT toolchain is valid
- Compact popup bottom safety: retain at least 26 points of outer bottom breathing room plus 6 points inside the footer; keep the footer fixed at the bottom, place every play action fully above it, and open rarity/probability/evolution details in dedicated popovers rather than increasing the fixed 398×670 surface height or reintroducing main-surface scrolling
- Food action deck: keep the draw action in the first row beside normal and large feeding; place normal and large purchases in a second compact row. Large food uses a distinct purple treatment and grants XP +200 / affection +10 for 500,000 tokens.
- Action color ownership: action-deck fills are dedicated `PunchGrowColors` tokens in `Views.swift`; do not reuse the brighter global provider, rarity, warning, or progress accents as solid button backgrounds.
- Evolution potential contract: derive one automatic path from `EvolutionCatalog`'s production candidate order; never hard-code ORIGIN roots. A newly drawn start computes from that start, while an owned or branched creature computes forward from its actual current species; the root is used only to show the full Evolution Dex tree. The hero uses a separate one-line potential label, pull feedback distinguishes lineage potential from actual rarity, Evolution Dex visibly marks every current-forward automatic-path card, and the rarity guide separates `PROCESS 100% direct pull` from `ORIGIN lineage n/60`.

## Open questions

- [ ] Tune animation timing from a native visual QA pass / macOS design owner / polish only
- [ ] Define shop and detailed-statistics IA in a future approved scope / product owner / no impact on current navigation
