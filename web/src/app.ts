const API = '';
let sessionToken = localStorage.getItem('punchgrow-session') ?? '';

interface Creature { id?:string; catalogId?:string; koName:string; enName:string; rarity:string; imagePath:string; level?:number; experience?:string; affection?:number; uniqueColor?:boolean; personality?:string; identity?:string; palette?:{glow?:string} }
interface State { tokenBalance:string; totalUsage:string; pityCount:number; weeklyUsage:Record<string,string>; creatures:Creature[]; items:{itemType:string;quantity:number}[]; gachaCost:string }
interface Catalog { items:Creature[]; total:number; limit:number; offset:number }
let state: State | null = null;
let catalogOffset = 0;
let searchTimer = 0;

const $ = <T extends HTMLElement>(selector:string) => document.querySelector<T>(selector)!;
const number = (value:string|number=0) => Number(value).toLocaleString('ko-KR');
const imageUrl = (creature:Creature) => `/creatures/${creature.catalogId ?? creature.imagePath.match(/PG-\d{3}/)?.[0] ?? 'PG-001'}.png`;
const escapeHtml = (value:unknown) => String(value ?? '').replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]!));

async function request<T>(path:string, options:RequestInit={}):Promise<T>{
  if(!sessionToken){const session=await fetch(`${API}/api/session`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!session.ok)throw new Error('세션을 만들 수 없습니다.');sessionToken=(await session.json()).token;localStorage.setItem('punchgrow-session',sessionToken)}
  const response=await fetch(`${API}${path}`,{...options,headers:{'content-type':'application/json',authorization:`Bearer ${sessionToken}`,...options.headers}});
  const data=await response.json().catch(()=>({error:'응답을 읽지 못했습니다.'}));
  if(!response.ok) throw new Error(data.error ?? `요청 실패 (${response.status})`);
  return data as T;
}

function toast(message:string,error=false){const el=$('#toast');el.textContent=message;el.className=`toast show${error?' error':''}`;window.setTimeout(()=>el.className='toast',2600)}
function card(c:Creature){return `<article class="creature-card"><div class="art"><img loading="lazy" src="${imageUrl(c)}" alt="${escapeHtml(c.koName)} 크리처" /></div><div class="meta"><span class="id">${escapeHtml(c.catalogId ?? c.imagePath.match(/PG-\d{3}/)?.[0] ?? '')}</span><h3>${escapeHtml(c.koName)} <small>${escapeHtml(c.enName)}</small></h3><span class="badge ${escapeHtml(c.rarity)}">${escapeHtml(c.rarity)}</span>${c.uniqueColor?'<span class="badge">UNIQUE</span>':''}</div></article>`}

