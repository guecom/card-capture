# Release Evidence Contract — Kairen Card Capture

Kairen-Ref: `TSK-000140` (release baseline). 이 문서는 "무엇이 하나의 release 증거인가"와 현재 확인된 baseline을 소유한다. PR merge, Pages build, GAS ping 중 하나만으로는 release를 증명하지 않는다.

## 하나의 Release Evidence가 담아야 하는 것

| 항목 | 확인 방법 |
| --- | --- |
| Repository 상태 | release 대상 commit SHA(가능하면 tag)가 `main`에 포함 |
| Pages 일치 | `https://guecom.github.io/card-capture/index.html` 콘텐츠 해시 == 해당 SHA의 `docs/index.html` 해시 (`sw.js` 동일) |
| GAS 동작 | `ping` ok · 무효 토큰이 `whoami`/`list`/`persondoc`(·`search`·`researchinstruction`)에서 `invalid_token` · guest 조사 지시 `owner_only` · target mismatch 거부 · unknown action 거부 · (배포 직후) 유효 owner 토큰 1회 실동작은 사람이 폰에서 확인 |
| GAS 배포 | 어떤 deployment version이 어느 Code.gs 상태인지(배포 일시·버전 메모) |
| Watcher | 실행 중 PID·health 파일 최신성(`watcher-health.json`), 워처 스크립트 버전(commit) |
| Processing contract | vault `CardCapture_Processing.md`의 당시 상태(vault 이력으로 식별) |
| Human gate | merge·tag·GAS deployment를 승인한 사람·시점 |

release 기록은 이 파일 하단 "Verified Baselines"에 최신이 위로 오게 추가한다.

## Release 절차 (사람 게이트 포함)

1. **릴리즈 PR 안에서, merge 전에** 버전을 확정한다 — (a) `CHANGELOG.md`의 `[Unreleased]` 아래에 `## vX.Y.Z — 날짜 — 커밋` heading을 만들고, (b) `frontend/package.json`의 `version`을 `X.Y.Z`로 올리고, (c) 빈 `[Unreleased]`를 위에 남긴다. **tag 뒤로 미루지 마라** — 미루면 tag가 붙는 커밋에 옛 버전이 담겨 배포된 앱이 자기 버전을 틀리게 말한다. v2.13.0에서 실제로 일어났다(앱이 `버전 2.12.0`을 표시했고, `package.json`과 CHANGELOG가 **함께** 뒤처져 서로 일치했기 때문에 두 곳을 대조하는 검사로는 보이지도 않았다). `eval/version-sync.test.js`가 이 셋(heading·`package.json`·**실제 tag**)을 CI에서 강제한다.
2. branch → draft PR → `scripts/validate.ps1` PASS → 사람 review·merge (human gate).
3. 사람: release tag `vX.Y.Z` 생성 (human gate). 1단계에서 확정한 값과 **정확히 같은** 버전이어야 한다.
4. `Code.gs` 변경이 있으면 사람: GAS 재배포 — vault `CardCapture_Setup.md`의 클릭 단위 절차 (human gate).
5. 검증: 위 표의 각 항목 확인(Pages 해시 비교, GAS probe는 무효 토큰 거부까지 스크립트로, 유효 토큰 실동작은 폰에서). **배포된 앱의 설정 화면이 이 tag와 같은 버전을 말하는지 확인한다.**
6. 이 파일에 baseline 기록 + vault Task에 exact SHA·결과 회수.

조사 지시를 되돌릴 때는 code rollback 전에도 Script Property `RESEARCH_INSTRUCTION_ENABLED=false`로 새 접수를 닫을 수 있다. 이 변경과 재활성화는 사람 운영 게이트다.

## Rollback

- 코드: `git revert` 후 동일 절차(사람 merge). Pages는 main 반영 후 수 분 내 재빌드.
- GAS: 배포 관리에서 이전 version으로 전환(사람). 전환 후 behavior probe 재실행.
- 워처: 이전 commit의 `CardCapture_Watcher.ps1`로 교체 후 재시작(사람; BOM 유지 필수).

## Known Limitations (정직한 경계)

- GitHub Actions CI가 `scripts/validate.ps1`과 frontend unit·build·Playwright gate를 실행하지만, 실제 Android/iOS camera와 사용자 계정 상태는 합성 CI가 대체하지 못한다.
- 처리 agent의 write allowlist는 계약+회귀(eval) 수준이며 OS 수준 강제가 아니다(`SECURITY.md`).
- GAS 배포 version과 Code.gs 상태의 연결은 수동 기록에 의존한다(자동 검증 endpoint 없음).
- v2.0.0 배포 직후 유효 owner token을 쓰는 실동작은 token 노출과 운영 데이터 쓰기를 피하기 위해 agent가 자동 실행하지 않았다. founder는 배포 승인 전 앱과 검색이 정상 동작함을 확인했고, 다음 실제 폰 사용이 배포 후 owner-token 재확인 역할을 한다.

## Verified Baselines

> **기록 공백 (정직한 경계):** `v2.10.0`·`v2.11.0`·`v2.12.0`·`v2.13.0`은 tag가 존재하지만 여기에 baseline이 없다. 절차 6단계가 실행되지 않았다. **사후에 지어내지 않는다** — 그때의 Pages live 콘텐츠·워처 상태·사람 게이트 시점을 지금은 확인할 수 없기 때문이다. 각 릴리즈의 내용은 `CHANGELOG.md`와 vault Task에 남아 있다. 이 공백은 `ISS-000123`(배포된 앱이 자기 버전을 틀리게 말함)과 같은 뿌리다 — **릴리즈 기록과 실제 상태가 따로 놀았다.**

### v2.14.0 @ `0380b9e` — 검증 2026-07-28 (agent:kairen.claude, Kairen-Ref: TSK-000312 / ISS-000119) — **Code.gs 무변경**

- repository: annotated tag `v2.14.0` → merge commit `0380b9e`(main). 담은 merge는 PR #52(UI 변경)와 PR #54(버전 표기·CHANGELOG 구간 정리) 둘이다. lane은 둘 다 `HUMAN TEST REQUIRED`.
- human gate: founder가 2026-07-28 세션에서 여섯 항목의 관찰을 전달하고 `PR, Merge, Release`를 지시했다. **Apps Script 재배포·워처 재기동·토큰 변경·실데이터 삭제는 승인 범위 밖이며 이 릴리즈에 필요하지도 않다.**
- CI: `validate` SUCCESS — run `30287039169`. unit 311 PASS, Playwright 95 PASS, repository validator `fail=0 warn=0`. 신규 게이트 `frontend/e2e/surface-polish.spec.ts` 5건 등록.
  - **정직한 경계**: 이 run은 재실행 2회 뒤 성공했다. `offline-shell.spec.ts:134`(큐 배출 5초 폴링 초과)와 `credential-boundary.spec.ts:294`(readonly를 벗기는 테스트 준비 단계가 React 재렌더와 경합)가 러너 부하에 따라 간헐 실패한다. 둘 다 로컬에서 `--repeat-each 3` 통과하고 이 릴리즈의 변경과 무관한 **테스트 쪽 타이밍 경합**이지만, 게이트가 불안정하다는 사실 자체는 기록해 둔다.
