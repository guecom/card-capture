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

/** 검사 대상 파일 하나. */
export interface DismissSource {
  /** 사람에게 보여 줄 경로. */
  file: string;
  /** 파일 내용 그대로. */
  source: string;
}

export interface DismissViolation {
  file: string;
  /** 파일 안에서 몇 번째 `<IonModal>`인가 (1부터). */
  ordinal: number;
  /** 왜 걸렸는가 — 사람이 읽고 바로 고칠 수 있는 문장. */
  reason: string;
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

  for (const { file, source } of sources) {
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
