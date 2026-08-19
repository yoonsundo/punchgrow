# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-19
- Primary product surfaces: macOS ambient menu-bar badge and popup, macOS large window, dedicated ORIGIN reveal window, public website (`/`, `/en/`), public creature dex (`/dex/`, `/en/dex/`), and retained mobile exploration
- Evidence reviewed: `.omx/plans/prd-macos-ux-redesign.md`, `.omx/plans/test-spec-macos-ux-redesign.md`, `문서/WIREFRAMES.md`, `문서/DECISIONS.md`, the existing SwiftUI views, evolution catalog, creature assets, 398×670 populated/fresh-state menu snapshots, `website/` source and build contracts, public README/community files, and the deployed GitHub Pages response
- Scope note: the approved PRD and wireframes remain authoritative for product behavior. This file summarizes their design contract.

## Brand

- Personality: premium digital myth; mysterious, alive, precise, and warm rather than ominous
- Trust signals: truthful connection labels, explicit token provenance, local-first privacy copy, visible action costs, current release/install status, and direct links to source, licenses, security reporting, and contribution guidance
- Avoid: generic admin-dashboard chrome, neon overload, identity-revealing locked cards, misleading “connected” or release claims, an empty JavaScript-only loading shell, and motion that cannot be skipped

## Product goals

- Goals: make the current creature and grow/draw loop immediately understandable; distinguish current rarity from automatic-evolution potential at a glance; make integration state trustworthy; keep collection and data management easy to find; let a public visitor install, inspect source, understand privacy, explore the dex, or start contributing without guessing
- Non-goals: shop, detailed statistics, combat, evolution changes, or economy changes beyond the two-tier food redesign in this macOS iteration
- Success signals: users can distinguish balance from usage, navigate creatures, choose a representative, understand disabled actions, and configure Claude/Codex without guessing; public visitors can identify the supported Mac, current alpha/release status, Homebrew and source-build paths, license boundary, and correct support/security route from the first page

## Personas and jobs

- Primary personas: people using Claude Code or PunchGrow-managed Codex who want a lightweight ambient companion; curious open-source visitors evaluating the product; and contributors looking for a bounded first change
- User jobs: see progress at a glance, grow or draw a creature, inspect the collection, verify token collection, back up local progress, evaluate privacy and installability, browse the full creature world, and find the right contribution or support path
- Key contexts of use: short menu-bar visits, occasional focused configuration in the large window, a first GitHub/website visit on desktop or mobile, and keyboard-only documentation/dex exploration

## Information architecture

- Primary navigation: ambient menu-bar badge for glanceable progress, compact popup for play; large-window sidebar for Collection, Connections, and Data & Settings; public website navigation for product loop, dex, privacy, install, documentation, source, and language
- Core routes/screens: menu popup, `Window(id: "main")`, `Window(id: "origin-reveal")`, Korean/English homepage, Korean/English dex, and a helpful bilingual 404
- Content hierarchy: representative creature, weekly total and Claude/Codex share in the menu bar; balance and weekly usage; connection truth; current creature and progress; immediate actions; deeper destinations. On the public web: value proposition and real app capture, trust ledger, product loop, distinctive ORIGIN world, privacy boundary, verified install paths, then source/contribution routes.

## Design principles

- Creature first: artwork and growth state dominate the compact surface.
- Current state before future promise: label the acquired creature's current rarity separately from its final automatic-evolution potential so potential is never mistaken for a direct pull result.
- Truth over optimism: status and usage labels reflect only measured evidence.
- Open source is navigable: release, source, support, security, contribution, and folder ownership are explicit rather than implied.
- Static does not mean fragile: core homepage content and navigation remain available without JavaScript. The dynamic dex requires JavaScript for cards, search, and filters, and provides an honest localized no-script overview with useful catalog and product routes instead of an empty loading shell.
- Durable intent is explicit: browsing does not change the representative.
- Spectacle converges: normal, reduced-motion, and skipped reveals end in the same usable state.
- Tradeoffs: compact density favors scanability over exhaustive controls; detailed configuration belongs in the large window.

## Visual language