- Pages: **live와 commit blob이 exact-match** — `docs/index.html` `0b491c9253fc2058…`, `docs/sw.js` `f171a6c6190a541a…`, `docs/next/index.html` `543bff7e3a315e1c…`, `docs/next/sw.js` `ce3e16e8f528be53…`, `docs/legacy.html` `e1a3a46c4b79639f…`. 이번 변경이 실제로 나갔는지는 앱이 부르는 스타일시트로 따로 확인했다 — `docs/next/assets/index-DQj-IU3x.css` `91ed24e52bff9de8…`, 그 안에 `--cc-accent` 두 테마 값과 `cc-ai-sweep`이 들어 있다.
  - Windows 체크아웃에서 working copy를 그대로 해싱하면 CRLF 때문에 전부 DIFF로 보인다. 위 값은 **commit blob**(`git show HEAD:docs/...`) 기준이다.
- **GAS deployment: 해당 없음.** `Code.gs` 무변경. 이전 baseline의 상태와 확인 해시가 그대로 유효하다.
- Watcher: 이 릴리즈의 diff는 `watcher/`를 바꾸지 않는다. **그러나 v2.10.0부터 열려 있던 재기동 human gate가 이 시점에 해소됐다** — 운영 클론 `watcher/CardCapture_Watcher.ps1`이 저장소와 byte 동일(`525e23340ef3…`)이고, 그 파일이 2026-07-28 01:12:20에 갱신된 **뒤** 01:38:37에 프로세스(PID 50892)가 새로 떴다. 즉 지금 실행 중인 것이 v2.11.0·v2.12.0의 하드닝된 코드다(명함 내용 로그 분리, 프롬프트 경계 하드닝, 지문 미상 시 격리). `eval/prompt-injection.test.js`의 `PENDING_DEPLOY_LIVE_SURFACE_SHA256` 선언을 걷고 엄격 동일성으로 복귀시켰다.
  - **PID 세기 함정**: 워처 프로세스를 세는 진단 명령이 `CommandLine -like '*CardCapture_Watcher*'`로 거르는데 **그 명령 자신이 그 문자열을 갖고 있어 자기를 잡는다.** 이 세션에서 두 번 났다(PID 47728, 55484). `$PID`와 부모를 제외해야 실제 워처가 **하나**임이 드러난다.
  - **남은 문제**: 재기동 뒤에도 `watcher-health.json`이 갱신되지 않는다 — 아직 2026-07-26 16:26의 PID 39880이다. 이 표의 "Watcher: 실행 중 PID·health 파일 최신성" 항목이 **이 릴리즈에서 검증 불가**라는 뜻이다. `watcher.log` 쪽은 판정을 보류한다: 관측한 에이전트가 AppContainer 샌드박스에서 돌아 `%LOCALAPPDATA%`가 리다이렉트되고, 그 에이전트가 01:28에 해당 파일을 쓴 뒤라 copy-on-write 사본을 보고 있을 수 있다. 별건으로 `ISS-000127`.
- 실기기 판정: **미완료.** 이 릴리즈는 시각 변경이 본체이고 machine gate는 렌더된 픽셀까지만 증명한다. founder의 실폰 확인이 남아 있다.

### v2.9.0 @ `5f90f1b` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000288·289·290) — **Code.gs 무변경**

- repository: annotated tag `v2.9.0` → squash merge commit `5f90f1b`. 담은 merge는 PR #47 하나이며 lane 브랜치 3개(`agent/w4-a1-queue-lock`·`agent/w4-a2-subject-ctx`·`agent/w4-a3-repro-build`)가 통합돼 있다.
- human gate: 이전 릴리즈와 동일한 founder 사전 승인. **Apps Script 재배포·워처 재기동·토큰 변경·실데이터 삭제는 승인 범위 밖.**
- CI: `validate` SUCCESS — run `30250321385`. unit 300 PASS, Playwright 72 PASS, repository validator `fail=0 warn=0`. 신규 게이트 `eval/build-reproducibility.test.js` 등록(~1.7s).
- Pages: **live와 commit blob이 exact-match** — `docs/index.html` `0b491c9253fc2058…`, `docs/sw.js` `f171a6c6190a541a…`, `docs/legacy.html` `f176fef409394ee5…`.
- **GAS deployment: 해당 없음.** `Code.gs` 무변경. v2.5.0의 `PENDING`이 그대로 유효하고 확인 해시도 `f9a78d9a…` 그대로다.
- **watcher: 해당 없음.** 이 릴리즈는 `watcher/`를 바꾸지 않았다. 재기동 `PENDING` 유지 — 그리고 live 워처는 여전히 살아 있지 않다(하트비트 2026-07-26 16:26 이후 없음, 실제 워처 프로세스는 PID 18108 **하나**).
- 닫은 것:
  - `ISS-000112` — 만남 맥락(`event`·`relSelf`·`relKairen`·`research`·`stickyAt`)이 `PRIVATE_KEYS` 열거에 없어 subject 격리 밖이었다. **화면 노출로 끝나지 않았다** — `App.tsx:338→341→874` 경로로 sticky 값이 `buildQueuedCapture`에 들어가 **owner의 관계 메모가 guest의 캡처로 서버에 기록**됐다. 함께 확인된 두 번째 결함: legacy 전역 키를 현재 subject로 **이관**하던 동작. `docs/legacy.html`이 그 네 키를 지금도 쓰므로 상속 창이 계속 열리고, `App.tsx:304`가 서버 응답 전에 캐시된 owner 플래그로 UI를 켜므로 오프라인 구간 내내 guest에게 owner 화면이 뜬다. 이제 어느 subject로도 이관하지 않고 버린다.
  - `ISS-000111` — `FI-053` fallback lease가 `localStorage` check-then-act였다(실측: 두 탭 모두 `run()` 진입). read-back 확인으로 **좁혔다. 닫지 못했다.** 남는 창 두 가지가 코드 주석에 있다. **실제로 닫는 것은 미배포 상태인 서버 멱등(`FI-010`)이다 — `FI-053`을 다시 `DELIVERED`로 선언하지 않는다.**
  - `TSK-000290` — 빌드 비재현성. 원인은 `vite.config.ts:137`의 `new Date()`가 빌드 ID로 주입된 것이고, entry 청크 → 파일명 해시 → `index.html` → `sw.js` SHELL/캐시명으로 파급됐다. 빌드 ID를 소스 해시(`src-*`)로 바꿔 화면 값을 저장소에서 재계산해 대조할 수 있다.
