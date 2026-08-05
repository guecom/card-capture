// 덮인 표면은 예외 없이 같은 방법으로 닫힌다 — Kairen-Ref: TSK-000564 (ISS-000246)
//
// 브라우저 게이트(`e2e/int37-dismiss.spec.ts`)는 **지금 있는** 표면을 픽셀로 판정한다.
// 그것만으로는 부족하다: 다음에 새로 생기는 표면은 아무 spec에도 안 걸리고, 결함이 다시
// 들어오는 자리가 정확히 거기다. 지금까지 나가는 방법이 다섯 가지로 갈린 것도 표면이 하나씩
// 늘면서였지, 누가 한 번에 다섯 가지를 만든 게 아니다.
//
// 그래서 여기서는 **소스**를 본다. 덮인 표면을 만드는 문법(`<IonModal>`)이 나타나면 그 안에
// 나가는 조작(`<SheetClose>`)이 있어야 한다. 없으면 단위 시험 단계에서 멈춘다 — 브라우저까지
// 가지 않아도 되고, 새 표면을 만드는 사람이 만드는 그 순간에 배운다.
//
// 예외는 목록으로만 존재한다. 목록에 이름이 없으면 예외가 아니다 — "이건 좀 다르니까"가
// 코드 안에서 조용히 생기지 않게 한다.
//
// ── 접기·펴기도 같은 자리에서 본다 (TSK-000573)
// 덮인 표면을 정리하고 나니 **접는** 조작이 정확히 같은 상태였다: 자리가 하나 늘 때마다 표시를
// 새로 발명해 넷으로 갈렸고, 셋에는 `aria-controls`가 없었다. 원인도 같다 — 문법이 없어서
// 자리마다 다시 만들었다. 그래서 검사도 같은 자리에 둔다. 파일을 나누면 다음 사람은 둘 중
// 하나만 보게 되고, 안 본 쪽에서 같은 결함이 다시 자란다.

/** 검사 대상 파일 하나. */
export interface DismissSource {
  /** 사람에게 보여 줄 경로. */
  file: string;
  /** 파일 내용 그대로. */
  source: string;
}

export interface DismissViolation {
  file: string;
  /** 파일 안에서 몇 번째로 걸린 자리인가 (1부터). */
  ordinal: number;
  /** 왜 걸렸는가 — 사람이 읽고 바로 고칠 수 있는 문장. */
  reason: string;
}

/** 어느 문법을 어겼는가. 두 규칙이 한 목록으로 나올 때 사람이 구분할 수 있게 붙인다. */
export type GrammarRule = '나가기' | '접기';

export interface GrammarViolation extends DismissViolation {
  rule: GrammarRule;
}

/**
 * 나가는 조작을 갖지 않아도 되는 표면.
 *
 * 여기에 이름을 더하는 것은 "이 표면은 사용자가 나갈 수 없다"고 선언하는 일이다.
 * 그만한 이유가 없으면 더하지 않는다.
 */
export const DISMISS_EXCEPTIONS: readonly { className: string; why: string }[] = Object.freeze([
  Object.freeze({
    className: 'name-onboard-modal',
    // 첫 실행에 촬영자 이름을 받는 자리. 이름 없이 지나가면 이후 모든 캡처가 "누가 찍었는지"를
    // 잃는다. `backdropDismiss={false}`도 같은 이유로 붙어 있다 (ISS-000091 항목 17).
    why: '첫 실행 이름 게이트 — 이름 없이 지나가면 모든 캡처가 촬영자를 잃는다',
  }),
]);

const SURFACE_OPEN = '<IonModal';
const SURFACE_CLOSE = '</IonModal>';
const DISMISS_CONTROL = '<SheetClose';

