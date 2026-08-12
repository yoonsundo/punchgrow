#!/usr/bin/env python3
"""PunchGrow 크리처 진화 연속성 QA 게이트.

production/catalog/creatures.json 의 evolutionFrom 참조로 진화 그래프(엣지 목록,
연결 요소)를 구성하고, 문서/CREATURE_DESIGN_BIBLE.md 81~95행에 명시된 진화 연속성·
색상 규정을 근거로 세 가지 데이터 검사를 수행한다.

  a. normal_evolution 엣지의 bodyForm 변경 (위반)
  b. 모든 엣지의 발광색(palette.glow) RGB 유클리드 거리 > 120 (위반)
  c. 모든 엣지의 primary+glow 거리 합 > 350 (참고 정보)

결과는 production/reports/ 아래 JSON·Markdown·HTML 3종으로 기록한다. 보고 전용
게이트이므로 위반이 있어도 exit 0 이며, 카탈로그 로드에 실패한 경우에만 exit 1 이다.
"""
import html
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "production/catalog/creatures.json"
REPORTS_DIR = ROOT / "production/reports"
JSON_OUTPUT_PATH = REPORTS_DIR / "continuity-gate.json"
MD_OUTPUT_PATH = REPORTS_DIR / "continuity-gate.md"
HTML_OUTPUT_PATH = REPORTS_DIR / "continuity-review.html"

# continuity-review.html 기준 macOS 스프라이트 리소스까지의 상대 경로.
SPRITE_REL_DIR = "../../macos/Sources/PunchGrowMenuBar/Resources/Creatures"
DESIGN_BIBLE_REF = "문서/CREATURE_DESIGN_BIBLE.md 81~95행"

GLOW_DISTANCE_THRESHOLD = 120
PALETTE_JUMP_THRESHOLD = 350

LINEAGE_STAGE_REF_RE = re.compile(r"^(PG-L\d+):S(\d+)$")
DIRECT_ID_REF_RE = re.compile(r"^PG-\d+$")

CATEGORY_LABELS = {
    "start": "시작형",
    "normal_evolution": "일반 진화",
    "branch": "분기 진화",
    "mixed": "혼합 진화",
    "special": "특수 진화",
    "mutant": "변이형",
}


def hex_to_rgb(hex_value):
    hex_value = hex_value.lstrip("#")
    return tuple(int(hex_value[i : i + 2], 16) for i in (0, 2, 4))


def rgb_distance(hex_a, hex_b):
    ra, ga, ba = hex_to_rgb(hex_a)
    rb, gb, bb = hex_to_rgb(hex_b)
    return math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2)


def id_num(creature_id):
    return int(creature_id.split("-")[1])


def load_catalog():
    with CATALOG_PATH.open(encoding="utf-8") as stream:
        return json.load(stream)


def resolve_ref(ref, by_id, by_lineage_stage):
    match = LINEAGE_STAGE_REF_RE.match(ref)
    if match:
        lineage_id, stage = match.group(1), int(match.group(2))
        return by_lineage_stage.get((lineage_id, stage))
    if DIRECT_ID_REF_RE.match(ref):
        return ref if ref in by_id else None
    return None


class UnionFind:
    def __init__(self, ids):
        self.parent = {node_id: node_id for node_id in ids}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self.parent[root_a] = root_b


def build_graph(catalog):
    """evolutionFrom 참조를 해석해 엣지 목록과 연결 요소(트리) 목록을 만든다."""
    by_id = {creature["id"]: creature for creature in catalog}
    by_lineage_stage = {
        (creature["lineageId"], creature["stage"]): creature["id"] for creature in catalog
    }

    edges = []
    unresolved_refs = []
    for creature in catalog:
        evolution_from = creature.get("evolutionFrom")
        if evolution_from is None:
            continue
        refs = evolution_from if isinstance(evolution_from, list) else [evolution_from]
        for ref in refs:
            parent_id = resolve_ref(ref, by_id, by_lineage_stage)
            if parent_id is None:
                unresolved_refs.append({"childId": creature["id"], "ref": ref})
            else:
                edges.append((parent_id, creature["id"]))

    union_find = UnionFind(by_id.keys())
    for parent_id, child_id in edges:
        union_find.union(parent_id, child_id)

    tree_members = {}
    for node_id in by_id:
        root = union_find.find(node_id)
        tree_members.setdefault(root, []).append(node_id)
    trees = sorted(
        tree_members.values(), key=lambda members: min(id_num(m) for m in members)
    )

    edges.sort(key=lambda edge: (id_num(edge[1]), id_num(edge[0])))
    unresolved_refs.sort(key=lambda item: id_num(item["childId"]))

    return by_id, edges, unresolved_refs, trees


