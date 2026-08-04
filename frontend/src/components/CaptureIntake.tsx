// 파일로 명함을 올리는 길 — Kairen-Ref: TSK-000220 (INT-000036 / ISS-000084)
//
// founder 판정 (개발 인터뷰 008):
//   "사진 올리기에 클릭했을 때 UI가 뭔가 어색해. 기존에 있던 것이 바뀌어서 혼란스럽다고 해야 하나?
//    직접 입력이나 명함 앞면 촬영 처럼 뭔가 아래에서 올라."
//
// 진짜 원인은 애니메이션이 아니라 **화면이 하나 더 있었다는 것**이다. 예전 동선은 두 번 눌러야 했다:
//   카드 → (진입 카드 자리가 통째로 `DesktopIntake` 작업면으로 바뀜) → 그 안의 큰 버튼 → 파일 선택창.
// 가운데 화면은 아무 결정도 받지 않으면서 세 카드를 치웠다. 그래서 누른 사람 눈에는 "있던 것이
// 사라지고 모르는 것이 왔다"로 보였고, 옆의 두 입구(아래에서 올라오는 시트·모달)와도 결이 달랐다.
//
// 그래서 가운데 화면을 없앤다. 카드를 누른 **그 제스처 안에서** 브라우저의 파일 선택창이 열린다.
// 직접 입력·명함 앞면 촬영의 아래→위 전환은 그대로다 — 문제였던 것은 그 둘이 아니다.
//
// ── 이 구조가 지켜야 하는 것: 신뢰된 제스처
// 브라우저는 사용자의 진짜 클릭/키 입력에서 이어진 동기 호출일 때만 `input.click()`으로 선택창을
// 열어 준다. `await` 하나만 사이에 끼어도 그 연결이 끊기고 선택창은 조용히 안 열린다 — 오류도
// 나지 않는다. 그래서 진짜 `<input type="file">`은 **카드 옆에 이미 붙어 있어야** 한다.
// 눌린 뒤에 만들어 붙이면 그 사이에 프레임이 하나 지나간다. 경로는 정확히 이렇다:
//
//   카드 onClick → App.selectCaptureMethod → CaptureIntakeHandle.open() → input.click()
//
// 네 칸 모두 동기다. 여기에 `await`·`setTimeout`·`setState 뒤의 effect`를 넣지 말 것.
// 키보드(Enter·Space)로 버튼을 눌러도 브라우저가 만드는 click은 신뢰된 이벤트라 같은 길로 간다.
//
// ── 이 컴포넌트가 자식을 감싸는 이유
// 끌어다 놓기와 붙여넣기는 카드 한 장의 성질이 아니라 **캡처 영역의 성질**이다. 그래서 진입
// 카드(또는 앞면 미리보기)를 자식으로 품고 영역 전체를 드롭 대상으로 만든다. 예전에는 작업면을
// 열어야만 드롭할 수 있었다 — 파일을 이미 손에 들고 온 사람이 먼저 두 번 눌러야 했다는 뜻이다.
import '../styles/int30-capture.css';

import { ImageUp } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import {
  type IntakeAssignment,
  type IntakeSide,
  intakeRejectionLine,
  planIntakeFiles,
} from '../services/device-capability';

export interface CaptureIntakeHandle {
  /**
   * 파일 선택창을 곧바로 연다.
   *
   * **신뢰된 제스처 안에서 동기적으로** 불러야 한다. 클릭 핸들러 안에서 `await` 뒤에 부르면
   * 브라우저가 막고, 아무 일도 일어나지 않으며 오류도 나지 않는다.
   */
  open(): void;
}

