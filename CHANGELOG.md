# Changelog — Kairen Card Capture

사용자에게 보이는 변화 중심으로 기록한다. 형식: 버전 — 날짜 — 커밋. 배포(GAS/Pages) 시점은 `RELEASE.md`의 release evidence가 진실이다.

## [Unreleased] — 빠른 이름 인식 엔진 교체: PP-OCRv5 한국어 (branch `agent/tsk-000236-ppocr-quickname`, Kairen-Ref: ISS-000096, TSK-000236)

- **인식 엔진 교체**: 촬영 직후 "이름 먼저 확인"이 Tesseract에서 **PaddleOCR PP-OCRv5 모바일(한국어 인식 모델)**로 바뀌었다. 공개 벤치마크에서 한국어 포함 scene text 정확도가 Tesseract를 크게 앞서는 최신 신경망 OCR이다. 게이트 실측(합성 명함): 이름·직함·회사·연락처 4줄 전부 정확 인식, 추론 0.7초.
- **이름 선택 로직 교체**: "카드에서 가장 큰 글씨의 사람 이름" — 단어 박스 크기(글꼴 크기)·신뢰도 기반 픽커로 바꿔 회사명·직함을 이름으로 뽑는 오탐을 줄였다. 직함이 같은 줄에 붙은 경우("홍길동 대표이사")도 이름만 분리한다.
- **온디바이스·자체 호스팅 유지**: 모델(det 4.7MB + 한국어 rec 13.4MB + 사전)과 ONNX Runtime WASM(13.5MB)을 전부 자체 호스팅하고 전용 Web Worker에서 실행한다 — 명함 이미지는 외부로 나가지 않고, 메인 스레드 프리즈도 없다(게이트 실측 long task 0ms). 자산은 pinned hash로 validate에 고정.
- **폴백 유지**: PP-OCR 초기화 실패 기기는 기존 TextDetector → Tesseract 경로로 그대로 동작한다. 준비가 늦으면(7초 상한) 해당 캡처만 폴백을 쓰고 다음 캡처부터 새 엔진을 쓴다.
- **품질 게이트 신설**: 실제 모델을 워커에 로드해 합성 한국어 명함의 이름 정확 추출 + 메인 스레드 long task 한도를 CI에서 강제한다.

## [Unreleased] — 카메라 프리즈 근본 수정: 감지 엔진 워커 격리 (branch `agent/tsk-000230-opencv-worker`, Kairen-Ref: ISS-000091, TSK-000230)

- **감지 엔진을 Web Worker로 완전 이전**: OpenCV(WASM ~10MB)의 로드·컴파일·명함 감지·perspective 보정·흐림 점수가 전부 별도 스레드에서 돌아, 카메라를 여는 순간을 포함해 **어떤 시점에도 메인 스레드가 잠기지 않는다.** 직전 수정(prefetch+지연 실행)은 다운로드 대기만 없앴을 뿐 컴파일 블로킹이 카메라 진입 시점에 남아 폰에서 "준비 중… + 전 버튼 무반응"이 재현됐다 — 이번이 근본 수정이다.
- **프리즈 회귀 게이트 신설**: 실제 vendor 엔진을 워커에 로드·감지시키며 메인 스레드 long task를 계측하는 Playwright 게이트 추가 — 측정: 엔진 로드 603ms 동안 메인 스레드 최대 점유 66ms(이전 방식은 404ms+ 블로킹, 폰에서는 수 배).
- **새 배포 자동 반영**: 새 버전이 활성화되면 페이지를 한 번 자동 새로고침한다 — 홈 화면 앱이 "한 번 전 실행" 빌드를 계속 보여주던 혼선 제거(최초 설치 시에는 새로고침하지 않음).
- **빌드 표시**: 설정 화면 하단에 빌드 시각을 표시해 "지금 무슨 버전을 보고 있나"를 바로 확인할 수 있다.

## [Unreleased] — 실폰 1차 피드백 반영 (branch `agent/tsk-000230-phone-feedback`, Kairen-Ref: ISS-000091, ISS-000094, ISS-000095, TSK-000230~232)

