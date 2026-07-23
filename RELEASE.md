# Release Evidence Contract — Kairen Card Capture

Kairen-Ref: `TSK-000140` (release baseline). 이 문서는 "무엇이 하나의 release 증거인가"와 현재 확인된 baseline을 소유한다. PR merge, Pages build, GAS ping 중 하나만으로는 release를 증명하지 않는다.

## 하나의 Release Evidence가 담아야 하는 것

| 항목 | 확인 방법 |
| --- | --- |
| Repository 상태 | release 대상 commit SHA(가능하면 tag)가 `main`에 포함 |
| Pages 일치 | `https://guecom.github.io/card-capture/index.html` 콘텐츠 해시 == 해당 SHA의 `docs/index.html` 해시 (`sw.js` 동일) |
| GAS 동작 | `ping` ok · 무효 토큰이 `whoami`/`list`/`persondoc`(·`search`)에서 `invalid_token` · unknown action 거부 · (배포 직후) 유효 토큰 1회 실동작은 사람이 폰에서 확인 |
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

## Rollback

- 코드: `git revert` 후 동일 절차(사람 merge). Pages는 main 반영 후 수 분 내 재빌드.
- GAS: 배포 관리에서 이전 version으로 전환(사람). 전환 후 behavior probe 재실행.
- 워처: 이전 commit의 `CardCapture_Watcher.ps1`로 교체 후 재시작(사람; BOM 유지 필수).

## Known Limitations (정직한 경계)

- CI가 아직 없다 — `scripts/validate.ps1`은 로컬 실행 계약이며, GitHub Actions 등재는 후속 제안(사람 승인 대상).
- 처리 agent의 write allowlist는 계약+회귀(eval) 수준이며 OS 수준 강제가 아니다(`SECURITY.md`).
- GAS 배포 version과 Code.gs 상태의 연결은 수동 기록에 의존한다(자동 검증 endpoint 없음 — v1.1 후보에 `version` 응답 포함 검토).

## Verified Baselines

### v1.0 @ `2d4704c1224e9749c3663818ff68fb546d01be8a` — 검증 2026-07-24 (agent:kairen.claude)

- repository: `main` == 로컬 tracking head == `2d4704c…` (worktree clean). release tag 없음(known gap — 사람 승인 시 `v1.0` 태깅 제안).
- Pages: live `index.html` sha256 `e791c405…acae0af3` == HEAD `docs/index.html` sha256 — **일치**.
- GAS live probe (실토큰 미사용, 무효 토큰만): `ping` ok=true · `whoami`/`list`/`persondoc` 무효 토큰 → `invalid_token` · unknown action → `unknown_action` — **전부 기대 동작**. 유효 토큰 scope 실동작(list·persondoc·업로드)은 2026-07-23 밤 폰 왕복에서 사람이 확인한 기록이 vault TSK-000106/107에 있음; current SHA 기준 재확인은 사람 폰 단계로 남음.
- watcher: PID 46464 가동, heartbeat 10분 간격 기록(마지막 2026-07-24 01:02), inbox 5건 status 일치(processed 3·skipped 2), processing.lock 없음.
- processing contract: vault `CardCapture_Processing.md` 2026-07-23 규칙 8/8-1 포함 상태.
- human gate 이력: 저장소 생성·GAS 배포·토큰 발급은 2026-07-23 사람이 수행.