- Color: near-black violet background, layered plum surfaces, lime growth accent, cyan Claude accent, magenta Codex accent; rarity tokens progress through slate PROCESS, cyan AGENT, violet DAEMON, magenta ORACLE, metallic amber ARCHITECT, and lime-cyan iridescent ORIGIN. The compact action deck uses muted, medium-dark semantic fills rather than full-bright provider/rarity accents: moss for large food in the first slot, violet for extra-large food, rose for draw, amber for purchases, indigo for mutation retry, and teal for inheritance. All action labels use white for consistent contrast. The public website uses the same palette as a restrained digital-familiar specimen terminal, with readable muted text rather than decorative low-contrast gray.
- Typography: strong geometric headings, monospaced micro-labels and values, readable Korean body copy; the dependency-free website uses truthful system sans/monospace stacks instead of naming fonts it does not ship
- Spacing/layout rhythm: compact 8–16 point rhythm; large-window 12–24 point rhythm
- Shape/radius/elevation: soft 10–18 point radii, subtle one-pixel borders, restrained colored glows for hierarchy
- Motion: PROCESS and AGENT remain static; DAEMON adds a slow pulse, ORACLE adds a restrained orbit, ARCHITECT intensifies the metallic ring, and ORIGIN uses the richest aura/particle field plus the dedicated skippable reveal; Reduce Motion freezes all ambient animation
- Imagery/iconography: the representative creature appears as a tiny full-color menu-bar familiar and at large scale in play surfaces; SF Symbols support controls and status; generic silhouettes protect undiscovered identities

## Components

- Existing components to reuse: SwiftUI navigation, buttons, progress views, AppKit file panels, bundled creature PNGs; website shell/header, hero, metrics, screenshots, ORIGIN cards, privacy terminal, code window, dex filters/cards/dialog, and shared CSS tokens
- New/changed components: ambient menu-bar status label, compact presentation projection, one-line integration status chips, rarity-token creature hero with overlaid navigation and unified badge/frame/aura, automatic-evolution potential label, compact rarity/probability popover, three-row large/extra-large food, draw, retry, and inheritance action deck with press-and-hold acceleration, collection cards, settings panels, rarity feedback, ORIGIN-lineage feedback, ORIGIN reveal
- Menu-bar status label: a native-height, single-row ambient pet HUD with an 18-point representative creature plus independent cyan `C n%` and magenta `X n%` actual plan-limit percentages; unavailable provider quota data renders as an em dash rather than an estimate.
- Variants and states: empty/one/many creatures; enabled/disabled actions; stopped/listening/recent/error integrations; ordinary pull, ORIGIN-lineage pull, and actual ORIGIN reveal feedback
- Token/component ownership: macOS visual tokens and components remain in `macos/Sources/PunchGrowMenuBar/Views.swift`
- Website token/component ownership: public-site tokens and components remain dependency-free in `website/styles.css`, `website/script.js`, and `website/dex.js`; do not add a parallel framework or design-system package

## Accessibility

- Target standard: WCAG 2.2 AA for the public website and usable VoiceOver, keyboard navigation, increased contrast expectations, and reduced motion across the app
- Keyboard/focus behavior: native SwiftUI controls retain standard focus and activation behavior
- Contrast/readability: text accompanies every color-coded state; secondary text remains legible on dark panels; public website utility copy is at least 11px and meets normal-text contrast rather than relying on dim decorative gray
- Screen-reader semantics: combined labels state provider, status meaning, creature name, current rarity, final automatic-evolution potential, creature progress, and locked identity
- Reduced motion and sensory considerations: system Reduce Motion and the app preference bypass staged ORIGIN effects; skip remains available; website reveal effects are optional progressive enhancement, while the dynamic dex supplies meaningful localized fallback content when scripting is unavailable

## Responsive behavior

- Supported breakpoints/devices: macOS 14+; fixed compact popup and resizable large/reveal windows; website breakpoints target desktop, tablet, 390px mobile, and a 320px minimum and receive static source/build review when browser capture is unavailable
- Layout adaptations: the 398×670 popup stays below the menu bar and its main play surface contains no scroll container. The populated and fresh states must show the complete hero, both provider percentages, both connection states, all seven actions, and all five dock destinations without clipping or action/dock overlap. Creature navigation overlays the artwork zone, mutation/evolution attention shares one priority slot, provider controls share one row, setup clarification stays to one visible line with full text in help, and compact labels remain at least 9.5 points while actionable/supporting copy remains at least 10.5 points. Detailed collection, rarity, evolution, and settings surfaces may use their own appropriately bounded scrolling.
- Touch/hover differences: desktop-native focus, hover help, tooltips, and pointer-sized controls; large/extra-large feed and purchase use one click for one action. A 240ms continuous press arms repeat at an 80ms interval, subtracting 8ms after each action to a 35ms minimum. Release immediately cancels further repeats; if one action is already committing, that commit finishes without scheduling another action.
- Website adaptations: the 980px and 720px breakpoints collapse grids without horizontal overflow; touch targets remain at least 44px where compact controls are used; mobile navigation remains readable without JavaScript and becomes a controlled menu when JavaScript is present

## Interaction states