- **계약을 다시 썼다**: `SECURITY.md`의 사적 상태 격리 항목이 **닫힌 열거**였던 것이 `ISS-000112`의 원인이다. 원칙 + 예외 하나로 바꿨다 — "그 사람이 직접 적었거나 그 사람에게만 보이는 값은 모두 사적 상태이며, 촬영 대기열만 예외(유일본)".
- **통합자 전제가 두 번 정정됐다**: (1) 목록 사각지대는 30건이 아니라 100건이었다(v2.6.0). (2) "두 번 빌드해 비교" 게이트는 타임스탬프 단위가 1분이고 빌드가 0.6초라 **결함이 있는 채로 약 92% 확률로 통과한다** — lane이 가짜 시계·타임존 주입으로 결정적으로 만들었다.
- **미검증으로 남긴 것**: Node 22 ↔ Node 24 간 빌드 재현성. 게이트는 한 환경 안에서만 강제한다.
- rollback: PR #47 `git revert` 하나.
- **남은 human gate**: (1) Apps Script 재배포, (2) 라이브 워처 재기동, (3) founder actual-phone acceptance.

### v2.8.0 @ `e93fdfe` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000287) — **보안 릴리즈 · Code.gs 무변경**

- repository: annotated tag `v2.8.0` → squash merge commit `e93fdfe`. 담은 merge는 PR #46 하나(lane `agent/w3-sw-cache`).
- human gate: v2.6.0·v2.7.0과 동일한 founder 사전 승인. **Apps Script 재배포·워처 재기동·토큰 변경·실데이터 삭제는 승인 범위 밖.**
- CI: `validate` SUCCESS — run `30244898163`. unit 293 PASS, Playwright 72 PASS, repository validator `fail=0 warn=0`.
- Pages: build 성공 후 **live와 commit blob이 exact-match** — `docs/sw.js` `f171a6c6190a541a…`, `docs/legacy.html` `f176fef409394ee5…`. (비교는 commit blob 기준 — Windows CRLF 변환 때문.)
- **GAS deployment: 해당 없음.** `Code.gs` 무변경. v2.5.0의 `PENDING`이 그대로 유효하고 확인 해시도 `f9a78d9a…` 그대로다.
- **watcher: 해당 없음.** `watcher/` 무변경. 재기동 `PENDING` 유지.
- 닫은 것: `ISS-000110`의 두 번째 결함 — `docs/sw.js`가 같은 origin GET을 query string 포함 전체 URL을 키로 캐시해, 초대 링크를 **한 번만 열어도** 개인 링크 코드가 Cache Storage 키에 영구 저장됐고 `연결 해제`가 지우지 않았다. 읽기 경로가 `ignoreSearch: true`라 그 토큰은 기능상 필요조차 없었다. 키에서 query를 떼고 `CACHE` 버전을 올려 오염된 기존 캐시가 activate에서 지워지게 했다.
- **왜 게이트가 못 잡았나**: `credential-boundary.spec.ts:204`가 **이미** "캐시 키에 링크 코드가 없다"를 단언하고 있었다. 그러나 `docs/index.html`·`docs/legacy.html`은 Service Worker를 `location.protocol === 'https:'`일 때만 등록하고 e2e harness는 `http://127.0.0.1`로 서빙한다 — **루트 워커는 어떤 테스트에서도 등록된 적이 없었다.** 신규 게이트가 명시적으로 등록해서 연다.
- 함정 경고를 남겼다: 후보 앱(`next/`) 워커도 전체 URL로 키를 만든다. 누출이 없는 이유는 계약이 아니라 사고다 — `response.clone()`이 `caches.open()` 이후에 평가돼 매번 던진다(실측: 성공 fetch 4회 후 SHELL 밖 항목 0건). **그 순서를 "고치면" 같은 누출이 생긴다.** `frontend/vite.config.ts`에 경고 주석과 선제 게이트가 있다.
- **사용자 영향(실측)**: 캐시 버전 올림으로 앱 셸 0.30MB 즉시 재다운로드, 이전 앱 OCR 사용자는 다음 사용 때 최대 18.53MB. `cardcapture-next-*` 후보 캐시는 영향 없음.
- **남는 한계**: 연결을 끊고 이 주소를 다시 열지 않는 기기는 예전 캐시를 그대로 들고 있다. Service Worker 생애주기상 클라이언트 해결책이 없다 — 코드가 실제 유출됐다면 **서버에서 코드를 회수하는 것이 진짜 대응**이다.
- rollback: PR #46 `git revert` 하나. 되돌리면 캐시 버전이 `v19`로 돌아가 셸을 한 번 더 받는다.
- **남은 human gate**: (1) Apps Script 재배포, (2) 라이브 워처 재기동, (3) founder actual-phone acceptance.

### v2.7.0 @ `35192bd` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000285·286) — **보안 릴리즈 · Code.gs 무변경**

> 이 릴리즈는 **`FI-004`·`FI-005`의 v2.1.0 `DELIVERED` 선언이 사실이 아니었음을 고친 것**이다. 독립 보안 평가(`TSK-000284` / `RSL-000152`)가 뒤집었고 통합자가 lane 하네스를 쓰지 않고 소스로 재현했다.

- repository: annotated tag `v2.7.0` → squash merge commit `35192bd`. 담은 merge는 PR #45 하나이며 lane 브랜치 2개(`agent/w3-origin-pin`·`agent/w3-legacy-boundary`)가 통합돼 있다.
- human gate: v2.6.0과 동일한 founder 사전 승인. **Apps Script 재배포·워처 재기동·토큰 변경·실데이터 삭제는 승인 범위 밖.**
- CI: `validate` SUCCESS — run `30244321016`. unit 293 PASS, Playwright 68 PASS, repository validator `fail=0 warn=0`. 신규 게이트 `eval/legacy-credential.test.js` 등록.
- Pages: build run `30244572074` success. **live와 commit blob이 exact-match** — `docs/index.html` `0b491c9253fc2058…`, `docs/legacy.html` `f176fef409394ee5…`, `docs/sw.js` `85e9a4de8ea093cf…`.
- **GAS deployment: 해당 없음.** `Code.gs` 무변경. v2.5.0의 `PENDING`이 그대로 유효하고 확인 해시도 `f9a78d9a…` 그대로다.
- **watcher: 해당 없음.** `watcher/` 무변경. 재기동 `PENDING` 유지.
- 닫은 것:
  - `ISS-000109` — 신뢰 판정을 origin에서 **origin + pathname**으로 좁혔다. `script.google.com`은 누구나 자기 Apps Script를 배포할 수 있는 multi-tenant 호스트라 origin 일치가 "우리 백엔드"를 뜻하지 않았다. `?k=` 없이 `?api=`만으로도 저장된 피해자 토큰이 공격자 배포본으로 나갔다(lane이 실제 요청으로 재현). pinned origin 판정을 page-origin 규칙보다 **먼저** 둬서 경로 판정이 느슨해질 수 없게 했다. 채택 주소에서 query·fragment를 버리고 `연결 해제`가 `api` 키까지 정리한다.
  - `ISS-000110` — `docs/legacy.html`이 `?api=`를 무검증 저장하고 `?k=`를 주소창에서 지우지 않으며 referrer 정책이 없었다. React 앱과 같은 저장 키를 써서 새 앱까지 오염됐다. **이쪽이 더 넓다 — 임의 origin이 가능했다.** 이제 빌드에 박힌 `DEFAULT_API`만 쓰고 저장돼 있던 다른 주소도 실행 시 폐기한다. `DEFAULT_API` 줄은 바이트 단위로 그대로다(확인함).
