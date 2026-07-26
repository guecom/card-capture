// 명함에서 "사람 이름"을 고르는 공용 픽커.
//
// v1은 "카드에서 가장 큰 글자 = 이름"으로 가정했다(heightRatio * 400). 로고를 크게 넣는
// 명함에서는 이 가정이 정반대로 작동한다 — founder 본인 명함이 그 예다(`KAIREN`이 이름보다 크다).
// 그래서 회사명을 이름으로 뽑는 오탐이 잦았다 (ISS-000096, founder 판정 2026-07-26).
//
// v2는 글꼴 크기를 여러 신호 중 하나로 낮추고, 사람 이름에만 있는 신호를 함께 본다:
//   - 한국 성씨 prior: 2~4자 한글 후보는 실제 성씨로 시작해야 한다 (카이렌·로보틱스 제거).
//   - 직함 인접: 바로 위/아래 줄이 직함이면 그 줄은 이름일 확률이 매우 높다.
//   - 이메일 대조: 이메일 아이디에 같은 토큰이 있으면 사람 이름이다 (jinwoo@... ↔ Jinwoo).
//   - 전부 대문자 영문은 로고로 보고 감점한다 (KAIREN ROBOTICS ↔ Jane Kim).
// 확신 가는 후보가 없으면 null을 돌려준다 — 틀린 이름을 채우는 것보다 비워두는 편이 낫다.

export interface OcrWord {
  text: string;
  /** 0..1 (엔진 신뢰도) */
  confidence: number;
  /** 단어·라인 박스 높이 / 이미지 높이 (0..1) */
  heightRatio: number;
  /** 박스 중심 Y / 이미지 높이 (0..1) */
  centerRatio: number;
  /** 박스 왼쪽 X / 이미지 너비 (0..1). 같은 줄을 다시 붙일 때 순서를 정한다. */
  leftRatio?: number;
}