export interface CaptureIntakeProps {
  /** 앞면이 이미 차 있는가. 차 있으면 새 파일은 뒷면으로 간다 — 말없이 덮어쓰지 않는다. */
  hasFront: boolean;
  hasBack: boolean;
  /**
   * 이 브라우저에 파일 칸이 있는가 (`device-capability.ts`의 `hasFileInput`).
   *
   * 없으면 이 컴포넌트는 아무 길도 열지 않는다 — 눌리는데 아무 일도 일어나지 않는 손잡이가
   * 이 표면에서 가장 나쁜 실패다. 그때 카드는 사라지지 않고 이유와 `직접 입력` 대안을 달고 남는다
   * (`deviceCaptureMethods`).
   */
  enabled: boolean;
  /**
   * 끌어다 놓기·붙여넣기를 권해도 되는 기기인가 (데스크톱).
   * 손가락으로는 파일을 끌 수 없고 `Ctrl+V`도 없다 — 터치 기기에는 그 길도 문구도 없다.
   */
  assistable: boolean;
  /** 구획이 한 번만 말하는 보조 안내(`intakeAssistHint`). 빈 문자열이면 줄 자체가 없다. */
  assistHint: string;
  /**
   * 배정된 파일을 프레임으로 옮긴다. 읽지 못한 파일이 있으면 그 **이름들**을 돌려준다.
   *
   * 디코드 실패는 열어 본 뒤에야 알 수 있어 여기서는 판정할 수 없다. 그렇다고 조용히
   * 사라지게 두면 사용자는 올린 사진이 어디로 갔는지 물을 곳이 없다.
   */
  onFiles(assignments: IntakeAssignment<File>[]): Promise<readonly string[]>;
  children: ReactNode;
}

/** 붙여넣은 이미지는 이름이 없을 수 있다. 이름 없는 줄은 무엇이 빠졌는지 말하지 못한다. */
const PASTED_NAME = '붙여넣은 사진';

function namedFile(file: File, fallback: string): File {
  if (file.name) return file;
  const extension = /^image\/([a-z0-9]+)/i.exec(file.type)?.[1] ?? 'png';
  try {
    return new File([file], `${fallback}.${extension}`, { type: file.type });
  } catch {
    return file;
  }
}