- **왜 회귀 게이트가 통과시켰나**: 기존 `credential-boundary.spec.ts`는 적대적 주소로 **다른 origin만** 시험했고 5개 테스트가 **전부 `next/`만** 열었다. 새 게이트는 같은 origin 다른 경로를 시험하고, legacy 표면을 실제로 열며, 컨텍스트의 **모든** 요청을 가로채 "빌드에 박힌 origin 밖 요청 == []"로 판정한다.
- 부수: **e2e가 매 실행마다 실제 GAS 배포본에 인증 요청을 보내고 있었다.** `?api=`가 거부되면 앱이 pinned 기본값으로 되돌아가 부팅 직후 실서버를 호출했다. lane F가 발견해 공유 `beforeEach` 가드로 막았다.
- 문서 정정: `SECURITY.md`·`AGENTS.md`가 허용 공개 상수(`DEFAULT_API`) 위치를 `docs/index.html`로 적고 있었으나 그 파일에는 exec URL이 **0건**이다. 실제 상수는 `docs/legacy.html`에만 있고 `frontend/vite.config.ts`가 읽는 React 앱 pinned endpoint의 유일한 원본이다.
- **운영 영향**: `?api=`가 production에서 사실상 무의미해진다. 기존 배포를 새 버전으로 갱신하면 exec URL이 유지되므로 일상적 재배포는 영향 없다. **새 deployment를 만들면 URL이 바뀌고** 그때는 `docs/legacy.html`의 `DEFAULT_API` 수정 → 빌드 → Pages 재배포가 필요하다. 개발 harness(`.test`·`.localhost`)는 그대로다.
- rollback: PR #45 `git revert` 하나.
- **남은 human gate**: (1) Apps Script 재배포, (2) 라이브 워처 재기동, (3) founder actual-phone acceptance.

### v2.6.0 @ `c515873` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000280·281·282·283) — **Code.gs 무변경 · 앞선 GAS 배포·워처 재기동 PENDING 유지**

> 이 릴리즈는 `Code.gs`를 건드리지 않았다. 따라서 v2.4.0·v2.5.0의 **미배포 서버 변경 두 건은 그대로 남아 있고 `ISS-000108`도 live에서 여전히 열려 있다.** 이 baseline은 그 상태를 바꾸지 않는다.

- repository: annotated tag `v2.6.0` → squash merge commit `c515873` (`main`에 포함). 담은 merge는 PR #44 하나이며, 그 안에 lane 브랜치 4개(`agent/w3-watcher-health`·`agent/w3-trace`·`agent/w3-recall`·`agent/w3-content-type`)가 통합돼 있다.
- human gate: founder가 세션에서 `Feature Index를 순차적으로 개발 · 문서가 승인 받으라 해도 다시 묻지 말 것 · merge와 release까지 네가 한다 · 결정이 필요하면 네 추천대로`로 구현·merge·tag를 사전 승인함. **Apps Script 재배포·워처 재기동·토큰 변경·실데이터 삭제는 승인 범위에서 명시적으로 제외.**
- CI: `validate` SUCCESS — run `30243635918`. unit 280 PASS(25 files), Playwright 61 PASS, repository validator `fail=0 warn=0`. 신규 게이트 2종 등록: `eval/upload-content-type.test.js`, `watcher/tests/health-tests.ps1`(**워처 스위트가 CI에서 실행되는 첫 사례**).
  - 첫 두 실행은 `int15-surfaces.spec.ts:218`에서 실패했다. 같은 SHA에서 측정값이 `1087.86` / `989.69`로 **매번 달랐다** — 레이아웃 초과가 아니라 ion-modal 시트가 정착하기 전의 중간 프레임이다. 그 검사는 `toBeEnabled()` 직후 `boundingBox()`를 읽고 있었고 정착 대기가 없었다. spec 파일이 늘며 CI 동시 실행 조합이 바뀌어 원래 racy했던 읽기가 드러난 것이다. 재시도하는 `toBeInViewport({ ratio: 1 })`(기존 아래 경계 검사보다 강한 조건)로 고정했고, 시트를 320px 내리는 CSS 주입으로 그 단언이 `viewport ratio 0`으로 FAIL하는 것을 확인해 형식적이지 않음을 증명했다.
- Pages: build run `30243889773` success. **live와 commit blob이 exact-match** — `docs/index.html` `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`, `docs/sw.js` `85e9a4de8ea093cf8134a2866c7757214c8c2f6846b60a551e3bd2222c459e7f`. (비교는 working tree가 아니라 commit blob 기준 — Windows CRLF 변환 때문.)
- **GAS deployment: 이번 릴리즈에 해당 없음.** `Code.gs` 무변경(`git diff v2.5.0 v2.6.0 -- Code.gs` 비어 있음). v2.5.0의 `PENDING` 상태가 그대로 유효하며 확인 해시도 그대로 `f9a78d9aa5bc34cc1a70a3ffaf51b5d73db81b0f77a9d90f23e8ff48dfb5b364`다.
- GAS live probe(무효 토큰만, 유효 token 미사용): `ping` → `ok:true`; `whoami`·`list`·`search` → `invalid_token`; `?action=nonsense` → `unknown_action`. **이 probe는 여전히 예전 배포본(version 5)을 확인한 것이다.**
- **watcher: 재기동 미실행 (PENDING) — 그리고 현재 live 워처는 살아 있지 않다.** 관찰: health 파일 `pid=39880`, `lastHeartbeat=2026-07-26 16:26:30`, `watcher.log`에 2026-07-27 기록 0줄. PID 39880은 존재하지 않고, PID 18108이 오늘 14:48에 기동했으나 로그·health를 한 줄도 쓰지 않았다. **agent는 어떤 프로세스도 죽이거나 띄우지 않았다.** 이번 릴리즈의 `CardCapture_Health.ps1`이 이 상태를 `CRITICAL / orphan_watcher_process`로 단정한다. `.ps1` UTF-8 BOM 확인 완료.
- processing contract: vault `CardCapture_Processing.md` 변경 없음.
- 이 release가 닫은 Feature Index slice: `FI-029`(처리 health dashboard), `FI-021`(correlation ID·redacted log), `FI-100`(목록 pagination), `FI-104`(검색 근거 스니펫). `FI-012`(magic-byte)는 **결함을 기계로 증명하고 게이트만 심었다** — 서버 수정은 재배포 사이클 뒤다.
- **실측된 결함**(전부 수정 전 FAIL 관찰): 재전송 대조가 100건만 읽어 이미 접수된 캡처를 다시 올릴 수 있었음(합성 서버 150건에서 101번째 이후 누락) / `예전 기록 더 보기`가 100건에서 죽은 버튼이 됨 / 워처 health가 PID 재사용에 무력해 죽은 워처를 정상으로 보고 / health가 처리기 원본 출력을 노출(실측 로그의 99.8%가 명함 내용) / 서버가 업로드 바이트를 검사하지 않아 비이미지 10종이 `front.jpg`로 접수.
- **재현 불가 확인**: frontend 빌드가 재현 가능하지 않다. 소스가 동일한데 `docs/next` entry 해시가 매 빌드 바뀐다(세 번 연속 확인). 커밋된 `docs/next`가 소스와 맞는지 재빌드로 검증할 수 없다는 뜻이다. 위 Pages 비교는 손으로 쓴 `docs/index.html`·`docs/sw.js`를 쓰므로 그 계약 자체는 유효하다.
- rollback: PR #44 `git revert` 하나. GAS·워처는 건드리지 않았으므로 되돌릴 것이 없다.
- **남은 human gate**: (1) Apps Script 재배포, (2) 라이브 워처 재기동, (3) founder actual-phone acceptance. 셋 다 `NOT RUN — HUMAN/EXTERNAL`이다.

