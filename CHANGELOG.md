# Changelog — Kairen Card Capture

사용자에게 보이는 변화 중심으로 기록한다. 형식: 버전 — 날짜 — 커밋. 배포(GAS/Pages) 시점은 `RELEASE.md`의 release evidence가 진실이다.

## [Unreleased] — React Ionic migration candidate (branch `agent/tsk-000221-react-ionic-shell`, Kairen-Ref: TSK-000221)

- **검색 진입점**: 하단 내비게이션의 모호한 `사람` 탭을 `검색`으로 바꾸고 캡처 첫 화면에 `사람 검색` 바로가기를 추가해 이름·회사 검색을 즉시 발견할 수 있게 했다.
- **병렬 app shell**: React·TypeScript·Vite와 Ionic React로 `docs/next/` 후보를 만들고 legacy `docs/index.html`은 rollback baseline으로 유지한다.
- **style ownership**: Ionic은 mobile shell·safe area·modal·toast를 소유하고, Tailwind는 Preflight 없이 Kairen-owned layout·content에만 사용한다.
- **contract adapter**: 기존 GAS `list`·`search`·upload payload와 IndexedDB `cardcapture/q`를 typed boundary로 고정했다.
- **offline queue fixture**: IndexedDB reopen 보존, captureId 순차 전송, local `sent` 비중복, 실패 data·tries 보존과 후속 retry 성공을 합성 sender로 검증한다.
- **candidate offline shell**: 취약한 Workbox dependency를 채택하지 않고 작은 build-time generator로 `/next/` scope 전용 service worker와 web manifest를 생성한다. legacy root service worker는 교체하지 않는다.
- **server-off recovery gate**: Playwright가 실제 정적 서버를 종료한 뒤 Chrome reload를 수행해 cached shell·navigation이 복구되는지 검증한다.
- **candidate camera boundary**: 이미지 저장·OCR·upload 없이 후면 camera permission·resolution·failure mapping·track cleanup과 legacy fallback을 병렬 미리보기에서 검증한다.
- **captured-image queue gate**: camera frame을 legacy와 같은 최대 2000px long edge·JPEG 0.85로 메모리에 만들고, 사용자가 선택한 뒤 기존 IndexedDB queue에만 보관하며 자동 upload가 일어나지 않음을 unit·Chrome contract로 고정한다.
- **quick-name OCR boundary**: legacy `nameCandidate`와 parity를 고정하고, 기기 `TextDetector`를 우선한 뒤 pinned self-hosted Tesseract로 fallback해 `quickName`을 같은 queue payload에 보존한다. OCR 실패는 촬영·로컬 보관을 막지 않는다.
- **OpenCV geometry boundary**: 기존 Otsu/Canny·adaptive threshold·명함 비율 scoring·perspective warp를 typed service로 분리하고, 엔진 지연·검출 실패 때 전체 프레임으로 비차단 fallback한다. 실제 명함 검출 품질 판정은 phone gate에 남긴다.
- **점진 전환**: 후보의 촬영 action은 아직 검증된 legacy camera로 연결한다. write queue·camera·OCR·service worker는 각 parity gate 뒤 옮긴다.

## [Unreleased] — capture experience wave (branch `agent/card-capture-interview-wave`, Kairen-Ref: TSK-000178, TSK-000217, TSK-000218, TSK-000219, TSK-000220)