async function loadState(){
  state=await request<State>('/api/game-state');
  $('#balance').textContent=number(state.tokenBalance); $('#pity').textContent=`${state.pityCount} / 300`;
  const claude=Number(state.weeklyUsage.claude_code??0),codex=Number(state.weeklyUsage.codex??0),total=claude+codex;
  $('#weekly-total').textContent=number(total);$('#claude-total').textContent=number(claude);$('#codex-total').textContent=number(codex);
  $('#claude-bar').style.width=`${total?claude/total*100:0}%`;$('#codex-bar').style.width=`${total?codex/total*100:0}%`;
  const latest=state.creatures[0];
  $('#featured-creature').className=latest?'featured':'featured-empty';
  $('#featured-creature').innerHTML=latest?`<img src="${imageUrl(latest)}" alt="${escapeHtml(latest.koName)}"/><h3>${escapeHtml(latest.koName)}</h3><p>${escapeHtml(latest.rarity)} · LV.${latest.level}</p>`:'<span>NO CREATURE</span><small>첫 크리처를 깨워보세요</small>';
  $('#my-creatures').innerHTML=state.creatures.length?state.creatures.slice(0,4).map(card).join(''):'<div class="empty-state">아직 둥지가 조용합니다. 첫 크리처를 깨워보세요.</div>';
  $('#growth-creatures').innerHTML=state.creatures.length?state.creatures.map(c=>`<article class="growth-card"><img src="${imageUrl(c)}" alt="${escapeHtml(c.koName)}"/><div><h3>${escapeHtml(c.koName)}</h3><p>LV.${c.level} · EXP ${number(c.experience)}</p><p>친밀도 ${c.affection}/100</p><button class="feed-button" data-feed="${escapeHtml(c.id)}">먹이 주기 +100 EXP</button></div></article>`).join(''):'<div class="empty-state">성장시킬 크리처가 없습니다.</div>';
  $('#items').innerHTML=state.items.length?state.items.map(i=>`<div class="item-row"><span>${i.itemType==='food'?'먹이':i.itemType}</span><strong>× ${i.quantity}</strong></div>`).join(''):'<div class="item-row"><span>먹이</span><strong>× 0</strong></div>';
  document.querySelectorAll<HTMLButtonElement>('[data-feed]').forEach(b=>b.onclick=()=>feed(b.dataset.feed!));
  $('#gacha-button').toggleAttribute('disabled',BigInt(state.tokenBalance)<BigInt(state.gachaCost));
}

async function gacha(){
  const button=$<HTMLButtonElement>('#gacha-button');button.disabled=true;button.textContent='신호 해독 중…';
  try{const result=await request<{creature:Creature}>('/api/gacha',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID()})});toast(`${result.creature.koName} · ${result.creature.rarity} 등장!`);await loadState()}
  catch(error){toast((error as Error).message,true)}finally{button.textContent='크리처 깨우기 ↗';if(state)button.disabled=BigInt(state.tokenBalance)<BigInt(state.gachaCost)}
}
async function feed(creatureId:string){try{await request('/api/inventory/use',{method:'POST',body:JSON.stringify({creatureId,itemType:'food'})});toast('먹이를 주었습니다. EXP +100');await loadState()}catch(error){toast((error as Error).message,true)}}

async function loadCatalog(reset=false){
  if(reset){catalogOffset=0;$('#catalog-grid').innerHTML=''}
  const params=new URLSearchParams({limit:'48',offset:String(catalogOffset)});const search=$<HTMLInputElement>('#search').value.trim(),rarity=$<HTMLSelectElement>('#rarity-filter').value,category=$<HTMLSelectElement>('#category-filter').value;
  if(search)params.set('search',search);if(rarity)params.set('rarity',rarity);if(category)params.set('category',category);
  try{const result=await request<Catalog>(`/api/catalog?${params}`);$('#catalog-grid').insertAdjacentHTML('beforeend',result.items.map(card).join('')||'<div class="empty-state">조건에 맞는 크리처가 없습니다.</div>');catalogOffset+=result.items.length;$('#catalog-count').textContent=String(result.total);$('#load-more').hidden=catalogOffset>=result.total}
  catch(error){toast((error as Error).message,true)}
}

function navigate(name:string){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`${name}-view`));document.querySelectorAll('[data-nav]').forEach(v=>v.classList.toggle('active',(v as HTMLElement).dataset.nav===name));location.hash=name;window.scrollTo({top:0});if(name==='catalog'&&!$('#catalog-grid').children.length)loadCatalog(true)}
document.querySelectorAll<HTMLElement>('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav!));
$('#gacha-button').onclick=gacha;$('#load-more').onclick=()=>loadCatalog();
for(const selector of ['#rarity-filter','#category-filter'])$(selector).addEventListener('change',()=>loadCatalog(true));
$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=window.setTimeout(()=>loadCatalog(true),250)});

navigate(['home','catalog','inventory'].includes(location.hash.slice(1))?location.hash.slice(1):'home');
loadState().catch(error=>toast(`서버 연결 실패: ${(error as Error).message}`,true));
