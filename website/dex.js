const dexRoot = document.getElementById('dex-content');
const dexSearch = document.getElementById('dex-search');
const dexFilters = document.getElementById('dex-filters');
const dexResult = document.getElementById('dex-result');
const storyDialog = document.getElementById('creature-story');
const storyContent = document.getElementById('story-content');

if (dexRoot && dexSearch && dexFilters && dexResult) {
  const english = document.documentElement.lang === 'en';
  const copy = english ? {
    all: 'ALL', lineage: 'LINEAGES', fusionCollectibles: 'FUSION COLLECTIBLES', creatures: 'CREATURES', noResults: 'No matching creatures found.', loadError: 'The creature data could not be loaded.', loadErrorLink: 'View the source catalog on GitHub',
    stage: 'STAGE', branch: 'BRANCH', mutation: 'MUTATION', viewDetails: 'View details for', profile: 'CATALOG PROFILE', catalogId: 'CATALOG ID', category: 'CATEGORY', starterLineage: 'STARTER LINEAGE', translationNotice: 'English story translations are in progress. This view currently shows verified language-neutral catalog data.', grades: { AGENT: 'AGENT', DAEMON: 'DAEMON', ORACLE: 'ORACLE', ARCHITECT: 'ARCHITECT', ORIGIN: 'ORIGIN' },
  } : {
    all: '전체', lineage: '계보', fusionCollectibles: '퓨전 수집종', creatures: '크리처', noResults: '조건에 맞는 크리처가 없습니다.', loadError: '크리처 데이터를 불러오지 못했습니다.', loadErrorLink: 'GitHub에서 원본 카탈로그 보기',
    stage: '단계', branch: '분기', mutation: '변이', viewDetails: '상세 보기', identity: '정체성', story: '스토리', form: '몸 형태', tone: '성향', motifs: '형태 DNA', grades: { AGENT: 'AGENT', DAEMON: 'DAEMON', ORACLE: 'ORACLE', ARCHITECT: 'ARCHITECT', ORIGIN: 'ORIGIN' },
  };
  const gradeOrder = ['ORIGIN', 'ARCHITECT', 'ORACLE', 'DAEMON', 'AGENT', 'FUSION'];
  const gradeRank = Object.fromEntries(gradeOrder.filter((grade) => grade !== 'FUSION').map((grade, index) => [grade, gradeOrder.length - index]));
  const assetPrefix = english ? '../../' : '../';
  let activeGrade = 'ALL';
  let lineages = [];
  let searchTimer;

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function getParents(creature) {
    if (Array.isArray(creature.evolutionFrom)) return creature.evolutionFrom;
    if (creature.evolutionFrom) return [creature.evolutionFrom];
    return [];
  }

  function buildLineages(creatures) {
    const fusionForms = creatures.filter((creature) => creature.category === 'mixed');
    const regularForms = creatures.filter((creature) => creature.category !== 'mixed');
    const byId = new Map(regularForms.map((creature) => [creature.id, creature]));
    const byLineageStage = new Map(regularForms.map((creature) => [`${creature.lineageId}:S${creature.stage}`, creature]));

    function rootFor(creature, seen = new Set()) {
      if (seen.has(creature.id)) return creature.id;
      const parent = getParents(creature).map((id) => byId.get(id) ?? byLineageStage.get(id)).find(Boolean);
      return parent ? rootFor(parent, new Set([...seen, creature.id])) : creature.id;
    }

    const grouped = new Map();
    for (const creature of regularForms) {
      const rootId = rootFor(creature);
      const list = grouped.get(rootId) ?? [];
      list.push(creature);
      grouped.set(rootId, list);
    }
    const regular = [...grouped.entries()].map(([rootId, forms]) => {
      const root = byId.get(rootId) ?? forms[0];
      const eligible = forms.filter((creature) => creature.category !== 'mutant');
      const maxGrade = eligible.reduce((best, creature) => gradeRank[creature.rarity] > gradeRank[best] ? creature.rarity : best, 'AGENT');
      return { root, forms: forms.sort((a, b) => a.stage - b.stage || a.id.localeCompare(b.id)), maxGrade };
    });
    const fusions = fusionForms.map((creature) => ({ root: creature, forms: [creature], maxGrade: 'FUSION' }));
    return [...regular, ...fusions].sort((a, b) => (gradeRank[b.maxGrade] ?? 0) - (gradeRank[a.maxGrade] ?? 0) || a.root.id.localeCompare(b.root.id));
  }

  function creatureCard(creature, needle) {
    let tag = '';
    if (creature.category === 'mutant') {
      tag = copy.mutation;
    } else if (creature.category === 'mixed') {
      tag = 'FUSION';
    } else if (creature.category === 'special') {
      tag = 'SPECIAL';
    } else if (creature.category === 'branch' || getParents(creature).length > 1) {
      tag = copy.branch;
    }

    const name = english ? creature.enName : creature.koName;
    const matches = needle && [creature.id, creature.koName, creature.enName, creature.rarity].join(' ').toLocaleLowerCase().includes(needle);
    return `<article class="dex-creature rarity-${creature.rarity.toLowerCase()}${matches ? ' is-match' : ''}"><button class="dex-card-button" type="button" data-creature-id="${creature.id}" aria-label="${english ? `${copy.viewDetails} ${escapeHtml(name)}` : `${escapeHtml(name)} ${copy.viewDetails}`}">
      <div class="dex-art"><img src="${assetPrefix}${creature.image}" loading="lazy" width="360" height="360" alt="${escapeHtml(name)} — ${escapeHtml(creature.id)}, ${creature.rarity}, ${copy.stage} ${creature.stage}"></div>
      <div class="dex-card-copy"><div><span class="dex-id">${escapeHtml(creature.id)}</span>${tag ? `<span class="dex-branch">${tag}</span>` : ''}</div><strong>${escapeHtml(name)}</strong><small>${copy.stage} ${creature.stage} · ${creature.rarity}</small></div>
    </button></article>`;
  }

  function render() {
    const needle = dexSearch.value.trim().toLocaleLowerCase();
    const visible = lineages.filter((lineage) => {
      if (activeGrade !== 'ALL' && lineage.maxGrade !== activeGrade) return false;
      if (!needle) return true;
      return lineage.forms.some((form) => [form.id, form.koName, form.enName, form.rarity].join(' ').toLocaleLowerCase().includes(needle));
    });
    const visibleLineages = visible.filter((lineage) => lineage.maxGrade !== 'FUSION');
    const visibleFusions = visible.filter((lineage) => lineage.maxGrade === 'FUSION');
    const resultParts = [];
    if (visibleLineages.length) resultParts.push(`${visibleLineages.length} ${copy.lineage}`);
    if (visibleFusions.length) resultParts.push(`${visibleFusions.length} ${copy.fusionCollectibles}`);
    if (visible.length) resultParts.push(`${visible.reduce((total, lineage) => total + lineage.forms.length, 0)} ${copy.creatures}`);
    dexResult.textContent = resultParts.length ? resultParts.join(' · ') : copy.noResults;
    dexRoot.innerHTML = gradeOrder.map((grade) => {
      const groups = visible.filter((lineage) => lineage.maxGrade === grade);
      if (!groups.length) return '';
      const label = grade === 'FUSION' ? 'FUSION' : copy.grades[grade];
      const groupCount = grade === 'FUSION' ? `${groups.length} ${copy.fusionCollectibles}` : `${groups.length} ${copy.lineage}`;
      return `<section class="dex-grade" aria-labelledby="grade-${grade}"><div class="dex-grade-heading"><p>${grade}</p><h2 id="grade-${grade}">${label}</h2><span>${groupCount} · ${groups.reduce((total, lineage) => total + lineage.forms.length, 0)} ${copy.creatures}</span></div>${groups.map((lineage) => `<article class="dex-lineage"><header><div><p>${lineage.root.id} / ${lineage.root.lineageId}</p><h3>${escapeHtml(english ? lineage.root.enName : lineage.root.koName)}</h3></div><span class="dex-lineage-grade">${grade === 'FUSION' ? 'FUSION' : `MAX ${lineage.maxGrade}`}</span></header><div class="dex-evolution">${lineage.forms.map((creature) => creatureCard(creature, needle)).join('')}</div></article>`).join('')}</section>`;
    }).join('') || `<p class="dex-empty">${copy.noResults}</p>`;
  }

  function openStory(creature) {
    if (!storyDialog || !storyContent) return;
    const name = english ? creature.enName : creature.koName;
    const alternateName = english ? creature.koName : creature.enName;
    const color = creature.palette?.glow ?? '#c6f84e';
    const details = english
      ? `<section><h3>${copy.profile}</h3><p>${copy.translationNotice}</p></section><dl><div><dt>${copy.catalogId}</dt><dd>${escapeHtml(creature.id)}</dd></div><div><dt>${copy.starterLineage}</dt><dd>${escapeHtml(creature.rootLineageId)}</dd></div><div><dt>${copy.category}</dt><dd>${escapeHtml(creature.category)}</dd></div><div><dt>${copy.stage}</dt><dd>${creature.stage} / ${creature.rarity}</dd></div></dl>`
      : `<section><h3>${copy.identity}</h3><p>${escapeHtml(creature.identity)}</p></section><section><h3>${copy.story}</h3><p>${escapeHtml(creature.lore)}</p></section><dl><div><dt>${copy.form}</dt><dd>${escapeHtml(creature.bodyForm)}</dd></div><div><dt>${copy.tone}</dt><dd>${escapeHtml(creature.tone)}</dd></div></dl><section><h3>${copy.motifs}</h3><ul>${(creature.shapeDNA ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
    storyContent.innerHTML = `<div class="story-art" style="--story-glow:${escapeHtml(color)}"><img src="${assetPrefix}${creature.image}" width="360" height="360" alt="${escapeHtml(name)}"></div><div class="story-copy"><p class="eyebrow">${escapeHtml(creature.id)} / ${creature.rarity} / ${copy.stage} ${creature.stage}</p><h2 id="story-title">${escapeHtml(name)}${english ? '' : ` <small>${escapeHtml(alternateName)}</small>`}</h2>${details}</div>`;
    storyDialog.showModal();
  }

  fetch(`${assetPrefix}data/creatures.json`).then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load creature dex.'))).then((creatures) => {
    lineages = buildLineages(creatures).map((lineage) => ({ ...lineage, forms: lineage.forms.map((form) => ({ ...form, rootLineageId: lineage.root.lineageId })) }));
    dexFilters.innerHTML = [`<button type="button" class="active" aria-pressed="true" data-grade="ALL">${copy.all} <b>${creatures.length}</b></button>`, ...gradeOrder.map((grade) => `<button type="button" aria-pressed="false" data-grade="${grade}">${grade === 'FUSION' ? 'FUSION' : copy.grades[grade]} <b>${lineages.filter((lineage) => lineage.maxGrade === grade).length}</b></button>`)].join('');
    dexFilters.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-grade]');
      if (!button) return;

      activeGrade = button.dataset.grade;
      dexFilters.querySelectorAll('button').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      render();
    });
    dexRoot.addEventListener('click', (event) => {
      const button = event.target.closest('[data-creature-id]');
      if (!button) return;

      const creature = creatures.find((item) => item.id === button.dataset.creatureId);
      if (creature) openStory(creature);
    });
    dexSearch.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(render, 120);
    });
    render();
  }).catch(() => {
    dexResult.textContent = copy.loadError;
    dexRoot.innerHTML = `<p class="dex-empty">${copy.loadError} <a href="https://github.com/yoonsundo/punchgrow/blob/main/production/catalog/creatures.json">${copy.loadErrorLink}</a></p>`;
  });
}

if (storyDialog) {
  storyDialog.querySelector('.story-close')?.addEventListener('click', () => storyDialog.close());
  storyDialog.addEventListener('click', (event) => { if (event.target === storyDialog) storyDialog.close(); });
}
