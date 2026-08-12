export const CONTINUITY_ROOT_DIRECTIVES = Object.freeze([
  Object.freeze({
    rootId: 'PG-005', directive: 'PRESERVE',
    canonicalTarget: Object.freeze({ biologicalClass: 'construct', speciesFamily: 'construct', coreAnatomy: 'hexapod', locomotionPlan: 'crawling' }),
    anchors: Object.freeze([
      'six-legged-beetle-silhouette-beneath-domed-segmented-shell',
      'two-large-forward-eyes-and-paired-raised-pincer-like-antennae',
      'golden-mechanical-shell-with-luminous-pink-central-hexagonal-panel',
    ]),
    visibilityRequirements: Object.freeze(['exactly-six-visible-walking-legs', 'all-six-legs-separately-readable']),
  }),
  Object.freeze({
    rootId: 'PG-018', directive: 'CORRECT_SPECIES_FAMILY',
    canonicalTarget: Object.freeze({ biologicalClass: 'mammal', speciesFamily: 'ovine', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' }),
    anchors: Object.freeze([
      'dense-clustered-cream-fleece', 'round-sheep-like-face-with-small-dark-nose',
      'paired-dark-spiral-ram-horns', 'hoof-like-curled-feet', 'cyan-glowing-channels-through-fleece',
    ]),
    anchorPolicy: 'PRESERVE_EXISTING_SHEEP_AND_RAM_ANCHORS',
  }),
]);
