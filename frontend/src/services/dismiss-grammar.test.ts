// Kairen-Ref: TSK-000564 (ISS-000246)
import { describe, expect, it } from 'vitest';
import { DISMISS_EXCEPTIONS, findDismissViolations } from './dismiss-grammar';

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
