const dexRoot = document.getElementById('dex-content');
const dexSearch = document.getElementById('dex-search');
const dexFilters = document.getElementById('dex-filters');
const dexResult = document.getElementById('dex-result');
const storyDialog = document.getElementById('creature-story');
const storyContent = document.getElementById('story-content');

if (dexRoot && dexSearch && dexFilters && dexResult) {
  const english = document.documentElement.lang === 'en';
  const copy = english ? {
    all: 'ALL', lineage: 'LINEAGES', shown: 'showing', noResults: 'No lineages found.',
    stage: 'STAGE', branch: 'BRANCH', mutation: 'MUTATION', close: 'Close', identity: 'IDENTITY', story: 'STORY', profile: 'PROFILE', form: 'FORM', tone: 'TONE', motifs: 'MOTIFS', grades: { AGENT: 'AGENT', DAEMON: 'DAEMON', ORACLE: 'ORACLE', ARCHITECT: 'ARCHITECT', ORIGIN: 'ORIGIN' },
  } : {
    all: '전체', lineage: '계보', shown: '표시 중', noResults: '조건에 맞는 계보가 없습니다.',
    stage: '단계', branch: '분기', mutation: '변이', close: '닫기', identity: '정체성', story: '스토리', profile: '개체 프로필', form: '몸 형태', tone: '성향', motifs: '형태 DNA', grades: { AGENT: 'AGENT', DAEMON: 'DAEMON', ORACLE: 'ORACLE', ARCHITECT: 'ARCHITECT', ORIGIN: 'ORIGIN' },
  };
  const gradeOrder = ['ORIGIN', 'ARCHITECT', 'ORACLE', 'DAEMON', 'AGENT', 'FUSION'];
  const gradeRank = Object.fromEntries(gradeOrder.filter((grade) => grade !== 'FUSION').map((grade, index) => [grade, gradeOrder.length - index]));
  const assetPrefix = english ? '../../' : '../';
  let activeGrade = 'ALL';
  let lineages = [];

  const esc = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const parents = (creature) => Array.isArray(creature.evolutionFrom) ? creature.evolutionFrom : creature.evolutionFrom ? [creature.evolutionFrom] : [];

  function buildLineages(creatures) {
    const fusionForms = creatures.filter((creature) => creature.category === 'mixed');
    const regularForms = creatures.filter((creature) => creature.category !== 'mixed');
    const byId = new Map(regularForms.map((creature) => [creature.id, creature]));
    const byLineageStage = new Map(regularForms.map((creature) => [`${creature.lineageId}:S${creature.stage}`, creature]));
    const rootFor = (creature, seen = new Set()) => {
      if (seen.has(creature.id)) return creature.id;
      const parent = parents(creature).map((id) => byId.get(id) ?? byLineageStage.get(id)).find(Boolean);
      return parent ? rootFor(parent, new Set([...seen, creature.id])) : creature.id;
    };
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

  function creatureCard(creature) {
    const tag = creature.category === 'mutant' ? copy.mutation : creature.category === 'mixed' ? 'FUSION' : creature.category === 'special' ? 'SPECIAL' : creature.category === 'branch' || parents(creature).length > 1 ? copy.branch : '';
    const name = english ? creature.enName : creature.koName;
    return `<article class="dex-creature rarity-${creature.rarity.toLowerCase()}"><button class="dex-card-button" type="button" data-creature-id="${creature.id}" aria-label="${esc(name)} 상세 보기">
      <div class="dex-art"><img src="${assetPrefix}${creature.image}" loading="lazy" width="360" height="360" alt="${esc(name)} — ${esc(creature.id)}, ${creature.rarity}, ${copy.stage} ${creature.stage}"></div>
      <div class="dex-card-copy"><div><span class="dex-id">${esc(creature.id)}</span>${tag ? `<span class="dex-branch">${tag}</span>` : ''}</div><strong>${esc(name)}</strong><small>${copy.stage} ${creature.stage} · ${creature.rarity}</small></div>
    </button></article>`;
  }

  function render() {
    const needle = dexSearch.value.trim().toLocaleLowerCase();
    const visible = lineages.filter((lineage) => {
      if (activeGrade !== 'ALL' && lineage.maxGrade !== activeGrade) return false;
      if (!needle) return true;
      return lineage.forms.some((form) => [form.id, form.koName, form.enName, form.rarity].join(' ').toLocaleLowerCase().includes(needle));
    });
    dexResult.textContent = visible.length ? `${visible.length} ${copy.lineage} · ${visible.reduce((total, lineage) => total + lineage.forms.length, 0)} ${copy.shown}` : copy.noResults;
    dexRoot.innerHTML = gradeOrder.map((grade) => {
      const groups = visible.filter((lineage) => lineage.maxGrade === grade);
      if (!groups.length) return '';
      const label = grade === 'FUSION' ? 'FUSION' : copy.grades[grade];
      return `<section class="dex-grade" aria-labelledby="grade-${grade}"><div class="dex-grade-heading"><p>${grade}</p><h2 id="grade-${grade}">${label}</h2><span>${groups.length} ${copy.lineage} · ${groups.reduce((total, lineage) => total + lineage.forms.length, 0)} ${copy.shown}</span></div>${groups.map((lineage) => `<article class="dex-lineage"><header><div><p>${lineage.root.id} / ${lineage.root.lineageId}</p><h3>${esc(english ? lineage.root.enName : lineage.root.koName)}</h3></div><span class="dex-lineage-grade">${grade === 'FUSION' ? 'FUSION' : `MAX ${lineage.maxGrade}`}</span></header><div class="dex-evolution">${lineage.forms.map(creatureCard).join('')}</div></article>`).join('')}</section>`;
    }).join('') || `<p class="dex-empty">${copy.noResults}</p>`;
  }

  function openStory(creature) {
    if (!storyDialog || !storyContent) return;
    const name = english ? creature.enName : creature.koName;
    const alternateName = english ? creature.koName : creature.enName;
    const color = creature.palette?.glow ?? '#c6f84e';
    storyContent.innerHTML = `<div class="story-art" style="--story-glow:${esc(color)}"><img src="${assetPrefix}${creature.image}" width="360" height="360" alt="${esc(name)}"></div><div class="story-copy"><p class="eyebrow">${esc(creature.id)} / ${creature.rarity} / ${copy.stage} ${creature.stage}</p><h2 id="story-title">${esc(name)} <small>${esc(alternateName)}</small></h2><section><h3>${copy.identity}</h3><p>${esc(creature.identity)}</p></section><section><h3>${copy.story}</h3><p>${esc(creature.lore)}</p></section><dl><div><dt>${copy.form}</dt><dd>${esc(creature.bodyForm)}</dd></div><div><dt>${copy.tone}</dt><dd>${esc(creature.tone)}</dd></div></dl><section><h3>${copy.motifs}</h3><ul>${(creature.shapeDNA ?? []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section></div>`;
    storyDialog.showModal();
  }

  fetch(`${assetPrefix}data/creatures.json`).then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load creature dex.'))).then((creatures) => {
    lineages = buildLineages(creatures).map((lineage) => ({ ...lineage, forms: lineage.forms.map((form) => ({ ...form, rootLineageId: lineage.root.lineageId })) }));
    dexFilters.innerHTML = [`<button type="button" class="active" aria-pressed="true" data-grade="ALL">${copy.all} <b>64</b></button>`, ...gradeOrder.map((grade) => `<button type="button" aria-pressed="false" data-grade="${grade}">${grade === 'FUSION' ? 'FUSION' : copy.grades[grade]} <b>${lineages.filter((lineage) => lineage.maxGrade === grade).length}</b></button>`)].join('');
    dexFilters.addEventListener('click', (event) => { const button = event.target.closest('button[data-grade]'); if (!button) return; activeGrade = button.dataset.grade; dexFilters.querySelectorAll('button').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); render(); });
    dexRoot.addEventListener('click', (event) => { const button = event.target.closest('[data-creature-id]'); if (!button) return; const creature = creatures.find((item) => item.id === button.dataset.creatureId); if (creature) openStory(creature); });
    dexSearch.addEventListener('input', render);
    render();
  }).catch((error) => { dexResult.textContent = error.message; });
}

if (storyDialog) {
  storyDialog.querySelector('.story-close')?.addEventListener('click', () => storyDialog.close());
  storyDialog.addEventListener('click', (event) => { if (event.target === storyDialog) storyDialog.close(); });
}