- **이름 먼저 확인**: 촬영 직후 브라우저 내장 OCR을 먼저 시도하고, 미지원 기기에서는 자체 호스팅 Tesseract.js 한국어+영어 모델을 사용한다. 이름은 즉시 확인·수정할 수 있으며 기기 OCR 결과와 provenance를 `quickName`으로 보존한다. 명함 이미지는 제3자 OCR 서비스로 전송하지 않는다.
- **안정 감지 자동 촬영**: 명함 사각형, 프레임 간 흔들림, 선명도, 심한 과노출을 함께 확인해 안정되면 자동 촬영한다. 사용자는 자동 촬영을 끄거나 언제든 수동 셔터·기본 카메라 폴백을 사용할 수 있다.
- **저대비 감지 보강**: 빠른 Canny 경로가 명함을 놓치면 적응형 임계값 경로를 제한 주기로 실행해 흰 배경·약한 테두리 인식을 보강한다.
- **시각 품질 개선**: 브랜드 헤더, 촬영 우선 계층, 차분한 색·타이포·카드 표면, 접근 가능한 포커스와 자동 촬영 진행 피드백을 적용했다.
- **조사 지시 탭**: owner는 최초 명함 등록과 기존 Person 카드에서 메모와 분리된 조사 지시를 남길 수 있다. GAS는 owner·feature flag·target 일치를 재검증하고 raw/requester/target/time/receipt/policy provenance를 별도 저장한다.
- **조사 지시 안전 경계**: raw 원문을 system prompt에 합치지 않고 public·lawful source bounded plan으로만 처리한다. private/login 자료, credential, 민감 특성 추론, doxxing, 외부 send/write, paid API, protected write와 human gate 우회는 실행하지 않는다.
- **회귀 검증**: 자동 촬영의 정상·오발·흔들림·흐림·과노출을 독립 순수 함수와 결정적 테스트로 고정했다.
- **조사 지시 회귀 검증**: owner/guest, 최초/기존 Person, target mismatch, note 혼입, prompt injection, private·sensitive·doxxing·credential·external·paid effect, source conflict를 합성 fixture로 고정했다.
- **처리 상태 정합성**: 브리핑 목록 조회는 cache-busting과 `no-store`로 최신 서버 상태를 읽고, 재처리 요청은 POST에서 terminal 상태를 재검증해 이미 완료·건너뜀인 카드를 `received`로 되돌리지 않는다. 재처리 경과 시간은 최신 `receivedAt`부터 다시 계산한다. (Kairen-Ref: TSK-000161)

## [Unreleased] — watcher v3 (branch `agent/watcher-v3`)

- **워처 v3 카드별 처리**: 대량 연속 캡처를 한 번의 긴 실행이 아니라 가장 이른 캡처부터 **한 건씩** 처리 → 카드마다 폰에 하나씩 도착하고, 사이마다 하트비트·backlog가 갱신됨. 무한 루프 방지 상한(25장/실행)·무진행 가드 포함 (ISS-000065, fixture 31/31 PASS). **라이브 워처 교체는 별도 단계**(로컬 pull+재시작, Setup 참조).

## v1.x UI (merged: PR #2 `agent/ux-retake`, PR #3 `agent/ux-round3`, PR #4 `agent/ux-round4`)

- **앞면 다시 찍기**: 앞면 촬영 직후 선택지([뒷면도 찍기 / 뒷면 없이 완료])에 "앞면 다시 찍기" 추가 — 카메라를 벗어나지 않고 앞면 교체 (2026-07-24 실사용 피드백), sw v13.

## [Unreleased] — v1.1 후보 (branch `agent/product-baseline-v1`, Kairen-Ref: TSK-000140~164)