### v2.5.0 @ `e335652a2379fa6c90cdbdca2a8c3230e76fd676` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000276·277·278·279) — **GAS 배포 PENDING · 워처 재기동 PENDING**

> ⚠️ **이 baseline은 두 곳이 미완이다.** `Code.gs`와 `watcher/`가 모두 바뀌었고 둘 다 사람 게이트다. 앱(`docs/`)만 자동 반영된다. **재배포·재기동 전까지 `ISS-000108`(브리핑 조작)은 live에서 여전히 열려 있다.**

- repository: annotated tag `v2.5.0` → `e335652a2379fa6c90cdbdca2a8c3230e76fd676`. 담은 merge는 PR #39(`e941e5e`), #41(`3da2003`), #40(`58b475c`), #42(`e335652`)다. v2.4.0의 미배포 `Code.gs` 변경 위에 #41이 쌓였다.
- human gate: founder가 `순차적으로 개발 진행 · 내 승인 없이 그냥 쭉 진행 · 결정 필요사항은 너의 추천대로 · 적절한 시점마다 merge 및 릴리즈`와 `병렬적으로 진행 · 멀티 에이전트`로 구현·merge·tag를 사전 승인함. **Apps Script 재배포와 라이브 워처 재기동은 승인 범위에서 제외**(Google 로그인·운영 프로세스 조작).
- CI: `validate` SUCCESS — PR #39 run `30237928703`, #41 `30238273284`, #40 `30238618766`, #42 `30238847458`. 최종 head 기준 unit 229 PASS, Playwright 56 PASS, repository validator fail=0 warn=0(신규 eval 게이트 4종 등록 포함).
- Pages: build commit `e335652…`, status `built`. live와 commit blob이 exact-match — `docs/index.html` `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`; `docs/next/index.html`·active JS `assets/index-H1CA71r5.js`·active CSS `assets/index-DZeXLMal.css` 전부 일치.
- **GAS deployment: 미실행 (PENDING).** repository `Code.gs` 정규화(EOL LF) sha256 = `f9a78d9aa5bc34cc1a70a3ffaf51b5d73db81b0f77a9d90f23e8ff48dfb5b364`. live deployment는 v2.0.0의 **version 5**(`990487a7…`)다. **세 해시가 모두 다르다** — v2.4.0·v2.5.0의 서버 변경이 누적 미배포다. 재배포 시 반드시 **v2.5.0의 해시**로 확인해야 한다(v2.4.0 체크리스트의 값은 이제 낡았다).
- GAS live probe: `ping` ok, 무효 토큰 `invalid_token`, unknown action `unknown_action`. **이 probe는 예전 배포본을 확인한 것이며 이번 변경을 검증하지 않는다.** 유효 token 미사용.
- **watcher: 재기동 미실행 (PENDING).** `watcher/`가 4파일 바뀌었다(`git diff v2.4.0 e335652 -- watcher/`). 실행 중 PID `34896`은 예전 프로토콜이며 **건드리지 않았다.** health 파일이 `pid=39880`을 가리키는 불일치도 관찰만 했다 — 재기동 시 함께 확인해야 한다. `.ps1` 4개 UTF-8 BOM 확인.
- processing contract: vault `CardCapture_Processing.md` 변경 없음. 단, deep 프롬프트에 `TARGET-CAPTURE-ID`가 추가돼 "가장 이른 한 건" 규칙을 좁힌다(`FI-019` 동작에 필수).
- 이 release가 소스에서 닫은 Feature Index slice: `FI-011`·`FI-012`(파일명)·`FI-013`(파일 이름 서버 소유), `FI-017`·`FI-018`·`FI-019`(워처 프로토콜), `FI-022`·`FI-023`(golden·adversarial 게이트), `FI-046`·`FI-049`·`FI-067`(촬영 세션).
- **미해결로 남긴 것**: `TSK-000277`이 찾아낸 D3 — `doPost`가 `prior`를 읽은 뒤 워처가 마감하면 내용 변경 재업로드가 그 마감을 덮으며 이전 결과 표식을 하나도 남기지 않는다(`TSK-000275`의 잔여 race). 후속 lane 필요.
- rollback: Pages는 해당 PR `git revert`. GAS는 배포하지 않았으므로 되돌릴 것이 없다. 워처는 재기동하지 않았으므로 되돌릴 것이 없다.
- **남은 human gate**: (1) Apps Script 재배포, (2) 라이브 워처 재기동, (3) founder actual-phone acceptance. 셋 다 `NOT RUN — HUMAN/EXTERNAL`이다.

### v2.4.0 @ `ba307992b29198442196f33bde11866bd72aaba3` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000275) — **GAS 배포 PENDING**

> ⚠️ **이 baseline은 불완전하다.** `Code.gs`가 바뀐 첫 릴리즈이고 **Apps Script 재배포가 아직 실행되지 않았다.** 따라서 이 태그는 "repository와 회귀 게이트가 확정됐다"까지만 증명하며, **live 서버는 여전히 v2.0.0에서 배포한 version 5의 예전 동작**이다. 재배포와 그 후의 live probe가 끝날 때까지 이 릴리즈를 "서버가 보호된다"로 읽지 마라.