/** 표면 하나의 소스 조각을 잘라 낸다. 여는 태그부터 닫는 태그까지. */
function surfaceSlice(source: string, start: number): string {
  const end = source.indexOf(SURFACE_CLOSE, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/** 여는 태그 안에 선언된 예외 이름이 있으면 그 예외를 돌려준다. */
function declaredException(slice: string): (typeof DISMISS_EXCEPTIONS)[number] | undefined {
  const openTagEnd = slice.indexOf('>');
  const openTag = openTagEnd === -1 ? slice : slice.slice(0, openTagEnd);
  return DISMISS_EXCEPTIONS.find((exception) => openTag.includes(exception.className));
}

/**
 * 문법을 어긴 표면을 모두 찾는다.
 *
 * 빈 배열이 PASS다. 파일 순서·표면 순서를 그대로 유지해 결과가 실행마다 흔들리지 않는다.
 */
export function findDismissViolations(sources: readonly DismissSource[]): DismissViolation[] {
  const violations: DismissViolation[] = [];

  for (const { file, source: raw } of sources) {
    /* 주석은 코드가 아니다. 설명 안의 `<IonModal>`을 표면으로 세면 글을 판정하게 되고,
       반대로 주석 안의 `<SheetClose>`를 조작으로 세면 없는 조작을 있다고 읽는다. */
    const source = blankComments(raw);
    let cursor = source.indexOf(SURFACE_OPEN);
    let ordinal = 0;

    while (cursor !== -1) {
      ordinal += 1;
      const slice = surfaceSlice(source, cursor);
      const exception = declaredException(slice);

      if (!exception && !slice.includes(DISMISS_CONTROL)) {
        violations.push({
          file,
          ordinal,
          reason: `덮인 표면에 나가는 조작이 없다. \`<SheetClose slot="end" onClose={…} />\`을 헤더 오른쪽에 두거나, 정말 나갈 수 없는 표면이라면 \`DISMISS_EXCEPTIONS\`에 이유와 함께 등록한다.`,
        });
      }

      /* 예외로 선언해 놓고 나가는 조작까지 둔 표면은 예외가 아니다. 목록이 실제와 어긋나면
         다음 사람은 목록을 안 믿게 되고, 그 순간 목록은 없는 것과 같다. */
      if (exception && slice.includes(DISMISS_CONTROL)) {
        violations.push({
          file,
          ordinal,
          reason: `\`${exception.className}\`은 나갈 수 없는 표면으로 등록돼 있는데 나가는 조작을 갖고 있다. 둘 중 하나가 낡았다 — \`DISMISS_EXCEPTIONS\`에서 지우거나 조작을 뺀다.`,
        });
      }

      cursor = source.indexOf(SURFACE_OPEN, cursor + SURFACE_OPEN.length);
    }
  }

  return violations;
}

/* ══════════════════════════════════════════════════════════════════════════════
   접었다 펴는 문법 — Kairen-Ref: TSK-000573

   여기서 보는 것은 **접기 조작을 손으로 만들었는가**다. 손으로 만들면 표시·회전각·
   `aria-controls`·손가락 크기를 자리마다 다시 정하게 되고, 실제로 그렇게 갈렸다.

   소스에서 접기 조작이 태어나는 길은 둘이다:
     · `aria-expanded`를 직접 쓴다 (React가 그리는 접기 조작)
     · `<details>`를 쓴다 (브라우저가 세모까지 그려 주는 접기 조작)
   둘 다 공용 조작(`DisclosureToggle`)을 거치지 않은 것이므로 여기서 멈춘다.

   ── 이 검사가 못 보는 것 (알고 남긴다)
   ARIA를 아예 안 쓰고 버튼 + 조건부 `div`로만 만든 접기는 소스에 표식이 없어 여기서도,
   브라우저 게이트에서도 안 잡힌다. 그건 접기 조작이 아니라 **접근성 결함**이고, 그 결함은
   `accessible-surface.spec.ts`의 접근 이름·키보드 계약이 다루는 영역이다. 이 규칙이 그것까지
   잡는 척하지 않는다.
   ══════════════════════════════════════════════════════════════════════════════ */

/** 접기 문법을 **만드는** 원본. 여기서만 `aria-expanded`를 직접 쓴다. */
const DISCLOSURE_PRIMITIVE = 'components/DisclosureToggle.tsx';

/** 소스에서 접기 조작이 태어나는 두 가지 문법. */
const DISCLOSURE_SYNTAX: readonly { token: string; how: string }[] = Object.freeze([
  Object.freeze({ token: 'aria-expanded', how: '`aria-expanded`를 직접 쓴 접기 조작' }),
  Object.freeze({ token: '<details', how: '브라우저가 세모를 그리는 `<details>` 접기' }),
]);

/**
 * 주석을 공백으로 지운다. 길이는 그대로 둬서 뒤의 위치 계산이 어긋나지 않게 한다.
 *
 * 주석까지 세면 "예전에는 `<details>`였다"라고 **설명한** 자리가 위반으로 잡힌다. 그러면
 * 다음 사람은 규칙을 지키는 대신 주석에서 낱말을 지우게 되고, 그 순간 이 검사는 코드가 아니라
 * 글을 판정하는 것이 된다.
 *
 * 그래서 문자열·정규식 상태를 따라가며 훑는다. 셋 다 필요하다 — 실제로 겪은 것들이다:
 *   · 문자열 안의 `https://`를 주석으로 읽으면 그 줄의 진짜 위반이 같이 지워진다.
 *   · `PersonDocument.tsx`의 `/https?:\/\/[^\s"']+/`는 정규식인데, 그 안의 `"`를 문자열
 *     시작으로 읽으면 뒤따르는 주석을 못 알아보고 40줄 뒤의 설명이 위반으로 잡혔다.
 */
function blankComments(source: string): string {
  const out = source.split('');
  /* 이 문자 다음에 오는 `/`는 나눗셈이 아니라 정규식의 시작이다.
     `<`는 일부러 뺐다 — JSX의 닫는 태그(`</div>`)가 전부 `<` 다음의 `/`이고, 그것을 정규식
     시작으로 읽으면 같은 줄 뒤에 오는 JSX 주석을 못 알아본다. `x < /re/.test(y)`처럼
     `<` 다음에 진짜 정규식이 오는 표현은 이 저장소에 없으므로 잃는 것이 없다. */
  const beforeRegex = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '>', '\n']);
  let index = 0;
  let previous = '';

  while (index < source.length) {
    const char = source[index];

    if (char === '"' || char === "'" || char === '`') {
      index += 1;
      while (index < source.length && source[index] !== char) { index += source[index] === '\\' ? 2 : 1; }
      index += 1;
      previous = char;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index += 1; }
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) { if (source[index] !== '\n') out[index] = ' '; index += 1; }
      continue;
    }

    if (char === '/' && beforeRegex.has(previous)) {
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index];
        if (inner === '\\') { index += 2; continue; }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
        else if (inner === '\n') break;
        index += 1;
      }
      index += 1;
      previous = '/';
      continue;
    }

    if (char.trim()) previous = char;
    else if (char === '\n') previous = '\n';
    index += 1;
  }

  return out.join('');
}