- **카메라 프리즈 해소**: 명함 감지 엔진(OpenCV WASM)을 앱 유휴 시점에 **내려받기만** 하고, 실행·컴파일은 카메라 미리보기가 뜬 뒤로 옮겼다. 촬영 버튼을 누른 직후 메인 스레드가 잠겨 아무 버튼도 반응하지 않던 문제가 사라졌다(측정: 실행 시 메인 스레드 점유 약 0.4초/데스크톱). 엔진 준비 전에도 수동 촬영·가이드 크롭은 그대로 동작하며 안내 문구도 그렇게 바뀌었다.
- **2시간 유지 실동작**: 만난 곳·관계·조사 지시를 입력 즉시 저장한다. 완료를 누르지 못하고 앱을 벗어나도 값이 유지되며, 과거 캡처를 수정해도 현재 맥락이 덮어써지지 않는다. 조사 지시도 2시간 유지 대상에 포함했다.
- **명함 기록 통합**: 최근 캡처와 받은 명함 브리핑을 하나의 목록으로 합쳤다. 같은 명함이 두 곳에 나뉘어 보이지 않고, 브리핑 카드 안에서 내가 적은 맥락과 캡처 수정 진입을 함께 볼 수 있다. 전송 대기·실패 항목은 대기 행으로 남는다.
- **화면 간결화**: 캡처 첫 화면의 큰 제목·설명 문단을 한 줄로 줄이고, 캡처 화면의 사람 검색 바로가기를 없앴다(하단 검색 탭 유지).
- **조사 지시 예시**: 자주 쓰는 형태를 입력창 예시로 넣었다 — 최근 경력·이직, 회사 투자·뉴스, 인터뷰·발표, 공통 접점.
- **새로고침 반응**: 우측 상단·목록 새로고침이 진행("새로고침 중…")과 완료를 즉시 알린다.
- **전방위 인물 조사**: 처리 절차의 웹 보강 규칙을 LinkedIn 편중에서 소스군 체크리스트로 바꿨다 — 사람 6군(전문 프로필·뉴스/인터뷰·발표/컨퍼런스·논문/특허/GitHub·협회/수상·최근 90일 활동) 중 4군 이상, 회사 5군 중 3군 이상을 실제로 조회하고, 한글·영문·이니셜 질의 변형과 동일인 2개 이상 근거 일치, 출처별 신뢰도·확인일·충돌 기록을 남긴다. 브리핑에는 "만나기 전에 알면 좋은 것" 대화 포인트 3~5개가 들어간다. 공개·합법 출처 한정과 민감 정보 금지 경계는 그대로다.

## [Unreleased] — 캡처 작업 화면·온보딩 복원 (branch `agent/tsk-000228-capture-surface`, Kairen-Ref: ISS-000091, TSK-000228)

- **한 화면 촬영 흐름 복원**: 캡처 탭이 랜딩형 hero에서 legacy 작업 화면으로 돌아왔다 — 촬영 버튼·기기 내 이름 확인·기억할 맥락 4필드(스티키 값이 촬영 전에 보임)·완료가 한 화면에 있고, 최근 캡처·받은 명함 브리핑이 같은 스크롤에서 접기 상태(legacy와 같은 저장 키)로 이어진다. 완료 후에는 만난 곳·관계를 유지한 채 즉시 다음 명함을 찍을 수 있다.
- **카메라 모달은 촬영 전용**: 앞면 촬영 직후 카메라를 벗어나지 않는 선택지(뒷면도 찍기 / 뒷면 없이 완료 / 앞면 다시 찍기)를 복원했고, 스트림을 유지해 뒷면 촬영이 즉시 시작된다. 맥락 입력·이름 확인·완료는 메인 화면이 소유한다.
- **링크 우선 온보딩 복원**: 첫 실행은 legacy처럼 이름 한 칸("처음 오셨네요 👋")만 묻는다. 주소·토큰 입력은 설정의 "고급 — 직접 연결 설정" 뒤로 숨고, 토큰 라벨이 "개인 링크 토큰 (?k= 값)"과 자동 저장 안내로 바뀌었으며, 토큰 없이 열면 개인 링크 안내 배너가 뜬다.
- **회귀 게이트**: Playwright `parity-restore`에 한 화면 캡처 표면·접기 저장·온보딩 게이트 검증을 추가했다 (총 10/10).

## [Unreleased] — legacy 파리티 회귀 복원 (branch `agent/tsk-000222-react-parity-regressions`, Kairen-Ref: ISS-000091, TSK-000222, TSK-000223)

- **브리핑·프로필 렌더링 복원**: 브리핑 본문과 전체 프로필이 마크다운 원문 덤프 대신 legacy `mdLite` 규칙(제목·불릿·구분선·화살표·표, escaped pipe 포함)으로 렌더링된다. 전체 프로필에는 미팅 프렙 카드(이름·직함·회사·마지막 확인·바로 연락)와 frontmatter 요약 박스가 돌아왔고, 검색 결과 프로필에서도 메모 추가·조사 지시를 바로 실행할 수 있다.
- **연락처 추출 폴백**: 서버 contact 요약이 없는 기존 브리핑에서도 본문 텍스트에서 전화·메일을 추출해 전화·문자·메일·연락처 저장 버튼을 복원한다.
- **최근 캡처 맥락 복원**: 처리 완료된 브리핑의 이름이 로컬 캡처 목록에 매핑되고, 만난 곳·관계 맥락 줄·바로 메모 버튼·"예전 캡처 더 보기" 페이지네이션이 돌아왔다. 새 캡처는 104px 썸네일을 저장해 전송 후 원본이 정리돼도 목록 이미지가 유지된다.
- **진행 문구·제목 규칙 복원**: 처리 대기 3단계 문구(통상 소요·완료까지 약 N분 남음)와 captureId 폴백 경과 계산, note/조사 지시 receipt의 "메모 → 대상" 제목, skipped 항목의 만난 곳 폴백 제목을 복원했다.
- **오프라인 신뢰성**: 배경 20초 자동 새로고침 실패가 더 이상 토스트를 띄우지 않는다(수동 새로고침만 안내). 서버 오류 코드는 legacy처럼 한글 안내로 매핑되고, owner 게이트는 localStorage에 캐시되어 전파가 약해도 전체 프로필·검색 UI가 유지된다. 최근 검색 칩은 누르면 즉시 검색한다.
- **카메라 라이브 오버레이 복원**: 감지된 명함 사각형을 주변 스크림·코너 브래킷·프레임 보간·잠금 상태로 실시간 표시하고(자동 촬영이 꺼져 있어도 표시), 자동 촬영 진행 링을 스테이지에 그린다. 감지 실패 시 가이드 영역 크롭 폴백으로 배경 전체 업로드를 막고, 촬영 직후 흐림 경고를 복원했다.
- **빠른 이름 보호**: 사용자가 이미 입력·수정한 이름을 OCR 완료가 덮어쓰지 않으며, Tesseract 모델을 유휴 시간에 미리 로드해 첫 촬영의 이름 인식 대기를 줄인다.
- **회귀 게이트**: 위 파리티를 단위 테스트 36건과 Playwright `parity-restore` e2e 3건으로 고정했다.