/** 끌고 온 것이 파일인가. 글자를 끌어 왔는데 드롭 표시가 켜지면 그 표시는 거짓말이다. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes('Files');
}

export const CaptureIntake = forwardRef<CaptureIntakeHandle, CaptureIntakeProps>(function CaptureIntake(
  { hasFront, hasBack, enabled, assistable, assistHint, onFiles, children },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 초점 착지를 지켜볼 마감 시각. 0이면 지켜보지 않는다 (`watchFocusLanding` 참고). */
  const focusWatchUntil = useRef(0);
  /* 드래그는 자식 요소를 넘나들 때마다 enter/leave가 짝으로 온다. boolean 하나로 받으면
     카드에서 카드로 옮기는 순간 표시가 깜빡인다. 깊이를 세면 영역을 **실제로** 벗어날 때만 꺼진다. */
  const dragDepth = useRef(0);
  /** 늦게 도착한 디코드 결과가 그 사이 새로 들어온 묶음의 안내를 덮지 않게 하는 표식. */
  const batchRef = useRef(0);

  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, setPending] = useState<File | null>(null);

  const deliver = useCallback(async (assignments: IntakeAssignment<File>[], batch: number) => {
    const unreadable = await onFiles(assignments);
    if (batch !== batchRef.current || unreadable.length === 0) return;
    setNotes((current) => [...current, ...unreadable.map((name) => intakeRejectionLine(name, 'unreadable'))]);
  }, [onFiles]);

  /**
   * 받은 파일 묶음 하나를 끝까지 처리한다.
   *
   * 세 경로(카드에서 고르기·끌어다 놓기·붙여넣기)가 전부 여기로 온다 — 경로마다 규칙이 갈리면
   * 같은 파일이 **어디서 왔느냐에 따라** 다르게 처리되고, 그 차이는 아무도 설명할 수 없다.
   */
  const take = useCallback((files: readonly File[]) => {
    if (!enabled || files.length === 0) return;
    const batch = (batchRef.current += 1);
    const plan = planIntakeFiles(files, { hasFront, hasBack });
    setNotes(plan.notes);
    setPending(plan.replaceCandidate);
    if (plan.accepted.length > 0) void deliver(plan.accepted, batch);
  }, [deliver, enabled, hasBack, hasFront]);

  const openPicker = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    // 같은 파일을 두 번 연달아 고르면 `change`가 오지 않는다 — 열기 직전에 비운다.
    input.value = '';
    input.click();
  }, []);

  useImperativeHandle(ref, () => ({ open: openPicker }), [openPicker]);

  /**
   * 초점이 사라지는지 잠깐 지켜본다.
   *
   * `input.click()`은 초점을 옮기지 않으므로 **평소에는 할 일이 없다** — 눌렀던 카드가 계속
   * 초점을 쥐고 있고, 취소해도 그대로다. 문제는 딱 한 경우다: 앞면이 들어오면 그 자리를
   * 미리보기가 가져가면서 **눌렀던 카드 자체가 사라지고**, 브라우저는 초점을 `body`로 떨어뜨린다.
   *
   * 왜 `setTimeout`이 아닌가 — 사진 디코드가 비동기라 카드가 언제 사라지는지 시각으로 예측할 수
   * 없다. 첫 판이 정확히 그렇게 틀렸다: 다음 macrotask에서는 카드가 아직 붙어 있어 거기에 초점을
   * 얹었고, 그 뒤 카드가 지워지면서 초점이 `body`로 떨어졌다(게이트 실측: `body.`).
   * 그래서 시각이 아니라 **사실**을 본다 — 렌더가 끝날 때마다 초점이 실제로 떨어졌는지 확인하고,
   * 떨어졌을 때만 구획으로 착지시킨다. 창이 3초 뒤 닫히는 것은 오래된 감시가 엉뚱한 렌더에서
   * 초점을 낚아채지 않게 하는 안전장치다.
   */
  const watchFocusLanding = useCallback(() => {
    focusWatchUntil.current = Date.now() + 3_000;
  }, []);

  useEffect(() => {
    if (!focusWatchUntil.current) return;
    if (Date.now() > focusWatchUntil.current) { focusWatchUntil.current = 0; return; }
    const active = document.activeElement;
    // 아직 어딘가를 쥐고 있다면 건드리지 않는다. 남의 초점을 빼앗는 것이 더 나쁘다.
    if (active && active !== document.body) return;
    focusWatchUntil.current = 0;
    rootRef.current?.focus({ preventScroll: true });
  });

  /* 선택창을 **취소**했을 때도 같은 감시를 켠다. React 타입에는 input의 `cancel`이 없어서 직접 건다.
     이 이벤트가 오지 않는 브라우저에서도 잃는 것은 없다 — 취소는 화면을 바꾸지 않으므로
     카드가 그대로 초점을 쥐고 있고, 감시는 아무 일도 하지 않는다. */
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    const onCancel = () => watchFocusLanding();
    input.addEventListener('cancel', onCancel);
    return () => input.removeEventListener('cancel', onCancel);
  }, [enabled, watchFocusLanding]);

  /* 붙여넣기 — 스크린샷을 찍어 바로 붙이는 것이 PC에서 가장 짧은 동선인데 지금까지 없었다.
     `document`에 건다: 캡처 화면 어디에 초점이 있든 성립해야 하고, 이 컴포넌트는 캡처 탭에서만
     mount되므로(`App.tsx`의 `tab === 'capture'`) 다른 탭까지 따라가지 않는다.
     글자 붙여넣기는 건드리지 않는다 — 이미지가 하나도 없으면 그대로 흘려보낸다. */
  useEffect(() => {
    if (!enabled || !assistable) return undefined;
    function onPaste(event: ClipboardEvent) {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) => /^image\//i.test(file.type));
      if (images.length === 0) return;
      event.preventDefault();
      take(images.map((file) => namedFile(file, PASTED_NAME)));
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [assistable, enabled, take]);

  const dragProps = enabled && assistable
    ? {
      onDragEnter: (event: ReactDragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        dragDepth.current += 1;
        setDragging(true);
      },
      onDragOver: (event: ReactDragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        // 막지 않으면 브라우저가 그 파일을 탭에 그냥 열어 버린다 — 앱이 통째로 사라진다.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      },
      onDrop: (event: ReactDragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        take(Array.from(event.dataTransfer?.files ?? []));
      },
    }
    : {};

  function replaceInto(side: IntakeSide) {
    const file = pending;
    if (!file) return;
    setPending(null);
    void deliver([{ file, side }], batchRef.current);
  }

  return (
    <div
      ref={rootRef}
      className={`cc-capture-intake${dragging ? ' dragging' : ''}`}
      /* 초점을 받을 수는 있지만 Tab 순서에는 끼지 않는다. 눌렀던 카드가 사라졌을 때의
         착지점일 뿐이라, 키보드 사용자의 이동 거리를 늘리지 않는다. */
      tabIndex={-1}
      {...dragProps}
    >
      {children}

      {/* 진짜 파일 칸. 화면에서는 빼되 접근성 트리에는 남긴다 — `display: none`이면 낭독기도
          자동화도 이 칸을 찾지 못한다. `.primary-entries` **밖**에 두는 것이 중요하다:
          안에 넣으면 진입 카드 grid의 칸 하나를 차지하고, 카드를 세는 게이트가 넷을 센다. */}
      {enabled && (
        <input
          ref={inputRef}
          className="cc-drop-input"
          type="file"
          accept="image/*"
          multiple
          aria-label="명함 사진 파일 고르기"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            watchFocusLanding();
            take(files);
          }}
        />
      )}

      {/* 끌고 오는 동안에만 나타난다. 평상시에 점선 상자를 상시로 띄우면 그것이 곧 예전 작업면이
          하던 일(아무 결정도 받지 않는 화면 한 겹)을 다시 만드는 것이다. */}
      {dragging && (
        <div className="cc-drop-veil" aria-hidden="true">
          <span className="cc-drop-veil-icon"><ImageUp size={22} /></span>
          <span className="cc-drop-veil-copy">여기에 놓으면 명함 사진으로 받아요</span>
        </div>
      )}

      {enabled && assistable && assistHint && <p className="cc-intake-hint">{assistHint}</p>}

      {/* 앞·뒷면이 다 찼다. **묻는다** — 말없이 덮어쓰면 방금 넣은 앞면이 어디 갔는지 알 수 없고,
          이유만 말하고 끝내면 사진을 손에 든 채 갈 곳이 없어진다. */}
      {pending && (
        <div className="cc-intake-replace" role="group" aria-label="자리 바꾸기">
          <p className="cc-intake-replace-copy">
            앞·뒷면이 이미 찼어요. <b>{pending.name}</b>을(를) 어디에 넣을까요?
          </p>
          <div className="cc-intake-replace-actions">
            <button type="button" onClick={() => replaceInto('front')}>앞면 바꾸기</button>
            <button type="button" onClick={() => replaceInto('back')}>뒷면 바꾸기</button>
            <button type="button" className="quiet" onClick={() => setPending(null)}>그대로 두기</button>
          </div>
        </div>
      )}

      {/* 빠진 장은 조용히 사라지지 않는다. 이름과 이유를 붙여 말하고 바로 옆에 다시 고를 손잡이를 둔다.
          손잡이는 live region **밖**이다 — 안에 넣으면 낭독기가 안내를 읽을 때마다 버튼까지 다시 읽는다. */}
      {notes.length > 0 && (
        <>
          <ul className="cc-intake-rejects" role="status">
            {notes.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
          {enabled && (
            <button className="cc-intake-retry" type="button" onClick={openPicker}>다른 파일 고르기</button>
          )}
        </>
      )}
    </div>
  );
});
