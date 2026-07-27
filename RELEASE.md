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

1. branch → draft PR → `scripts/validate.ps1` PASS → 사람 review·merge (human gate).
2. 사람: release tag `vX.Y` 생성 (human gate).
3. `Code.gs` 변경이 있으면 사람: GAS 재배포 — vault `CardCapture_Setup.md`의 클릭 단위 절차 (human gate).
4. 검증: 위 표의 각 항목 확인(Pages 해시 비교, GAS probe는 무효 토큰 거부까지 스크립트로, 유효 토큰 실동작은 폰에서).
5. 이 파일에 baseline 기록 + vault Task에 exact SHA·결과 회수.

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
