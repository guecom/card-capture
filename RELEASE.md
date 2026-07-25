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