추가 (배포 전 — GAS 재배포·사람 승인 필요):
- **바로 연락**: 브리핑·프렙 카드에서 전화·문자·메일·연락처 저장(vCard) — brief 텍스트 추출 폴백으로 기존 캡처도 동작, 처리 계약의 `contact` 요약 필드로 정확도 향상.
- **미팅 프렙 카드**: 검색 결과·전체 프로필 상단에 이름·직함·회사·마지막 확인·연락 버튼 요약 먼저 표시.
- **검색 상단 이동 + 최근 검색 3건** — 미팅 직전 10초 회상 동선 단축. 홈화면 **shortcuts**(인맥 검색/브리핑, `?view=`) 추가.
- **다시 처리 요청**: 30분 이상 지연된 캡처에서 사용자가 직접 재큐잉(`action=requeue`) + 문의 메일 버튼.
- **연속 촬영 동선**: 전송 즉시 상단 복귀 — 행사장에서 다음 명함을 끊김 없이.
- **검색**: owner 토큰 한정 Person 검색(`action=search`) + 웹앱 "검색" 탭 — 이름·회사로 축적된 인맥을 폰에서 회상.
- **사후 메모**: 브리핑·검색 결과에서 "메모 추가"(`action=addnote`) — 회의 끝나고, 또는 나중에 기억났을 때 그 사람 기록에 병합(-note 캡처로 파이프라인 재사용).
- **더 보기**: 브리핑(`action=list` limit/offset·hasMore)과 최근 캡처 목록에서 예전 것까지 조회.
- **처리 진행 표시**: 대기 중 브리핑에 경과 시간·통상 소요(6~20분)·30분 초과 경고 표시 — "깜깜무소식" 해소 (2026-07-24 실사용 피드백).
- **촬영 확인 토스트 상단 이동**: 하단 토스트가 "뒷면 추가" 버튼을 가리던 문제 수정 (2026-07-24 실사용 피드백).
- **처리 완료 알림**: 워처가 처리 완료 시 GAS(`action=notify`)를 통해 소유자 메일로 알림(0원, 옵트인 설정 파일).
- **수정 요청**: 브리핑에서 "수정 요청" 전송(`action=correction`) → 다음 처리 때 사용자 정정으로 반영.
- **워처 v2**: health 파일(`watcher-health.json`)·상태 점검 스크립트·연속 실패 추적·백로그 나이 노출 + 처리 프롬프트에 쓰기 allowlist·untrusted 입력 방어 삽입.
- **저장소 거버넌스**: AGENTS.md, SECURITY.md(위협 모델·토큰 runbook), RELEASE.md(release evidence 계약), CHANGELOG.md, `scripts/validate.ps1`(secret scan 포함), `eval/`(합성 회귀 fixture 16종 + 채점기).

## v1.0 — 2026-07-23 — `2d4704c`
- 어디서·관계 유지 필드에 2시간 만료 도입(오래된 행사명이 다음 캡처에 잘못 남는 문제 방지).

## v0.9 — 2026-07-23 — `6103230`
- 브리핑 자동 새로고침이 펼쳐 읽던 항목을 접지 않음(내용 무변경 시 재렌더 생략).
- 관계 필드 순서를 "Kairen과의 관계" 먼저로 변경, 최근 캡처 목록 표시 개편(이름·어디서 중심, 메모 숨김).

## v0.8 — 2026-07-23 — `01bc624`
- 브리핑 20초 자동 새로고침.
- 워처 인코딩 수정(UTF-8 BOM — 한글 경로 FATAL 해결), GAS가 Drive 중복 파일 중 최신 capture.json을 읽도록 수정(폰 '처리 대기중' 오표시 해결).

## v0.7 — 2026-07-23 — `c4554b1`
- 카메라 화면 개선(스크림+코너 브래킷+보간), 처리 엔진을 Codex로 전환(로그인 단계 제거).

## v0.6 — 2026-07-23 — `9177196`
- 브리핑에서 "전체 프로필 보기" — Person `.md` 전문 뷰어(`action=persondoc`, owner 한정).
- 즉시 처리 워처 도입(파일 이벤트+60초 폴링+시작 스윕, processing.lock).

## v0.5 — 2026-07-23 — `e496d02`
- "받은 명함 브리핑" 탭 + GAS `action=list`(토큰 scope, OWNER_NAMES 전체 열람).

## v0.4 — 2026-07-23 — `e914e1b`
- 뒷면 선택 명확화, 최근 캡처 상세(다시 찍기·수정·재전송).

## v0.3 — 2026-07-23 — `ff00186`
- 캡처 컨텍스트 4필드: 어디서 만났는지(유지형)·나와의 관계·Kairen과의 관계·메모.

## v0.2 — 2026-07-23 — `9433d19`
- 인페이지 카메라 + OpenCV.js 명함 사각형 자동 인식·크롭·원근 보정(self-hosted).

## v0.1 — 2026-07-23 — `7f9d007`
- 캡처 PWA가 기본 GAS 배포 URL을 내장.

## v0 (G0) — 2026-07-23 — `d85f248`
- 업로드 API(Code.gs: ping/whoami/POST)와 캡처 PWA 최초 공개(토큰 검증, Drive inbox 저장).