- repository: annotated tag `v2.4.0` → squash merge commit `ba307992b29198442196f33bde11866bd72aaba3` (`main`에 포함). 담은 merge는 PR #37 하나다.
- human gate: founder가 세션에서 `순차적으로 개발 진행. 내 승인 없이 그냥 쭉 진행. 결정 필요사항이 있는 경우 너의 추천대로 진행. 적절한 시점마다 merge 및 릴리즈`로 구현·merge·tag를 사전 승인함. **Apps Script 재배포는 Google 로그인이 필요한 사람 전용 작업이라 agent가 실행하지 않았다.**
- CI: GitHub Actions `validate` run `30236320998` SUCCESS. 같은 head에서 repository validator fail=0 warn=0(신규 `eval/upload-idempotency.test.js` 10건 포함), unit 215 PASS, Playwright 52 PASS.
- Pages: **콘텐츠 변경 없음.** 이 릴리즈는 `docs/`를 건드리지 않았다(`git diff --quiet v2.3.0 ba30799 -- docs/`). live 산출물은 v2.3.0 baseline과 동일하다.
- **GAS deployment: 미실행 (PENDING — 사람 게이트).**
  - repository `Code.gs` 정규화(EOL LF) sha256 = `ee7075038c61f0192b3f8d9f678574d4a8828b83fda63d1676c8f967adfd6f56`.
  - live deployment는 v2.0.0에서 배포한 **version 5**이며 그 Code.gs 상태는 `990487a7f09dcc2c0247b2a0e9013ab2dfedbd033560be143fbee7ea19206fb1`(v2.0.0 baseline 기록)이다. **두 해시가 다르다 = live와 repository가 의도적으로 어긋나 있다.**
  - 재배포 절차는 vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Setup.md`의 클릭 단위 절차를 따른다. 재배포 후 Apps Script editor의 Code.gs 정규화 sha256이 위 값과 일치하는지 확인하고, 이 항목을 갱신해야 한다.
- GAS live probe: 2026-07-27 13:16 KST `ping` → `{"ok":true,"service":"card-capture"}`. **이 probe는 예전 배포본을 확인한 것이며 이번 변경을 검증하지 않는다.** 유효 token은 사용하지 않았다.
- watcher: **재기동하지 않았다.** 이 릴리즈는 `watcher/`를 건드리지 않았다(`git diff --quiet v2.3.0 ba30799 -- watcher/`).
- processing contract: vault `CardCapture_Processing.md`를 변경 없이 사용함. `MVP build/testability gate comes before customer proof.`
- 이 release가 소스에서 닫은 Feature Index slice: `FI-009`(captureId ownership), `FI-010`(upload idempotency), `FI-015`(lifecycle monotonicity). **live에서 닫히는 것은 재배포 후다.**
- 재배포 후 달라지는 외부 계약: 업로드 응답에 `deduped`·`status`·`processedAt`가 추가되고, 다른 사람의 captureId로 업로드하면 `capture_conflict`로 거절된다. 현재 클라이언트는 `ok:true`만 읽으므로 **하위 호환**이다.
- rollback: 이 PR `git revert` 하나. 재배포를 했다면 Apps Script 배포 관리에서 이전 version(5)으로 전환하고 probe를 재실행한다.
- **남은 human gate**: (1) Apps Script 재배포, (2) 재배포 후 live probe와 실폰 확인. 둘 다 `NOT RUN — HUMAN/EXTERNAL`이다.

### v2.3.0 @ `85254a059886d827e490c2e6e28d9b200f809616` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000273)

- repository: annotated tag `v2.3.0` → squash merge commit `85254a059886d827e490c2e6e28d9b200f809616` (`main`에 포함). 이 release가 담은 merge는 PR #34 하나다.
- human gate: founder가 세션에서 `순차적으로 개발 진행. 내 승인 없이 그냥 쭉 진행. 결정 필요사항이 있는 경우 너의 추천대로 진행. 적절한 시점마다 merge 및 릴리즈`로 구현·PR merge·release tag·Pages 반영을 사전 승인함. **Script Properties·token·credential 변경과 GAS 재배포는 이 승인 범위에서 제외**했고, 실제로도 필요하지 않았다.
- CI: GitHub Actions `validate` run `30235225046` SUCCESS. 같은 head에서 unit 215 PASS, TypeScript/Vite production build PASS, Playwright 52 PASS, repository validator fail=0 warn=0.
- Pages: build source `main:/docs`, build commit `85254a059886d827e490c2e6e28d9b200f809616`, status `built`. live와 commit blob이 exact-match — `docs/index.html` sha256 `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`; `docs/sw.js` `85e9a4de8ea093cf8134a2866c7757214c8c2f6846b60a551e3bd2222c459e7f`; `docs/legacy.html` `d1b370a9ab8ae8c8d51b10a6136487cec57c7cd798a43e45ecf9a8e02dd52ab5`; `docs/next/index.html` `7318344b839af537c01c3819c9cd4b6d6cf3574936a79a21032148ebc72a2b09`; active JS `assets/index-CTRDAOhL.js` `8afed4ac9110b6fc11ec954fb303b17e93c5b824f214c4451ae4e56e6c7344c7`; active CSS `assets/index-CURCMqBP.css` `b68968a12c12938d59b97f0d848a7596b5197392ce9694cee1bfdf491cec7d03`. (비교는 working tree가 아니라 commit blob 기준이다 — Windows 체크아웃의 CRLF 변환이 파일 해시를 바꾼다.)
- GAS deployment: **변경 없음.** `Code.gs`는 v2.0.0(`c9036b3`) 이후 바뀌지 않았다(`git diff --quiet v2.2.0 85254a0 -- Code.gs`). Apps Script 재배포가 필요하지 않고 실행하지 않았다. live deployment는 v2.0.0에서 배포한 version 5 그대로다.
- GAS live probe: 2026-07-27 12:46 KST `ping` → `{"ok":true,"service":"card-capture"}`; invalid token `whoami`·`list` → `invalid_token`; unknown action → `unknown_action`. **유효 token은 사용하지 않았다.**
- watcher: **재기동하지 않았다.** 이 release는 `watcher/`를 건드리지 않았다(`git diff --quiet v2.2.0 85254a0 -- watcher/`). 실행 중 PID `34896`.
- processing contract: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`를 변경 없이 사용함. `MVP build/testability gate comes before customer proof.`
- 이 release가 새로 닫은 Feature Index slice: `FI-016`(응답 유실 뒤 서버 대조 후에만 재전송), `FI-021` 일부(업로드 실패를 `rejected`/`ambiguous`로 분류).
- **드러난 서버 측 미결 사항**: `Code.gs`의 업로드 경로는 `captureId` 폴더를 upsert하고 `capture.json`을 `status: 'received'`로 덮어쓴다. 지금은 **클라이언트가 재전송하지 않게** 막았을 뿐, 서버 자체의 idempotency(`FI-010`)와 lifecycle monotonicity(`FI-015`)는 없다. `Code.gs` lane에서 함께 다뤄야 한다.
- 병렬 작업: 구현 중 다른 세션이 PR #33·#35를 merge하고 v2.2.0을 릴리즈했다. 그 위로 rebase하고 `docs/next`를 재빌드했으며, 위 52 PASS에는 v2.2.0의 다크 모드·하단 바 게이트가 모두 포함된다.
- rollback: Pages는 `legacy.html` 또는 PR #34 `git revert` 하나. GAS·watcher·데이터 rollback은 이 release 범위에 없다.
- **남은 human gate**: founder actual-phone acceptance (`V7` = `NOT RUN — HUMAN/EXTERNAL`). merge와 Pages 반영을 actual-phone PASS나 customer proof로 승격하지 않는다.