## v2.0.0 — 2026-07-26 — `c9036b3` (Kairen-Ref: TSK-000221)

- **운영 승격**: 기본 Pages URL이 token·view query를 보존해 React 앱을 열고, 기존 static 앱은 `legacy.html` 복구 경로로 보존한다. root와 React service worker가 서로의 cache를 지우지 않도록 경계를 분리했다.
- **검색 진입점**: 하단 내비게이션의 모호한 `사람` 탭을 `검색`으로 바꾸고 캡처 첫 화면에 `사람 검색` 바로가기를 추가해 이름·회사 검색을 즉시 발견할 수 있게 했다.
- **운영 app shell**: React·TypeScript·Vite와 Ionic React로 `docs/next/` 앱을 만들고 legacy 앱은 `docs/legacy.html` rollback baseline으로 유지한다.
- **style ownership**: Ionic은 mobile shell·safe area·modal·toast를 소유하고, Tailwind는 Preflight 없이 Kairen-owned layout·content에만 사용한다.
- **contract adapter**: 기존 GAS `list`·`search`·`doc`·`persondoc`·`requeue`·`addnote`·`researchinstruction`·`correction`·upload payload와 IndexedDB `cardcapture/q`를 typed boundary로 고정했다.
- **설정·offline queue parity**: 기존 `?api`·`?k` 링크와 `cc_*` 저장 key를 그대로 받고, IndexedDB reopen·captureId 순차 전송·local `sent` 비중복·online/visibility 재전송·실패 data/tries·수동 재시도·50건 이후 sent 원본 정리를 복원했다.
- **offline shell**: 취약한 Workbox dependency를 채택하지 않고 작은 build-time generator로 `/next/` scope 전용 service worker와 web manifest를 생성한다. root와 legacy cache는 React cache와 분리한다.
- **server-off recovery gate**: Playwright가 실제 정적 서버를 종료한 뒤 Chrome reload를 수행해 cached shell·navigation이 복구되는지 검증한다.
- **촬영 parity**: 후면 camera permission·resolution·failure mapping·track cleanup, 앞·뒷면, retake, torch, 기본 카메라 fallback, stable auto-capture, 맥락·메모·owner 조사 지시를 React 앱에 연결했다.
- **captured-image queue gate**: camera frame을 legacy와 같은 최대 2000px long edge·JPEG 0.85로 만들고 기존 IndexedDB queue에 보관한 뒤 설정된 기존 GAS로 자동 전송한다. 미설정·offline에서는 POST 0을 유지하고 연결 복귀 뒤 같은 captureId로 보낸다.
- **quick-name OCR boundary**: legacy `nameCandidate`와 parity를 고정하고, 기기 `TextDetector`를 우선한 뒤 pinned self-hosted Tesseract로 fallback해 `quickName`을 같은 queue payload에 보존한다. OCR 실패는 촬영·로컬 보관을 막지 않는다.
- **OpenCV geometry boundary**: 기존 Otsu/Canny·adaptive threshold·명함 비율 scoring·perspective warp를 typed service로 분리하고, 엔진 지연·검출 실패 때 전체 프레임으로 비차단 fallback한다. 실제 명함 검출 품질 판정은 phone gate에 남긴다.
- **read/action parity**: 최근 캡처 상세·정보/사진 수정·같은 captureId 재전송, 20초 briefing refresh·지연 재처리·pagination·offline cache, Person profile, 전화·문자·메일·vCard, 사후 메모·조사 지시·수정 요청, 최근 검색과 PWA shortcut을 복원했다.
- **운영 전환**: 기존 사용자 기능을 React 앱에 직접 연결하고 legacy app은 rollback link로 유지한다. 계약·브라우저·CI 검증과 founder 실사용 확인 뒤 PR #8을 병합하고 Pages·GAS·watcher를 운영 배포했다.

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