- Loading: catalog failures surface an explanatory error and disable draw; the public dex reports localized loading, empty, result-count, and failure states
- Empty: compact surface invites the first draw and hides invalid navigation/growth actions
- Error: visible text and symbol accompany error color
- Success: a successful draw focuses the acquired creature and reports both `현재 <등급>` and `성장 잠재력 <최종 자동 진화 등급>`; an ORIGIN lineage receives distinct compact feedback without invoking the actual-ORIGIN reveal window
- Disabled: cost or prerequisite explanations remain visible beside disabled actions
- Repeated action: hold feedback remains native. Each repeated action is serialized through a persistence actor and reaches the visible state only after its save finishes, keeping file synchronization off the main actor. Pointer release, disable, inventory exhaustion, insufficient balance, or another blocked result prevents another repeat; an already-started commit may finish once.
- Offline/slow network: integrations are local; stopped, listening, recent, and error states derive from the shared projection

## Content voice

- Tone: concise, calm, encouraging, technically honest, and welcoming to first-time open-source visitors
- Terminology: “보유 토큰” for spendable balance; “금주 사용량” for measured Claude/Codex usage; “대표” for persisted identity; “현재 <등급>” for the owned species now; “성장 잠재력 <등급>” for the final species selected by the deterministic automatic-evolution path; “ORIGIN 계보” only when that final path reaches ORIGIN
- Microcopy rules: explain setup as copy then Terminal execution; name the managed-session boundary; never imply prompt/code persistence; keep homepage install wording synchronized with the latest published release, Homebrew availability, signing/notarization status, and required quarantine step

## Implementation constraints

- Framework/styling system: SwiftUI plus existing AppKit bridges; dependency-free static HTML/CSS/JavaScript for the GitHub Pages website
- Design-token constraints: extend repo-native constants; add no UI dependency or parallel design-system package
- Performance constraints: reuse the bounded creature image cache for the menu-bar thumbnail, keep popup animation brief, and honor reduced motion; serialize hold-repeat persistence on a dedicated actor so encoding, replacement, and `fsync` do not block the main actor; keep the website dependency-free, lazy-load non-hero images, debounce dex search, and allow off-screen lineage rendering to be skipped by the browser
- Compatibility constraints: preserve G001 APIs, schema version 2 save compatibility, probabilities, pity, and local-first security boundaries. Legacy normal-food inventory converts deterministically: each group of five becomes one large food and every remainder refunds 100,000 tokens; older saves decode extra-large inventory as zero. Preserve GitHub Pages routes, custom domain, locale parity, and direct asset/link validity.
- Test/screenshot expectations: deterministic presentation helpers cover semantic state; populated and fresh 398×670 menu snapshots reject any main-surface `NSScrollView` and verify that the complete third action row and five-item dock occupy their fixed bands; release build, full tests, and all 256 assets are verification gates when the Xcode/CLT toolchain is valid. Website changes must pass both build validators, metadata/content contracts, 320px static layout review, keyboard/reduced-motion review, and a browser capture when a browser session is available.
- Compact popup bottom safety: retain at least 26 points of outer bottom breathing room plus 6 points inside the footer; keep the footer fixed at the bottom, place every play action fully above it, and open rarity/probability/evolution details in dedicated popovers rather than increasing the fixed 398×670 surface height or reintroducing main-surface scrolling
- Food action deck: keep the draw action in the first row beside large and extra-large feeding; place large and extra-large purchases in a second compact row. Existing large food moves into the first slot unchanged at 500,000 tokens for XP +200 / affection +10. Extra-large food occupies the second slot at 2,500,000 tokens for XP +1,000 / affection +50, preserving exactly the same token efficiency.
- Action color ownership: action-deck fills are dedicated `PunchGrowColors` tokens in `Views.swift`; do not reuse the brighter global provider, rarity, warning, or progress accents as solid button backgrounds.
- Evolution potential contract: derive one automatic path from `EvolutionCatalog`'s production candidate order; never hard-code ORIGIN roots. A newly drawn start computes from that start, while an owned or branched creature computes forward from its actual current species; the root is used only to show the full Evolution Dex tree. The hero uses a separate one-line potential label, pull feedback distinguishes lineage potential from actual rarity, Evolution Dex visibly marks every current-forward automatic-path card, and the rarity guide separates `PROCESS 100% direct pull` from `ORIGIN lineage n/64`.

## Open questions

- [ ] Tune animation timing from a native visual QA pass / macOS design owner / polish only
- [ ] Define shop and detailed-statistics IA in a future approved scope / product owner / no impact on current navigation
- [ ] Produce a purpose-built 1280×640 social preview after a visual asset owner approves the composition / project owner / sharing polish only
