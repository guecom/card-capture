// Kairen-Ref: TSK-000564 · TSK-000573 (ISS-000246)
import { describe, expect, it } from 'vitest';
import {
  DISCLOSURE_EXCEPTIONS,
  DISMISS_EXCEPTIONS,
  findDisclosureViolations,
  findDismissViolations,
  findGrammarViolations,
} from './dismiss-grammar';

/* 앱의 진짜 소스를 읽는다 — 규칙만 시험하면 규칙이 아무 데도 안 걸려 있어도 초록이 된다.
   `research-envelope.test.ts`가 `Code.gs?raw`를 읽는 것과 같은 이유다. */
const modules = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sources = Object.entries(modules)
  .map(([file, source]) => ({ file, source }))
  .sort((left, right) => left.file.localeCompare(right.file));

describe('덮인 표면을 나가는 문법', () => {
  it('앱 소스에 덮인 표면이 실제로 있다 — 검사가 빈 집합을 훑고 있지 않다', () => {
    const withSurfaces = sources.filter((entry) => entry.source.includes('<IonModal'));
    expect(withSurfaces.length).toBeGreaterThan(0);
  });

  it('덮인 표면은 예외 없이 나가는 조작을 갖는다', () => {
    const violations = findDismissViolations(sources);
    const report = violations.map((violation) => `${violation.file} #${violation.ordinal}: ${violation.reason}`).join('\n');
    expect(violations, report).toEqual([]);
  });

  it('검사가 실제로 잡는다 — 일부러 빠뜨리면 걸린다', () => {
    const violations = findDismissViolations([
      { file: 'fake/NewSheet.tsx', source: '<IonModal isOpen={open}><IonHeader><IonTitle>새 표면</IonTitle></IonHeader></IonModal>' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('fake/NewSheet.tsx');
    expect(violations[0].reason).toContain('SheetClose');
  });

  it('나가는 조작이 있으면 통과한다', () => {
    const violations = findDismissViolations([
      { file: 'fake/GoodSheet.tsx', source: '<IonModal isOpen={open}><IonHeader><SheetClose slot="end" onClose={close} /></IonHeader></IonModal>' },
    ]);
    expect(violations).toEqual([]);
  });

  it('예외는 목록에 이름이 있을 때만 예외다', () => {
    const source = '<IonModal className="name-onboard-modal" backdropDismiss={false}><IonContent /></IonModal>';
    expect(findDismissViolations([{ file: 'fake/Onboard.tsx', source }])).toEqual([]);

    const renamed = source.replace('name-onboard-modal', 'some-other-modal');
    expect(findDismissViolations([{ file: 'fake/Onboard.tsx', source: renamed }])).toHaveLength(1);
  });

  it('예외로 등록해 놓고 나가는 조작까지 두면 목록이 낡은 것이다', () => {
    const violations = findDismissViolations([{
      file: 'fake/Onboard.tsx',
      source: '<IonModal className="name-onboard-modal"><SheetClose onClose={close} /></IonModal>',
    }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('낡았다');
  });

  it('예외마다 왜 나갈 수 없는지가 적혀 있다', () => {
    expect(DISMISS_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exception of DISMISS_EXCEPTIONS) {
      expect(exception.className.trim().length, `${exception.className}: 이름이 비었다`).toBeGreaterThan(0);
      expect(exception.why.trim().length, `${exception.className}: 이유가 비었다`).toBeGreaterThan(10);
    }
  });

  it('한 파일에 표면이 여럿이면 각각 따로 판정한다', () => {
    const violations = findDismissViolations([{
      file: 'fake/Two.tsx',
      source: [
        '<IonModal isOpen={a}><SheetClose onClose={x} /></IonModal>',
        '<IonModal isOpen={b}><IonContent /></IonModal>',
      ].join('\n'),
    }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].ordinal).toBe(2);
  });
});

describe('접었다 펴는 문법', () => {
  it('앱 소스에 접기 조작이 실제로 있다 — 검사가 빈 집합을 훑고 있지 않다', () => {
    const withToggles = sources.filter((entry) => entry.source.includes('DisclosureToggle'));
    expect(withToggles.length).toBeGreaterThan(1);
  });

  it('접기 조작은 예외 없이 공용 조작에서 나온다', () => {
    const violations = findDisclosureViolations(sources);
    const report = violations.map((violation) => `${violation.file} #${violation.ordinal}: ${violation.reason}`).join('\n');
    expect(violations, report).toEqual([]);
  });

  it('검사가 실제로 잡는다 — 손으로 만든 접기는 걸린다', () => {
    const violations = findDisclosureViolations([
      { file: 'fake/NewPanel.tsx', source: '<button type="button" aria-expanded={open} onClick={toggle}>도움말</button>' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('fake/NewPanel.tsx');
    expect(violations[0].reason).toContain('DisclosureToggle');
  });

  it('브라우저가 세모를 그려 주는 `<details>`도 잡는다', () => {
    const violations = findDisclosureViolations([
      { file: 'fake/Doc.tsx', source: '<details className="meta"><summary>기록 정보 보기</summary><pre /></details>' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('details');
  });

  it('공용 조작을 쓰면 통과한다', () => {
    const violations = findDisclosureViolations([
      { file: 'fake/Good.tsx', source: '<DisclosureToggle open={open} onToggle={toggle} controls="help-body">도움말</DisclosureToggle>' },
    ]);
    expect(violations).toEqual([]);
  });

  it('문법의 원본은 자기 규칙에 걸리지 않는다', () => {
    const violations = findDisclosureViolations([
      { file: 'src/components/DisclosureToggle.tsx', source: '<button aria-expanded={open} aria-controls={controls} />' },
    ]);
    expect(violations).toEqual([]);
  });

  it('예외는 여는 태그에 표식이 있을 때만 예외다', () => {
    /* 목록은 지금 비어 있다(이 앱에는 combobox가 없다). 그래도 **장치가 작동하는지**는
       여기서 확인한다 — 나중에 첫 예외를 넣는 사람이 장치까지 같이 만들지 않아도 되게. */
    const source = '<input role="combobox" data-not-a-disclosure="combobox" aria-expanded={open} />';
    const withoutList = findDisclosureViolations([{ file: 'fake/Combo.tsx', source }]);
    expect(withoutList, '목록에 없는데도 그냥 통과했다').toHaveLength(1);

    const declared = [{ marker: 'data-not-a-disclosure="combobox"', why: '후보 목록을 여는 combobox — 접었다 펴는 영역이 아니다' }];
    const tag = source.slice(source.lastIndexOf('<', source.indexOf('aria-expanded')), source.indexOf('>') + 1);
    expect(declared.some((entry) => tag.includes(entry.marker)), '표식이 같은 태그 안에서 안 보인다').toBe(true);
  });

  it('예외마다 왜 접기가 아닌지가 적혀 있다', () => {
    for (const exception of DISCLOSURE_EXCEPTIONS) {
      expect(exception.marker.trim().length, `${exception.marker}: 표식이 비었다`).toBeGreaterThan(0);
      expect(exception.why.trim().length, `${exception.marker}: 이유가 비었다`).toBeGreaterThan(10);
    }
  });

  it('주석에서 문법을 **설명한** 것은 위반이 아니다', () => {
    /* 이 검사가 없으면 "예전에는 `<details>`였다"라고 적은 자리가 위반으로 잡히고,
       다음 사람은 규칙을 지키는 대신 주석에서 낱말을 지우게 된다. */
    const violations = findDisclosureViolations([{
      file: 'fake/Documented.tsx',
      source: [
        '/* 예전에는 이 자리가 <details>였다. aria-expanded를 직접 썼다. */',
        '// aria-expanded를 직접 쓰지 않는다',
        '<DisclosureToggle open={open} onToggle={toggle} controls="body">기록</DisclosureToggle>',
      ].join('\n'),
    }]);
    expect(violations).toEqual([]);
  });

  it('문자열 안의 `//`를 주석으로 오해하지 않는다 — 같은 줄의 진짜 위반이 살아 있다', () => {
    const violations = findDisclosureViolations([
      { file: 'fake/Url.tsx', source: '<a href="https://example.test/x" aria-expanded={open} />' },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('정규식 안의 따옴표에 속지 않는다 — 뒤따르는 주석을 그대로 알아본다', () => {
    /* `PersonDocument.tsx`가 실제로 이 모양이다. 정규식 안의 `"`를 문자열 시작으로 읽으면
       그 뒤 주석이 코드로 남아, 40줄 뒤의 **설명**이 위반으로 잡혔다. */
    const violations = findDisclosureViolations([{
      file: 'fake/Regex.tsx',
      source: [
        'const match = /https?:\\/\\/[^\\s"\']+/.exec(candidate);',
        '/* 예전에는 <details>였다 */',
        '<DisclosureToggle open={open} onToggle={toggle} controls="body">기록</DisclosureToggle>',
      ].join('\n'),
    }]);
    expect(violations).toEqual([]);
  });

  it('JSX 닫는 태그를 정규식 시작으로 읽지 않는다 — 같은 줄 뒤의 주석을 그대로 알아본다', () => {
    // `</div>`의 `/`를 정규식 시작으로 읽으면 그 뒤 JSX 주석이 코드로 남아,
    // 주석 안의 설명이 위반으로 잡힌다.
    const violations = findDisclosureViolations([{
      file: 'fake/Jsx.tsx',
      source: '</section> {/* 예전에는 aria-expanded를 직접 썼다 */}',
    }]);
    expect(violations).toEqual([]);
  });

  it('한 파일에 접기가 여럿이면 각각 따로 판정한다', () => {
    const violations = findDisclosureViolations([{
      file: 'fake/Two.tsx',
      source: [
        '<button aria-expanded={a} />',
        '<details><summary>b</summary></details>',
      ].join('\n'),
    }]);
    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.ordinal)).toEqual([1, 2]);
  });
});

describe('두 문법을 한 자리에서 훑는다', () => {
  it('앱 소스가 나가기와 접기를 모두 지킨다', () => {
    const violations = findGrammarViolations(sources);
    const report = violations.map((violation) => `[${violation.rule}] ${violation.file} #${violation.ordinal}: ${violation.reason}`).join('\n');
    expect(violations, report).toEqual([]);
  });

  it('어느 문법을 어겼는지 이름표가 붙는다 — 한 목록에 섞여도 사람이 구분한다', () => {
    const violations = findGrammarViolations([
      { file: 'fake/Both.tsx', source: '<IonModal isOpen={a}><button aria-expanded={b} /></IonModal>' },
    ]);
    expect(violations.map((violation) => violation.rule).sort()).toEqual(['나가기', '접기']);
  });
});
