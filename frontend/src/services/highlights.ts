// `지금 알아둘 것` — 인물 전문을 열었을 때 맨 위에 뜨는 1~3줄 (INT-000013 피드백 005).
//
// 자유 요약이 아니다. 처리 계약이 이미 정해 둔 섹션(최근 활동·대화 포인트·Kairen 관점)에서
// 문장을 **그대로 인용**하고, 어느 섹션에서 왔는지와 언제 확인된 기록인지를 함께 보여 준다.
// 해당 섹션이 없으면 아무것도 만들지 않는다 — 채워 넣은 요약은 근거가 없기 때문이다.
import { inlineMarkdown, parsePersonFrontmatter } from './markdown';

export type HighlightKind = 'recent' | 'talking-point' | 'kairen';

export interface Highlight {
  kind: HighlightKind;
  /** 인물 문서에서 그대로 가져온 문장 */
  text: string;
  /** 어느 섹션에서 왔는지 (사용자에게 그대로 보여 준다) */
  sourceSection: string;
}

export interface HighlightSet {
  items: Highlight[];
  /** 이 기록이 마지막으로 확인된 시점 (frontmatter 근거, 없으면 null) */
  checkedAt: string | null;
}

interface KindRule {
  kind: HighlightKind;
  heading: RegExp;
  label: string;
}

// 우선순위 순서. 같은 종류는 한 줄만 쓴다.
const KIND_RULES: KindRule[] = [
  { kind: 'recent', heading: /최근\s*활동|최근\s*소식|근황|최근\s*변화|recent/i, label: '최근 변화' },
  { kind: 'talking-point', heading: /대화\s*포인트|만나기?\s*전|알면\s*좋은|talking\s*point/i, label: '다음 대화 단서' },
  { kind: 'kairen', heading: /kairen\s*관점|kairen과|접점|협업\s*가능/i, label: 'Kairen 접점' },
];

const NOISE = /^(없음|미확인|해당\s*없음|N\/A|-|확인되지\s*않|추가\s*조사)/i;

function cleanLine(line: string): string {
  return inlineMarkdown(line)
    .replace(/^\s*(?:[-*•]|\d+\.)\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 섹션 제목 아래 첫 번째 쓸 만한 문장. 표·빈 줄·"없음" 같은 자리표시자는 건너뛴다.
function firstStatement(lines: string[], startIndex: number): string | null {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^#{1,6}\s/.test(raw)) return null;
    if (/^\s*\|/.test(raw)) continue;
    const text = cleanLine(raw);
    if (!text || text.length < 6) continue;
    if (NOISE.test(text)) continue;
    return text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text;
  }
  return null;
}

export function buildHighlights(markdown: string, limit = 3): HighlightSet {
  const parsed = parsePersonFrontmatter(markdown);
  const lines = parsed.body.split('\n');
  const items: Highlight[] = [];

  KIND_RULES.forEach((rule) => {
    if (items.some((item) => item.kind === rule.kind)) return;
    for (let index = 0; index < lines.length; index += 1) {
      const heading = /^#{2,6}\s+(.*)$/.exec(lines[index]);
      if (!heading || !rule.heading.test(heading[1])) continue;
      const text = firstStatement(lines, index);
      if (!text) continue;
      if (items.some((item) => item.text === text)) break;
      items.push({ kind: rule.kind, text, sourceSection: cleanLine(heading[1]) || rule.label });
      break;
    }
  });

  const checkedAt = parsed.vals.last_contacted || parsed.vals.updatedAt || parsed.vals.reviewedAt || null;
  return { items: items.slice(0, limit), checkedAt };
}

export function highlightLabel(kind: HighlightKind): string {
  return KIND_RULES.find((rule) => rule.kind === kind)?.label ?? '기록';
}
