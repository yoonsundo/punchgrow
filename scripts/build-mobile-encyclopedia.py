#!/usr/bin/env python3
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "production/catalog/creatures.json"
OUTPUT_DIR = ROOT / "output/encyclopedia"
IMAGE_DIR = OUTPUT_DIR / "images"


def build_thumbnail(entry):
    source = ROOT / entry["imagePath"]
    target = IMAGE_DIR / f'{entry["id"]}.webp'
    if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
        return
    from PIL import Image

    image = Image.open(source).convert("RGBA")
    image.thumbnail((520, 520), Image.Resampling.LANCZOS)
    background = Image.new("RGBA", (560, 560), (17, 27, 49, 255))
    background.alpha_composite(image, ((560 - image.width) // 2, (560 - image.height) // 2))
    background.convert("RGB").save(target, "WEBP", quality=82, method=6)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if len(catalog) != 256:
        raise ValueError(f"Expected 256 creatures, found {len(catalog)}")
    for entry in catalog:
        build_thumbnail(entry)

    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = TEMPLATE.replace("__CATALOG__", payload).replace("__EMBEDDED_IMAGES__", "{}")
    (OUTPUT_DIR / "index.html").write_text(html, encoding="utf-8")
    embedded_images = {
        entry["id"]: "data:image/webp;base64," + base64.b64encode(
            (IMAGE_DIR / f'{entry["id"]}.webp').read_bytes()
        ).decode("ascii")
        for entry in catalog
    }
    standalone = TEMPLATE.replace("__CATALOG__", payload).replace(
        "__EMBEDDED_IMAGES__", json.dumps(embedded_images, separators=(",", ":"))
    )
    standalone_path = OUTPUT_DIR / "PunchGrow-도감-모바일.html"
    standalone_path.write_text(standalone, encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(OUTPUT_DIR / "index.html"),
                "standalone": str(standalone_path),
                "creatures": len(catalog),
            },
            ensure_ascii=False,
        )
    )