/**
 * 공용 조작을 쓰지 않아도 되는 자리.
 *
 * `aria-expanded`는 접기 조작만의 것이 아니다 — combobox·menubutton·treeitem도 같은 속성을
 * 쓰고, 그것들은 애초에 "접었다 펴는 영역"이 아니라 다른 패턴이다. 그런 자리가 생기면 여는
 * 태그 안에 아래 `marker`를 적고 여기에 이유를 남긴다. 목록에 이름이 없으면 예외가 아니다.
 *
 * 지금은 비어 있다. 이 앱에는 combobox도 menubutton도 없고, `aria-expanded`를 쓰는 자리는
 * 전부 진짜 접기 조작이다. 규칙이 실제로 작동하는지는 합성 소스로 시험한다 — 예외를 만들려고
 * 예외를 넣지 않는다.
 */
export const DISCLOSURE_EXCEPTIONS: readonly { marker: string; why: string }[] = Object.freeze([]);

/** 이 자리를 감싼 JSX 여는 태그를 대략 잘라 낸다. 예외 표식이 같은 태그 안에 있는지 보기 위해서다. */
function enclosingTag(source: string, at: number): string {
  const open = source.lastIndexOf('<', at);
  const close = source.indexOf('>', at);
  return source.slice(open === -1 ? Math.max(0, at - 200) : open, close === -1 ? source.length : close + 1);
}

/**
 * 공용 조작을 거치지 않은 접기 조작을 모두 찾는다.
 *
 * 빈 배열이 PASS다. `DisclosureToggle` 자신은 문법의 원본이므로 건너뛴다 — 원본까지 걸면
 * 규칙을 만족시킬 방법이 없어진다.
 */
export function findDisclosureViolations(sources: readonly DismissSource[]): DismissViolation[] {
  const violations: DismissViolation[] = [];

  for (const { file, source: raw } of sources) {
    if (file.replace(/\\/g, '/').endsWith(DISCLOSURE_PRIMITIVE)) continue;
    const source = blankComments(raw);

    let ordinal = 0;
    for (const { token, how } of DISCLOSURE_SYNTAX) {
      let cursor = source.indexOf(token);
      while (cursor !== -1) {
        ordinal += 1;
        const tag = enclosingTag(source, cursor);
        const exception = DISCLOSURE_EXCEPTIONS.find((entry) => tag.includes(entry.marker));
        if (!exception) {
          violations.push({
            file,
            ordinal,
            reason: `${how} — 공용 조작을 거치지 않았다. \`<DisclosureToggle open={…} onToggle={…} controls="영역-id">\`로 바꾸거나, 접기가 아닌 다른 패턴(combobox 등)이라면 \`DISCLOSURE_EXCEPTIONS\`에 표식과 이유를 함께 등록한다.`,
          });
        }
        cursor = source.indexOf(token, cursor + token.length);
      }
    }
  }

  return violations;
}

/**
 * 두 문법을 한 번에 훑는다.
 *
 * 나가기와 접기는 원인이 같은 결함이다 — 조작을 자리마다 새로 발명했다. 그래서 검사도 한
 * 자리에서 돌린다. 파일이 갈리면 다음 사람은 둘 중 하나만 보게 된다.
 */
export function findGrammarViolations(sources: readonly DismissSource[]): GrammarViolation[] {
  return [
    ...findDismissViolations(sources).map((violation) => ({ ...violation, rule: '나가기' as const })),
    ...findDisclosureViolations(sources).map((violation) => ({ ...violation, rule: '접기' as const })),
  ];
}