// OCR이 테두리·세로획을 글자로 잘못 붙이는 것을 떼어낸다 ("Jane |" → "Jane").
function sanitizeLine(text: string): string {
  return String(text).replace(/[|_\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 두 박스가 같은 시각적 줄에 있는지를 "세로 구간이 실제로 겹치는가"로 본다.
// 그룹 첫 박스의 중심만 기준으로 삼으면, 잡음이 붙어 박스가 커진 줄("Jane |")에서 어긋난다.
function sameVisualRow(group: OcrWord[], word: OcrWord): boolean {
  const top = Math.min(...group.map((entry) => entry.centerRatio - entry.heightRatio / 2));
  const bottom = Math.max(...group.map((entry) => entry.centerRatio + entry.heightRatio / 2));
  const wordTop = word.centerRatio - word.heightRatio / 2;
  const wordBottom = word.centerRatio + word.heightRatio / 2;
  const smaller = Math.min(bottom - top, wordBottom - wordTop);
  // 높이 정보가 없는 입력은 중심 거리로만 판단한다.
  if (smaller <= 0) return Math.abs(word.centerRatio - group[0].centerRatio) <= 0.02;
  return (Math.min(bottom, wordBottom) - Math.max(top, wordTop)) / smaller >= 0.34;
}

// 같은 시각적 줄이 여러 박스로 쪼개진 경우를 하나로 되붙인다.
// 실기기·다른 폰트 환경에서 "Jane Kim"이 "Jane |" + "Kim"으로 나뉘는 일이 실제로 있었다.
function mergeVisualLines(words: OcrWord[]): OcrWord[] {
  const sorted = words.slice().sort((a, b) => a.centerRatio - b.centerRatio || (a.leftRatio ?? 0) - (b.leftRatio ?? 0));
  const groups: OcrWord[][] = [];
  for (const word of sorted) {
    const current = groups[groups.length - 1];
    if (current && sameVisualRow(current, word)) current.push(word);
    else groups.push([word]);
  }
  return groups.filter((group) => group.length > 1).map((group) => ({
    text: group.slice().sort((a, b) => (a.leftRatio ?? 0) - (b.leftRatio ?? 0)).map((word) => word.text).join(' '),
    confidence: Math.min(...group.map((word) => word.confidence)),
    heightRatio: Math.max(...group.map((word) => word.heightRatio)),
    centerRatio: group.reduce((total, word) => total + word.centerRatio, 0) / group.length,
    leftRatio: Math.min(...group.map((word) => word.leftRatio ?? 0)),
  }));
}

export const BLOCKED_NAME_PATTERN = /주식회사|유한회사|\(주\)|회사|그룹|센터|연구소|대학교|대학|병원|협회|재단|본부|사업부|팀\b|대표이사|대표|이사|부사장|사장|전무|상무|부장|차장|과장|팀장|매니저|책임|선임|수석|주임|사원|프로|파트너|director|manager|president|ceo|cto|coo|cfo|lead|head|company|corporation|corp\.?|inc\.?|ltd\.?|co\.,|team|group|office|tel|fax|mobile|email|kakao/i;

// 회사·브랜드에서 반복되는 꼬리표. 성씨 prior를 통과하는 단어(로보틱스 등)를 여기서 거른다.
export const COMPANY_WORD_PATTERN = /로보틱스|로보틱|로봇|테크놀로지|테크놀러지|테크|솔루션|시스템즈|시스템|소프트|정보통신|커뮤니케이션|네트웍스|네트워크|전자|산업|중공업|엔지니어링|건설|화학|제약|바이오|메디컬|메디칼|식품|물산|유통|무역|기획|컨설팅|에이전시|파트너스|홀딩스|컴퍼니|모터스|스튜디오|디자인|랩스|연구원|공사|공단|재단법인|사단법인|robotics|technolog|solutions?|systems?|software|networks?|holdings?|partners?|labs?|studio|motors|bio|medical|pharma|industr|engineering|consulting|agency/i;

// 한국 성씨(상위 빈도 중심). 2~4자 한글 후보는 이 중 하나로 시작해야 사람 이름으로 본다.
const KOREAN_SURNAMES = new Set([
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍',
  '유', '고', '문', '양', '손', '배', '백', '허', '남', '심', '노', '하', '곽', '성', '차', '주', '우', '구', '민', '류',
  '나', '진', '지', '엄', '채', '원', '천', '방', '공', '현', '함', '변', '염', '여', '추', '도', '소', '석', '선', '설',
  '마', '길', '위', '표', '명', '기', '반', '왕', '금', '옥', '육', '인', '맹', '제', '모', '탁', '국', '어', '은', '편',
  '용', '봉', '경', '피', '두', '감', '음', '빈', '동', '온', '호', '범', '좌', '팽', '승', '간', '상', '시', '태', '아',
]);
const COMPOUND_SURNAMES = ['남궁', '황보', '제갈', '사공', '선우', '독고', '서문', '동방'];

const HANGUL_NAME = /^[가-힣]{2,4}$/;
const ENGLISH_NAME = /^[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}$/;
const TITLE_PATTERN = /대표이사|대표|이사|부사장|사장|전무|상무|본부장|실장|부장|차장|과장|팀장|매니저|책임|선임|수석|주임|연구원|엔지니어|디자이너|컨설턴트|변호사|회계사|교수|박사|founder|co-?founder|ceo|cto|coo|cfo|president|director|manager|engineer|designer|consultant|partner|head of|lead/i;

function lineIsNoise(text: string): boolean {
  return /@|https?:|www\.|\.com|\.kr|\d{2,}/.test(text);
}

function hasKoreanSurname(name: string): boolean {
  if (COMPOUND_SURNAMES.some((surname) => name.startsWith(surname))) return name.length >= 3;
  return KOREAN_SURNAMES.has(name[0]);
}

// OCR은 `jane.kim@orbital.dev`를 `jane.kim @orbital.dev`처럼 띄워 읽는 일이 잦다 — 공백을 허용한다.
function emailLocalParts(words: OcrWord[]): string[] {
  return words.flatMap((word) => Array.from(String(word.text).matchAll(/([A-Za-z0-9._-]+)\s*@/g)).map((match) => match[1].toLowerCase()));
}

// 이메일 아이디가 이름을 그대로 담고 있으면(`jane.kim`), 쪼개져 나온 줄을 그 순서로 되붙인다.
// 세로 위치가 어긋나 `mergeVisualLines`가 못 붙인 경우에도 근거(이메일)가 있으므로 이름을 복원할 수 있다.
function namesFromEmailParts(words: OcrWord[], locals: string[]): Array<{ name: string; anchor: OcrWord }> {
  const singles = new Map<string, OcrWord>();
  words.forEach((word) => {
    const line = sanitizeLine(word.text);
    if (!/^[A-Za-z'.-]{2,20}$/.test(line)) return;
    const key = line.toLowerCase();
    const previous = singles.get(key);
    if (!previous || word.heightRatio > previous.heightRatio) singles.set(key, word);
  });

  const found: Array<{ name: string; anchor: OcrWord }> = [];
  locals.forEach((local) => {
    const parts = local.split(/[._-]+/).filter((part) => part.length >= 2);
    if (parts.length < 2 || parts.length > 3) return;
    const matched = parts.map((part) => singles.get(part));
    if (matched.some((entry) => !entry)) return;
    const boxes = matched as OcrWord[];
    found.push({
      name: boxes.map((box) => sanitizeLine(box.text)).join(' '),
      anchor: boxes.reduce((tallest, box) => (box.heightRatio > tallest.heightRatio ? box : tallest)),
    });
  });
  return found;
}

// 바로 위·아래 줄(세로 위치 기준)이 직함이면 이 줄은 이름일 확률이 높다.
function nearTitleLine(words: OcrWord[], index: number): boolean {
  const ordered = words.map((word, position) => ({ word, position })).sort((a, b) => a.word.centerRatio - b.word.centerRatio);
  const at = ordered.findIndex((entry) => entry.position === index);
  if (at < 0) return false;
  return [ordered[at - 1], ordered[at + 1]].some((neighbour) => {
    if (!neighbour) return false;
    const text = neighbour.word.text;
    return TITLE_PATTERN.test(text) && Math.abs(neighbour.word.centerRatio - words[index].centerRatio) < 0.22;
  });
}

export interface PickedName {
  name: string;
  /** 0..100 */
  confidence: number;
}

export function nameFromOcrWords(input: OcrWord[]): PickedName | null {
  // 원래 줄 + 같은 줄을 되붙인 줄 + 이메일 아이디로 복원한 줄을 함께 후보로 본다.
  const merged = [...input, ...mergeVisualLines(input)];
  const locals = emailLocalParts(merged);
  const emailMentions = (name: string): boolean => {
    const tokens = name.toLowerCase().split(/[^a-z]+/).filter((token) => token.length >= 3);
    return tokens.length > 0 && locals.some((local) => tokens.some((token) => local.includes(token)));
  };
  const words = [...merged, ...namesFromEmailParts(merged, locals).map(({ name, anchor }) => ({ ...anchor, text: name }))];

  let best: { name: string; score: number; confidence: number } | null = null;
  const seen: string[] = [];

  words.forEach((word, index) => {
    const line = sanitizeLine(word.text);
    if (!line || lineIsNoise(line)) return;

    const titleNeighbour = nearTitleLine(words, index);
    // 신뢰도 바닥은 잡음을 막으려는 것이다. 하지만 직함 줄이 붙어 있거나 이메일이 뒷받침하는 줄은
    // 근거가 따로 있으므로, 인쇄가 흐려 신뢰도만 낮게 나온 이름을 여기서 버리지 않는다.
    const supported = titleNeighbour || emailMentions(line);
    if (word.confidence < (supported ? 0.12 : 0.35)) return;
    const candidates: Array<{ name: string; bonus: number }> = [];

    if (HANGUL_NAME.test(line) && !BLOCKED_NAME_PATTERN.test(line) && !COMPANY_WORD_PATTERN.test(line)) {
      // 줄 전체가 한글 이름 형태 — 성씨로 시작하거나, 직함 줄과 붙어 있어야 사람 이름으로 본다.
      if (hasKoreanSurname(line) || titleNeighbour) candidates.push({ name: line, bonus: 40 });
    } else if (ENGLISH_NAME.test(line) && !BLOCKED_NAME_PATTERN.test(line) && !COMPANY_WORD_PATTERN.test(line)) {
      candidates.push({ name: line, bonus: 30 });
    } else {
      // 자간이 넓은 이름은 OCR이 글자마다 쪼개 놓는다("이 강 윤", "이 강규").
      // 한글 토큰만으로 이루어져 있고 합쳐서 2~4자면 한 이름으로 되돌린다 — 성을 잃어버리는
      // 오탐("이강규" → "강규")의 주된 원인이었다 (founder 판정 2026-07-26).
      const tokens = line.split(' ').filter(Boolean);
      if (tokens.length > 1 && tokens.every((token) => /^[가-힣]+$/.test(token))) {
        const joined = tokens.join('');
        if (HANGUL_NAME.test(joined) && !BLOCKED_NAME_PATTERN.test(joined) && !COMPANY_WORD_PATTERN.test(joined)
          && (hasKoreanSurname(joined) || titleNeighbour)) {
          candidates.push({ name: joined, bonus: 36 });
        }
      }
      // "홍길동 대표이사"처럼 직함이 같은 줄에 붙는 경우 — 토큰 단위로 이름만 뽑는다.
      for (const token of tokens) {
        if (!HANGUL_NAME.test(token)) continue;
        if (BLOCKED_NAME_PATTERN.test(token) || COMPANY_WORD_PATTERN.test(token)) continue;
        if (!hasKoreanSurname(token)) continue;
        candidates.push({ name: token, bonus: 12 });
      }
      for (const match of line.match(/[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}/g) ?? []) {
        if (BLOCKED_NAME_PATTERN.test(match) || COMPANY_WORD_PATTERN.test(match)) continue;
        candidates.push({ name: match, bonus: 8 });
      }
    }

    for (const candidate of candidates) {
      const hangul = /^[가-힣]/.test(candidate.name);
      // 전부 대문자 영문은 로고·회사명일 확률이 높다 (KAIREN ROBOTICS ↔ Jane Kim).
      const shouty = !hangul && candidate.name === candidate.name.toUpperCase();
      const corroborated = emailMentions(candidate.name);
      if (shouty && !corroborated) continue;

      const score = 100
        + word.heightRatio * 220          // 글꼴 크기는 여전히 강한 신호지만 지배 신호는 아니다
        + word.confidence * 30
        + candidate.bonus
        + (hangul && hasKoreanSurname(candidate.name) ? 45 : 0)
        + (titleNeighbour ? 35 : 0)
        + (corroborated ? 40 : 0)
        + (word.centerRatio < 0.55 ? 6 : 0)
        + (hangul ? 6 : 0);
      seen.push(candidate.name);
      if (!best || score > best.score) best = { name: candidate.name, score, confidence: word.confidence };
    }
  });

  if (!best) return null;
  const picked: { name: string; confidence: number } = best;
  // 성이 떨어져 나간 후보 방어: 다른 후보의 끝부분이면 더 긴 쪽이 진짜 이름이다 ("강규" ← "이강규").
  const fuller = seen.find((candidate) => candidate !== picked.name
    && candidate.endsWith(picked.name)
    && candidate.length <= 4
    && /^[가-힣]+$/.test(candidate)
    && hasKoreanSurname(candidate));
  return { name: fuller ?? picked.name, confidence: Math.max(0, Math.min(100, Math.round(picked.confidence * 100))) };
}
