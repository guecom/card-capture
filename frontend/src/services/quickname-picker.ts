// 명함에서 "이름"을 고르는 공용 픽커 — 글꼴 크기(bbox 높이) 신호가 1순위다.
// 한국 명함은 이름이 거의 항상 카드에서 가장 큰 글자라서, 텍스트 휴리스틱만 쓰던
// 기존 방식보다 오탐(회사명·직함을 이름으로 뽑는 문제)이 크게 준다 (ISS-000096).

export interface OcrWord {
  text: string;
  /** 0..1 (엔진 신뢰도) */
  confidence: number;
  /** 단어·라인 박스 높이 / 이미지 높이 (0..1) */
  heightRatio: number;
  /** 박스 중심 Y / 이미지 높이 (0..1) */
  centerRatio: number;
}

export const BLOCKED_NAME_PATTERN = /주식회사|유한회사|\(주\)|회사|그룹|센터|연구소|대학교|대학|병원|협회|재단|본부|사업부|팀\b|대표이사|대표|이사|부사장|사장|전무|상무|부장|차장|과장|팀장|매니저|책임|선임|수석|주임|사원|프로|파트너|director|manager|president|ceo|cto|coo|cfo|lead|head|company|corporation|corp\.?|inc\.?|ltd\.?|co\.,|team|group|office|tel|fax|mobile|email|kakao/i;

const HANGUL_NAME = /^[가-힣]{2,4}$/;
const ENGLISH_NAME = /^[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}$/;

function lineIsNoise(text: string): boolean {
  return /@|https?:|www\.|\.com|\.kr|\d{2,}/.test(text);
}

export interface PickedName {
  name: string;
  /** 0..100 */
  confidence: number;
}

export function nameFromOcrWords(words: OcrWord[]): PickedName | null {
  let best: { name: string; score: number; confidence: number } | null = null;

  for (const word of words) {
    const line = word.text.replace(/\s+/g, ' ').trim();
    if (!line || lineIsNoise(line)) continue;
    if (word.confidence < 0.35) continue;

    const tokens = line.split(' ').filter(Boolean);
    const candidates: Array<{ name: string; bonus: number }> = [];

    // 라인 전체가 이름 형태면 최우선 (이름은 보통 한 줄을 단독으로 쓴다).
    if (HANGUL_NAME.test(line) && !BLOCKED_NAME_PATTERN.test(line)) candidates.push({ name: line, bonus: 40 });
    else if (ENGLISH_NAME.test(line) && !BLOCKED_NAME_PATTERN.test(line)) candidates.push({ name: line, bonus: 30 });
    else {
      // "홍길동 대표이사"처럼 직함이 같은 줄에 붙는 경우 — 토큰 단위로 이름만 뽑는다.
      for (const token of tokens) {
        if (HANGUL_NAME.test(token) && !BLOCKED_NAME_PATTERN.test(token)) candidates.push({ name: token, bonus: 12 });
      }
      const english = line.match(/[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}/g) ?? [];
      for (const match of english) {
        if (!BLOCKED_NAME_PATTERN.test(match)) candidates.push({ name: match, bonus: 8 });
      }
    }

    for (const candidate of candidates) {
      // 글꼴 크기(heightRatio)가 지배 신호. 위쪽 절반 배치·신뢰도·형태 보너스가 보조.
      const score = word.heightRatio * 400
        + word.confidence * 40
        + (word.centerRatio < 0.55 ? 8 : 0)
        + (/^[가-힣]/.test(candidate.name) ? 6 : 0)
        + candidate.bonus;
      if (!best || score > best.score) {
        best = { name: candidate.name, score, confidence: word.confidence };
      }
    }
  }

  if (!best) return null;
  return { name: best.name, confidence: Math.max(0, Math.min(100, Math.round(best.confidence * 100))) };
}