def check_violations(by_id, edges):
    """세 가지 데이터 검사를 수행해 위반/참고 목록을 반환한다."""
    body_form_breaks_normal = []
    glow_violations = []
    palette_jumps = []

    for parent_id, child_id in edges:
        parent = by_id[parent_id]
        child = by_id[child_id]
        category = child["category"]

        if category == "normal_evolution" and parent["bodyForm"] != child["bodyForm"]:
            body_form_breaks_normal.append(
                {
                    "parentId": parent_id,
                    "childId": child_id,
                    "category": category,
                    "parentBodyForm": parent["bodyForm"],
                    "childBodyForm": child["bodyForm"],
                }
            )

        glow_dist = rgb_distance(parent["palette"]["glow"], child["palette"]["glow"])
        if glow_dist > GLOW_DISTANCE_THRESHOLD:
            glow_violations.append(
                {
                    "parentId": parent_id,
                    "childId": child_id,
                    "category": category,
                    "parentGlow": parent["palette"]["glow"],
                    "childGlow": child["palette"]["glow"],
                    "distance": round(glow_dist, 1),
                }
            )

        primary_dist = rgb_distance(parent["palette"]["primary"], child["palette"]["primary"])
        total_dist = primary_dist + glow_dist
        if total_dist > PALETTE_JUMP_THRESHOLD:
            palette_jumps.append(
                {
                    "parentId": parent_id,
                    "childId": child_id,
                    "category": category,
                    "primaryDistance": round(primary_dist, 1),
                    "glowDistance": round(glow_dist, 1),
                    "totalDistance": round(total_dist, 1),
                }
            )

    return body_form_breaks_normal, glow_violations, palette_jumps


def build_report_data(by_id, edges, trees, unresolved_refs, body_form_breaks_normal,
                       glow_violations, palette_jumps):
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "generatedAt": generated_at,
        "edgeCount": len(edges),
        "treeCount": len(trees),
        "unresolvedRefs": unresolved_refs,
        "bodyFormBreaksNormal": body_form_breaks_normal,
        "glowViolations": glow_violations,
        "paletteJumps": palette_jumps,
        "summary": {
            "edgeCount": len(edges),
            "treeCount": len(trees),
            "unresolvedRefCount": len(unresolved_refs),
            "bodyFormBreaksNormalCount": len(body_form_breaks_normal),
            "glowViolationCount": len(glow_violations),
            "paletteJumpCount": len(palette_jumps),
        },
    }


def write_json_report(report):
    JSON_OUTPUT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def render_markdown_report(report):
    summary = report["summary"]
    lines = [
        "# PunchGrow 진화 연속성 게이트 리포트",
        "",
        f"생성 시각: {report['generatedAt']}",
        f"검사 기준 출처: {DESIGN_BIBLE_REF} (진화 연속성 · 색상 규정)",
        "",
        "## 요약",
        "",
        f"- 엣지: {summary['edgeCount']}개",
        f"- 트리(연결 요소): {summary['treeCount']}개",
        f"- 미해결 참조: {summary['unresolvedRefCount']}건",
        f"- bodyForm 위반 (normal_evolution 엣지): {summary['bodyFormBreaksNormalCount']}건",
        f"- glow 색상 거리 위반 (>{GLOW_DISTANCE_THRESHOLD}): {summary['glowViolationCount']}건",
        f"- palette jump 참고 (primary+glow 거리 합 >{PALETTE_JUMP_THRESHOLD}): {summary['paletteJumpCount']}건",
        "",
        "## 1. bodyForm 위반 (normal_evolution 엣지)",
        "",
        "일반 진화 엣지는 부모와 자식의 bodyForm 이 같아야 한다.",
        "",
    ]

    if report["bodyFormBreaksNormal"]:
        lines.append("| 부모 ID | 자식 ID | 부모 bodyForm | 자식 bodyForm |")
        lines.append("|---|---|---|---|")
        for item in report["bodyFormBreaksNormal"]:
            lines.append(
                f"| {item['parentId']} | {item['childId']} | {item['parentBodyForm']} | "
                f"{item['childBodyForm']} |"
            )
    else:
        lines.append("위반 없음.")
    lines.append("")

    lines.append(f"## 2. glow 색상 거리 위반 (>{GLOW_DISTANCE_THRESHOLD})")
    lines.append("")
    lines.append("모든 엣지에서 부모·자식의 palette.glow RGB 유클리드 거리를 검사한다.")
    lines.append("")
    if report["glowViolations"]:
        lines.append("| 부모 ID | 자식 ID | 카테고리 | 부모 glow | 자식 glow | 거리 |")
        lines.append("|---|---|---|---|---|---|")
        for item in report["glowViolations"]:
            category_label = CATEGORY_LABELS.get(item["category"], item["category"])
            lines.append(
                f"| {item['parentId']} | {item['childId']} | {category_label} | "
                f"{item['parentGlow']} | {item['childGlow']} | {item['distance']} |"
            )
    else:
        lines.append("위반 없음.")
    lines.append("")

    lines.append(f"## 3. palette jump 참고 (primary+glow 거리 합 >{PALETTE_JUMP_THRESHOLD})")
    lines.append("")
    lines.append("위반이 아닌 참고 정보다. 큰 팔레트 도약이 의도된 것인지 검토용으로 남긴다.")
    lines.append("")
    if report["paletteJumps"]:
        lines.append("| 부모 ID | 자식 ID | 카테고리 | primary 거리 | glow 거리 | 합계 |")
        lines.append("|---|---|---|---|---|---|")
        for item in report["paletteJumps"]:
            category_label = CATEGORY_LABELS.get(item["category"], item["category"])
            lines.append(
                f"| {item['parentId']} | {item['childId']} | {category_label} | "
                f"{item['primaryDistance']} | {item['glowDistance']} | {item['totalDistance']} |"
            )
    else:
        lines.append("해당 없음.")
    lines.append("")

    lines.append("## 4. 미해결 참조")
    lines.append("")
    if report["unresolvedRefs"]:
        lines.append("| 자식 ID | 참조 값 |")
        lines.append("|---|---|")
        for item in report["unresolvedRefs"]:
            lines.append(f"| {item['childId']} | {item['ref']} |")
    else:
        lines.append("미해결 참조 없음.")
    lines.append("")

    return "\n".join(lines)