### v2.2.0 @ `76ce78c8940a22e7cc69e64cea592517110f9426` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: INT-000016, TSK-000272)

- repository: annotated tag `v2.2.0` → squash merge commit `76ce78c8940a22e7cc69e64cea592517110f9426` (`main`에 포함). 이 release가 담은 merge는 PR #33 하나이고, PR의 exact head는 `9083e483eacc4965580488b7f9d8cf44c09ec86a`다.
- human gate: founder가 세션에서 `이거 보고 merge 및 release해줘` → `내 말은 개발하고 merge, release까지 해달라는거 였어`로 구현·PR merge·release tag·Pages 반영을 사전 승인함. **Script Properties·token·credential 변경과 GAS 재배포는 이 승인 범위에서 제외**했고, 실제로도 필요하지 않았다.
- CI: GitHub Actions `validate` run `30234506135` SUCCESS, exact head `9083e48`. 같은 head에서 unit 202 PASS, TypeScript/Vite production build PASS, Playwright 50 PASS(기존 43 + INT-000016 신규 7), repository validator fail=0 warn=0.
- Pages: build source `main:/docs`, build commit `76ce78c8940a22e7cc69e64cea592517110f9426`, status `built`. live와 commit 콘텐츠가 exact-match — `docs/index.html` sha256 `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`; `docs/sw.js` `85e9a4de8ea093cf8134a2866c7757214c8c2f6846b60a551e3bd2222c459e7f`; `docs/legacy.html` `d1b370a9ab8ae8c8d51b10a6136487cec57c7cd798a43e45ecf9a8e02dd52ab5`; `docs/next/index.html` `e98e0fc7c8a05a793fa986187fc9178df99dc962e37946eac2a0e5372a401852`; active JS `assets/index-CFg5TftA.js` `33ccfea66e9752d080430b43fe853a43fc2cd5ac64b9adec37be805bfccc5555`; active CSS `assets/index-CURCMqBP.css` `b68968a12c12938d59b97f0d848a7596b5197392ce9694cee1bfdf491cec7d03`. (비교는 working tree가 아니라 commit blob 기준이다 — Windows 체크아웃의 CRLF 변환이 파일 해시를 바꾼다.)
- Pages behavior: live `https://guecom.github.io/card-capture/next/`에서 `--cc-app-height`가 `100dvh`, `--cc-safe-bottom`이 고정 `0px`로 계산되고, 설정의 `화면 테마`에서 `다크`를 고르면 `data-theme="dark"` · 배경 `rgb(15,21,30)` · `theme-color` `#111823`으로 즉시 바뀌며 선택값이 저장되는 것을 확인함. 표시된 빌드 식별자는 `2026-07-27 03:22Z`다.
- GAS deployment: **변경 없음.** `Code.gs`는 v2.0.0(`c9036b3`) 이후 바뀌지 않았다(`git diff --quiet v2.1.0 76ce78c -- Code.gs`). Apps Script 재배포가 필요하지 않고 실행하지 않았다. live deployment는 v2.0.0에서 배포한 version 5 그대로다.
- GAS live probe: 2026-07-27 12:30 KST `ping` → `{"ok":true,"service":"card-capture"}`; invalid token `whoami`·`list` → `invalid_token`; unknown action → `unknown_action`. **유효 token은 사용하지 않았다** — 운영 데이터 쓰기와 token 노출을 피하기 위함이며, owner-token 실동작은 다음 실제 폰 사용이 담당한다.
- watcher: **재기동하지 않았다.** 실행 중 PID `34896`(2026-07-27 10:06 시작), 스크립트 경로 `card-capture/watcher/CardCapture_Watcher.ps1`. 이 release는 `watcher/`를 건드리지 않았고(`git diff --quiet v2.1.0 76ce78c -- watcher/`), 실행 중 워처가 로드한 스크립트와 release commit의 워처 스크립트가 EOL 정규화 기준 sha256 `5b689d1d43c865af3276e51a6ab178e53cdcde2d01c5725829056ba203557e0d`으로 동일함을 확인했다.
- processing contract: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`를 변경 없이 사용함. `MVP build/testability gate comes before customer proof.`
- 병렬 작업: 구현 중 PR #30·#31·#32가 `main`에 들어와 그 위로 rebase하고 `docs/next`를 재빌드했다. 위 50 PASS에는 #30의 queue-truth 게이트와 #31의 접근성 게이트가 모두 포함된다.
- **남은 human gate**: founder actual-phone acceptance. 특히 **하단 탭 바 항목의 최종 판정은 실제 폰이다** — headless Chrome에는 접히는 주소창이 없어, CI가 잠근 것은 원인 조건(껍데기 높이·여백 고정·스크롤 불변)이지 현상 재현이 아니다. merge와 Pages 반영을 actual-phone PASS나 customer proof로 승격하지 않는다.
- rollback: Pages는 `legacy.html` 또는 PR #33 `git revert` 하나. GAS·watcher·데이터 rollback은 이 release 범위에 없다.

### v2.1.0 @ `6bcb664803db04ac7770574acc31c882e1a18f4b` — 검증 2026-07-27 (agent:kairen.claude, Kairen-Ref: TSK-000269, TSK-000270, TSK-000271)

- repository: annotated tag `v2.1.0` → merge commit `6bcb664803db04ac7770574acc31c882e1a18f4b` (`main`에 포함). 이 release가 담은 merge는 PR #29 `f591b79`, PR #30 `e1e8ea5`, PR #31 `6bcb664`이며, v2.0.0 이후 누적된 PR #19~#28도 함께 처음 릴리즈된다.
- human gate: founder가 세션에서 `내 승인 없이(글에 승인 받으라고 했음에도 불구하고) 그냥 쭉 해서 머지 및 릴리즈까지 해줬으면 좋겠어`로 PR merge·release tag·Pages 반영을 사전 승인함. **Script Properties·token·credential 변경과 GAS 재배포는 이 승인 범위에서 제외**했고, 실제로도 필요하지 않았다(아래 참조).
- CI: GitHub Actions `validate` SUCCESS — PR #29 run `30231826796`, PR #30 run `30233443826`, PR #31 run `30233827541`. 최종 head 기준 unit 197 PASS, TypeScript/Vite production build PASS, Playwright 43 PASS, repository validator fail=0 warn=0.
- Pages: build source `main:/docs`, status `built`. live와 commit 콘텐츠가 exact-match — `docs/index.html` sha256 `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`; `docs/sw.js` `85e9a4de8ea093cf8134a2866c7757214c8c2f6846b60a551e3bd2222c459e7f`; `docs/legacy.html` `d1b370a9ab8ae8c8d51b10a6136487cec57c7cd798a43e45ecf9a8e02dd52ab5`; `docs/next/index.html` `1b71e099a5ed602932a1a32d38e9527c8a13f28eb41c7620ad146dd9b7b22ead`; active JS `assets/index-BuaW3bsz.js` `5e8a9d4d1c0da998b59d0400e326a43640a5616596f32e569580697ebf9ab522`.
- GAS deployment: **변경 없음.** `Code.gs`는 v2.0.0(`c9036b3`) 이후 한 줄도 바뀌지 않았다(`git diff --quiet v2.0.0 6bcb664 -- Code.gs`). 따라서 이 release에 Apps Script 재배포가 필요하지 않고, 실행하지 않았다. live deployment는 v2.0.0에서 배포한 version 5 그대로다.
- GAS live probe: 2026-07-27 12:04 KST `ping` → `{"ok":true,"service":"card-capture"}`; invalid token `whoami`·`list` → `invalid_token`; unknown action → `unknown_action`. **유효 token은 사용하지 않았다** — 운영 데이터 쓰기와 token 노출을 피하기 위함이며, owner-token 실동작은 다음 실제 폰 사용이 담당한다.
- watcher: **재기동하지 않았다.** 실행 중 PID `34896`(2026-07-27 10:06 시작), 스크립트 경로 `card-capture/watcher/CardCapture_Watcher.ps1`. 이 release의 세 PR은 `watcher/`를 건드리지 않았고, 실행 중 워처가 로드한 스크립트(`8de6316`)와 release commit의 워처 스크립트가 **바이트 동일**함을 확인했다.
- processing contract: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`를 변경 없이 사용함. `MVP build/testability gate comes before customer proof.`
- 이 release가 새로 닫은 Feature Index slice: `FI-004`·`FI-005`·`FI-006`·`FI-007`(credential 전송 경계와 기기 내 subject 격리), `FI-025`·`FI-031`·`FI-032`·`FI-052`·`FI-053`(촬영 저장 진실과 대기열 무결성), `FI-164`(좁은 화면·접근성 회귀 게이트).
- rollback: Pages는 `legacy.html` 또는 해당 PR `git revert`(각 PR이 revert 하나로 되돌아간다). GAS·watcher·데이터 rollback은 이 release 범위에 없다.
- **남은 human gate**: founder actual-phone acceptance. 이 release의 machine evidence는 `V0`~`V6` 수준이며, `V7`(실기기·실사용)은 `NOT RUN — HUMAN/EXTERNAL`이다. merge와 Pages 반영을 actual-phone PASS나 customer proof로 승격하지 않는다.