TEMPLATE = r'''<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#08101f">
  <title>PunchGrow 크리처 도감</title>
  <style>
    :root{--bg:#08101f;--panel:#111b31;--panel2:#172540;--text:#f4f7ff;--muted:#9daecc;--cyan:#53e6ff;--line:#263858;--safe:env(safe-area-inset-bottom,0px)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;min-height:100vh;background-image:linear-gradient(#18304e55 1px,transparent 1px),linear-gradient(90deg,#18304e55 1px,transparent 1px);background-size:28px 28px}
    button,input{font:inherit}.top{position:sticky;top:0;z-index:20;padding:14px 14px 10px;background:#08101fef;backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:12px}.brand h1{font-size:21px;line-height:1;margin:0;letter-spacing:-.04em}.brand h1 span{color:var(--cyan)}.count{font-size:12px;color:var(--muted)}
    .search{width:100%;height:44px;border:1px solid #315071;border-radius:13px;color:var(--text);background:#111b31;padding:0 14px;outline:none}.search:focus{border-color:var(--cyan);box-shadow:0 0 0 3px #53e6ff1b}
    .filters{display:flex;gap:7px;overflow:auto;padding:10px 0 2px;scrollbar-width:none}.filters::-webkit-scrollbar{display:none}.chip{flex:0 0 auto;border:1px solid #315071;background:#111b31;color:var(--muted);border-radius:999px;padding:7px 11px;font-size:12px}.chip.active{background:var(--cyan);border-color:var(--cyan);color:#06101b;font-weight:700}
    main{max-width:1120px;margin:auto;padding:14px 12px calc(36px + var(--safe))}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:80px 20px}
    .card{position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--rarity),#263858 55%);border-radius:17px;background:var(--panel);padding:0;text-align:left;color:var(--text);min-width:0;box-shadow:0 7px 28px #0004}.card:active{transform:scale(.985)}.art{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:var(--panel2)}.body{padding:10px}.eyebrow{display:flex;justify-content:space-between;gap:6px;color:var(--rarity);font-size:10px}.name{font-size:16px;font-weight:750;margin:5px 0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.glow{position:absolute;right:9px;top:9px;width:10px;height:10px;border-radius:50%;background:var(--glow);box-shadow:0 0 12px var(--glow)}
    dialog{width:min(720px,100%);height:min(94dvh,860px);max-width:none;margin:auto 0 0;padding:0;border:0;border-radius:24px 24px 0 0;background:var(--panel);color:var(--text);box-shadow:0 -20px 80px #000b}dialog::backdrop{background:#020714cc;backdrop-filter:blur(4px)}.sheet{height:100%;overflow:auto;padding-bottom:calc(24px + var(--safe))}.hero{position:relative}.hero img{width:100%;aspect-ratio:1.45;display:block;object-fit:contain;background:radial-gradient(circle at 50% 50%,#1c3354,#0d1729 70%)}.close{position:absolute;top:12px;right:12px;border:1px solid #ffffff33;background:#08101fcc;color:#fff;width:38px;height:38px;border-radius:50%;font-size:21px}.detail{padding:18px}.detail-head{display:flex;justify-content:space-between;gap:12px}.detail h2{font-size:27px;margin:3px 0}.english{color:var(--muted);font-size:13px}.badge{align-self:start;border:1px solid var(--rarity);color:var(--rarity);border-radius:999px;padding:6px 9px;font-size:11px}.identity{font-size:16px;line-height:1.55;margin:18px 0 10px}.lore{color:var(--muted);line-height:1.65;font-size:14px}.section{margin-top:22px}.section h3{font-size:12px;color:var(--cyan);letter-spacing:.08em}.dna{display:grid;gap:8px}.dna div{background:var(--panel2);border-radius:11px;padding:11px 12px;font-size:13px}.palette{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.swatch{border-radius:11px;padding:12px 8px 9px;background:var(--panel2);font-size:10px;color:var(--muted)}.swatch i{display:block;height:30px;border-radius:8px;margin-bottom:8px;background:var(--color);box-shadow:0 0 18px color-mix(in srgb,var(--color),transparent 45%)}
    .top-button{position:fixed;right:15px;bottom:calc(15px + var(--safe));z-index:12;width:44px;height:44px;border:1px solid #53e6ff88;border-radius:50%;background:#111b31dd;color:var(--cyan);box-shadow:0 8px 30px #0008}
    @media(min-width:600px){.grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.top{padding-left:max(24px,calc((100% - 1080px)/2));padding-right:max(24px,calc((100% - 1080px)/2))}.card:hover{transform:translateY(-3px);border-color:var(--rarity)}dialog{margin:auto;border-radius:24px}}
    @media(min-width:920px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
</head>
<body>
  <header class="top">
    <div class="brand"><h1>PUNCHGROW <span>크리처 도감</span></h1><div class="count" id="count">256종</div></div>
    <input id="search" class="search" type="search" placeholder="이름, ID, 계열, 설명 검색" autocomplete="off">
    <div class="filters" id="filters"></div>
  </header>
  <main><div class="grid" id="grid"></div></main>
  <button class="top-button" aria-label="맨 위로" onclick="scrollTo({top:0,behavior:'smooth'})">↑</button>
  <dialog id="detailDialog"><div class="sheet" id="sheet"></div></dialog>
  <script id="catalogData" type="application/json">__CATALOG__</script>
  <script id="embeddedImages" type="application/json">__EMBEDDED_IMAGES__</script>
  <script>
    const catalog=JSON.parse(document.getElementById('catalogData').textContent);
    const embeddedImages=JSON.parse(document.getElementById('embeddedImages').textContent);
    const imageSource=id=>embeddedImages[id]||`images/${id}.webp`;
    const colors={PROCESS:'#72d6c9',AGENT:'#63b3ff',DAEMON:'#ad83ff',ORACLE:'#ff8fcb',ARCHITECT:'#f4cc54',ORIGIN:'#ff7a59'};
    const categories={start:'시작형',normal_evolution:'일반 진화',branch:'분기 진화',mixed:'혼합 진화',special:'특수 진화',mutant:'변이형'};
    const rarityOrder=['전체','PROCESS','AGENT','DAEMON','ORACLE','ARCHITECT','ORIGIN'];
    let active='전체',query='';
    const grid=document.getElementById('grid'),count=document.getElementById('count'),dialog=document.getElementById('detailDialog'),sheet=document.getElementById('sheet');
    document.getElementById('filters').innerHTML=rarityOrder.map(x=>`<button class="chip ${x==='전체'?'active':''}" data-filter="${x}">${x}</button>`).join('');
    document.getElementById('filters').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;active=b.dataset.filter;document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x===b));render()});
    document.getElementById('search').addEventListener('input',e=>{query=e.target.value.trim().toLowerCase();render()});
    const searchable=x=>[x.id,x.koName,x.enName,x.lineageId,x.identity,x.lore,x.bodyForm,...x.shapeDNA].join(' ').toLowerCase();
    function render(){const items=catalog.filter(x=>(active==='전체'||x.rarity===active)&&(!query||searchable(x).includes(query)));count.textContent=`${items.length} / 256종`;grid.innerHTML=items.length?items.map(card).join(''):'<div class="empty">조건에 맞는 크리처가 없습니다.</div>'}
    function card(x){return `<button class="card" style="--rarity:${colors[x.rarity]};--glow:${x.palette.glow}" onclick="openDetail('${x.id}')"><span class="glow"></span><img class="art" src="${imageSource(x.id)}" loading="lazy" alt="${x.koName}"><span class="body"><span class="eyebrow"><b>${x.id}</b><b>${x.rarity}</b></span><span class="name">${x.koName}</span><span class="meta">${categories[x.category]||x.category} · ${x.stage}단계 · ${x.bodyForm}</span></span></button>`}
    function openDetail(id){const x=catalog.find(v=>v.id===id);sheet.style.setProperty('--rarity',colors[x.rarity]);sheet.innerHTML=`<div class="hero"><img src="${imageSource(x.id)}" alt="${x.koName}"><button class="close" onclick="detailDialog.close()">×</button></div><div class="detail"><div class="detail-head"><div><div class="english">${x.id} · ${x.enName} · ${x.lineageId}</div><h2>${x.koName}</h2><div class="english">${categories[x.category]||x.category} · ${x.stage}단계 · ${x.bodyForm}</div></div><div class="badge">${x.rarity}</div></div><p class="identity">${x.identity}</p><p class="lore">${x.lore}</p><div class="section"><h3>SHAPE DNA</h3><div class="dna">${x.shapeDNA.map(v=>`<div>${v}</div>`).join('')}</div></div><div class="section"><h3>PALETTE</h3><div class="palette">${Object.entries(x.palette).map(([k,v])=>`<div class="swatch" style="--color:${v}"><i></i>${k.toUpperCase()}<br>${v}</div>`).join('')}</div></div></div>`;dialog.showModal()}
    dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
    render();
  </script>
</body>
</html>'''


if __name__ == "__main__":
    main()