def write_markdown_report(report):
    MD_OUTPUT_PATH.write_text(render_markdown_report(report), encoding="utf-8")


def render_creature_card(creature):
    creature_id = html.escape(creature["id"])
    ko_name = html.escape(creature["koName"])
    stage = creature["stage"]
    body_form = html.escape(creature["bodyForm"])
    category_label = html.escape(CATEGORY_LABELS.get(creature["category"], creature["category"]))
    image_src = html.escape(f"{SPRITE_REL_DIR}/{creature['id']}.png")
    return f"""    <figure class="creature-card">
      <img src="{image_src}" alt="{ko_name}" width="160" loading="lazy">
      <figcaption>
        <strong>{creature_id}</strong> {ko_name}<br>
        {stage}단계 · {body_form}<br>
        <span class="category">{category_label}</span>
      </figcaption>
    </figure>"""


def render_tree_violation_summary(tree_member_set, body_form_breaks_normal, glow_violations,
                                    palette_jumps):
    notes = []
    for item in body_form_breaks_normal:
        if item["childId"] in tree_member_set:
            notes.append(
                "<li class=\"violation\">[위반] bodyForm 변경 · "
                f"{html.escape(item['parentId'])} → {html.escape(item['childId'])} "
                f"({html.escape(item['parentBodyForm'])} → {html.escape(item['childBodyForm'])})</li>"
            )
    for item in glow_violations:
        if item["childId"] in tree_member_set:
            category_label = html.escape(CATEGORY_LABELS.get(item["category"], item["category"]))
            notes.append(
                "<li class=\"violation\">[위반] glow 거리 "
                f"{item['distance']} (&gt;{GLOW_DISTANCE_THRESHOLD}, {category_label}) · "
                f"{html.escape(item['parentId'])} → {html.escape(item['childId'])}</li>"
            )
    for item in palette_jumps:
        if item["childId"] in tree_member_set:
            category_label = html.escape(CATEGORY_LABELS.get(item["category"], item["category"]))
            notes.append(
                "<li class=\"reference\">[참고] palette jump "
                f"{item['totalDistance']} (primary {item['primaryDistance']} + glow "
                f"{item['glowDistance']}, {category_label}) · "
                f"{html.escape(item['parentId'])} → {html.escape(item['childId'])}</li>"
            )
    if not notes:
        return ""
    return f"""    <ul class="tree-notes">
{chr(10).join('      ' + note for note in notes)}
    </ul>
"""