### v2.0.0 @ `c9036b3982adf5fbb5fdf108aca3656dc56b3ffd` — 검증 2026-07-26 (Codex, Kairen-Ref: TSK-000221)

- repository: annotated tag `v2.0.0` → merge commit `c9036b3982adf5fbb5fdf108aca3656dc56b3ffd`; PR #8의 exact head는 `b2343d4afc814bff31d72c6b12618c7e7292bbf7`이고 `main`에 포함됨.
- human gate: founder가 같은 Codex task에서 `좋아 잘 돼는 것 확인했어`라고 실사용 상태를 확인한 뒤 `병합, 릴리즈, 배포까지 알아서 잘 해봐`로 PR merge·release tag·Pages·기존 Apps Script deployment 새 version·watcher 재기동을 승인함. Script Properties·token·credential 변경은 승인/실행 범위에서 제외함.
- CI: GitHub Actions run `30165011262` SUCCESS, exact head `b2343d4…`, 48/48 unit tests·TypeScript/Vite production build·Playwright 6/6·repository validator PASS.
- Pages: build source `main:/docs`, commit `c9036b3…`, status `built`. live와 commit 콘텐츠가 exact-match: `docs/index.html` sha256 `0b491c9253fc2058a88232403667363115e600ff4807f6997734af9bf76cfe16`; `docs/sw.js` `85e9a4de8ea093cf8134a2866c7757214c8c2f6846b60a551e3bd2222c459e7f`; `docs/legacy.html` `d1b370a9ab8ae8c8d51b10a6136487cec57c7cd798a43e45ecf9a8e02dd52ab5`; `docs/next/index.html` `831b1e623a9684dbe781616c7986cf99ca293c5dc44625e5caaa77790bd71e13`; active JS `cd5d33af010d42ffb415be65240f27cac533319afe92761aa32bb8e711c18286`.
- Pages behavior: `https://guecom.github.io/card-capture/`가 query·hash를 보존해 `/next/` React 앱으로 진입했고 `검색` tab과 `사람 검색` 진입점이 노출됨. `legacy.html`은 복구 링크로 유지되고 root/React service worker cache가 격리됨.
- GAS deployment: 기존 deployment ID와 web-app URL을 유지하고 version 5를 2026-07-26 01:18 KST에 `v2.0.0 React/Ionic root promotion (c9036b3 / TSK-000221)` 메모로 배포함. Apps Script editor 전체 Code.gs와 repository Code.gs의 정규화 sha256 `990487a7f09dcc2c0247b2a0e9013ab2dfedbd033560be143fbee7ea19206fb1` 일치.
- GAS live probe: 2026-07-26 01:19 KST `ping` → `ok:true`; invalid token `whoami`·`search`·POST `researchinstruction` → `invalid_token`; unknown action → `unknown_action`. Script Properties·실 token은 읽거나 변경하지 않음.
- watcher: `watcher-v3.0`을 merge commit working tree에서 단일 재기동. PID `38348`, startedAt `2026-07-26 01:20:44 KST`, health exit `0`, consecutive failures `0`, backlog `0`, lock `false`, process alive.
- processing contract: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`의 2026-07-26 현재 계약을 변경 없이 사용함. `MVP build/testability gate comes before customer proof.`
- rollback: Pages는 `legacy.html` 또는 승인된 `git revert`; GAS는 deployment version 4; watcher는 이전 승인 commit의 BOM 보존 스크립트로 되돌린 뒤 같은 health probe를 재실행.

### v1.0 @ `2d4704c1224e9749c3663818ff68fb546d01be8a` — 검증 2026-07-24 (agent:kairen.claude)

- repository: `main` == 로컬 tracking head == `2d4704c…` (worktree clean). release tag 없음(known gap — 사람 승인 시 `v1.0` 태깅 제안).
- Pages: live `index.html` sha256 `e791c405…acae0af3` == HEAD `docs/index.html` sha256 — **일치**.
- GAS live probe (실토큰 미사용, 무효 토큰만): `ping` ok=true · `whoami`/`list`/`persondoc` 무효 토큰 → `invalid_token` · unknown action → `unknown_action` — **전부 기대 동작**. 유효 토큰 scope 실동작(list·persondoc·업로드)은 2026-07-23 밤 폰 왕복에서 사람이 확인한 기록이 vault TSK-000106/107에 있음; current SHA 기준 재확인은 사람 폰 단계로 남음.
- watcher: PID 46464 가동, heartbeat 10분 간격 기록(마지막 2026-07-24 01:02), inbox 5건 status 일치(processed 3·skipped 2), processing.lock 없음.
- processing contract: vault `CardCapture_Processing.md` 2026-07-23 규칙 8/8-1 포함 상태.
- human gate 이력: 저장소 생성·GAS 배포·토큰 발급은 2026-07-23 사람이 수행.