def render_html_report(by_id, trees, body_form_breaks_normal, glow_violations, palette_jumps,
                        generated_at):
    sections = []
    total_cards = 0
    for index, members in enumerate(trees, start=1):
        member_set = set(members)
        ordered_members = sorted(
            members, key=lambda member_id: (by_id[member_id]["stage"], id_num(member_id))
        )
        root_starts = sorted(
            (m for m in ordered_members if by_id[m]["category"] == "start"),
            key=id_num,
        )
        root_label = " + ".join(f"{html.escape(by_id[m]['koName'])}({html.escape(m)})" for m in root_starts)
        cards = "\n".join(render_creature_card(by_id[m]) for m in ordered_members)
        total_cards += len(ordered_members)
        violation_summary = render_tree_violation_summary(
            member_set, body_form_breaks_normal, glow_violations, palette_jumps
        )
        sections.append(
            f"""  <section class="tree-section">
    <h2>트리 {index:02d} · {root_label} <span class="member-count">(구성원 {len(ordered_members)}종)</span></h2>
{violation_summary}    <div class="creature-strip">
{cards}
    </div>
  </section>"""
        )

    body_sections = "\n".join(sections)
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>PunchGrow 진화 연속성 시각 검토</title>
<style>
  body {{
    background: #0A1020;
    color: #F4F7FF;
    font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
    margin: 0;
    padding: 24px;
  }}
  header {{
    margin-bottom: 28px;
  }}
  header h1 {{
    margin: 0 0 6px;
    font-size: 22px;
  }}
  header p {{
    margin: 2px 0;
    color: #9DAECC;
    font-size: 13px;
  }}
  .tree-section {{
    background: #111B31;
    border: 1px solid #263858;
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 18px;
  }}
  .tree-section h2 {{
    margin: 0 0 10px;
    font-size: 15px;
    color: #53E6FF;
  }}
  .member-count {{
    color: #9DAECC;
    font-weight: normal;
    font-size: 12px;
  }}
  .tree-notes {{
    list-style: none;
    margin: 0 0 12px;
    padding: 10px 12px;
    background: #172540;
    border-radius: 8px;
    font-size: 12px;
  }}
  .tree-notes li {{
    padding: 2px 0;
  }}
  .tree-notes li.violation {{
    color: #FF8FA3;
  }}
  .tree-notes li.reference {{
    color: #F4CC54;
  }}
  .creature-strip {{
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 6px;
  }}
  .creature-card {{
    flex: 0 0 auto;
    width: 160px;
    margin: 0;
    background: #172540;
    border-radius: 8px;
    padding: 8px;
    text-align: center;
  }}
  .creature-card img {{
    width: 160px;
    height: 160px;
    object-fit: contain;
    background: #08111F;
    border-radius: 6px;
    display: block;
  }}
  .creature-card figcaption {{
    margin-top: 6px;
    font-size: 11px;
    line-height: 1.5;
    color: #F4F7FF;
  }}
  .creature-card .category {{
    color: #9DAECC;
  }}
</style>
</head>
<body>
<header>
  <h1>PunchGrow 진화 연속성 시각 검토</h1>
  <p>생성 시각: {html.escape(generated_at)}</p>
  <p>검사 기준 출처: {html.escape(DESIGN_BIBLE_REF)}</p>
  <p>트리 {len(trees)}개 · 크리처 {total_cards}종 · 섹션 상단 [위반]/[참고] 표시는 해당 트리 내부 엣지 검사 결과</p>
</header>
{body_sections}
</body>
</html>
"""


def write_html_report(by_id, trees, body_form_breaks_normal, glow_violations, palette_jumps,
                       generated_at):
    html_content = render_html_report(
        by_id, trees, body_form_breaks_normal, glow_violations, palette_jumps, generated_at
    )
    HTML_OUTPUT_PATH.write_text(html_content, encoding="utf-8")


def main():
    try:
        catalog = load_catalog()
    except (OSError, json.JSONDecodeError) as error:
        print(f"카탈로그 로드 실패: {CATALOG_PATH} ({error})", file=sys.stderr)
        return 1

    by_id, edges, unresolved_refs, trees = build_graph(catalog)
    body_form_breaks_normal, glow_violations, palette_jumps = check_violations(by_id, edges)
    report = build_report_data(
        by_id, edges, trees, unresolved_refs, body_form_breaks_normal, glow_violations,
        palette_jumps,
    )

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    write_json_report(report)
    write_markdown_report(report)
    write_html_report(
        by_id, trees, body_form_breaks_normal, glow_violations, palette_jumps,
        report["generatedAt"],
    )

    summary = report["summary"]
    print("PunchGrow 진화 연속성 게이트 검사 완료")
    print(f"- 크리처: {len(catalog)}종, 엣지: {summary['edgeCount']}개, 트리: {summary['treeCount']}개")
    print(f"- 미해결 참조: {summary['unresolvedRefCount']}건")
    print(f"- bodyForm 위반 (normal_evolution): {summary['bodyFormBreaksNormalCount']}건")
    print(f"- glow 색상 거리 위반 (>{GLOW_DISTANCE_THRESHOLD}): {summary['glowViolationCount']}건")
    print(f"- palette jump 참고 (>{PALETTE_JUMP_THRESHOLD}): {summary['paletteJumpCount']}건")
    print("산출물:")
    for path in (JSON_OUTPUT_PATH, MD_OUTPUT_PATH, HTML_OUTPUT_PATH):
        print(f"- {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
