# Security — Kairen Card Capture

Kairen Ref: `TSK-000141` (credential·access baseline), `TSK-000153` (processing containment)

## Trust Model

| 주체 | 자격 | 볼 수 있는 것 | 할 수 있는 것 |
| --- | --- | --- | --- |
| Owner (OWNER_NAMES) | 개인 bearer token | 모든 캡처 브리핑, Person `.md` 전문(Private 포함) | 업로드, 전체 조회, 별도 조사 지시 |
| Invited capturer | 개인 bearer token | 자신의 캡처·브리핑만 | 업로드, 자기 scope 조회 |
| 익명 | 없음 | `ping` 상태만 | 없음 (`invalid_token`) |
| Processing agent | 로컬 인증 세션(Codex/Claude) | vault | vault 내 allowlist 경로 쓰기 (`CardCapture_Processing.md`) |

- token은 **bearer credential**이다. URL 파라미터로 전달되고 폰 브라우저 localStorage에 저장된다 — 링크를 아는 사람이 곧 그 사용자다.
- GAS 웹앱은 소유자 계정 권한으로 실행된다("실행: 나, 액세스: 모든 사용자"). 코드가 곧 권한 경계다.
- **credential은 빌드에 박힌 배포본 주소로만 나간다** (`frontend/src/services/api-origin.ts`). 신뢰 기준은 origin이 아니라 **origin + pathname**이다 — `config/public-runtime.json`의 `apiUrl`이 가리키는 배포본 주소 그 자체와 앱 자신의 origin뿐이며, URL·localStorage·캐시·서버 응답 어느 것도 이 집합을 넓히지 못한다. 로컬 harness(`localhost`/`127.0.0.1`에서 서비스될 때)에 한해 RFC 6761 `.test`·RFC 8375 `.localhost` 이름을 mock API로 허용한다.
  - **origin만 비교하면 부족했다.** `script.google.com`은 누구나 자기 Apps Script 웹앱을 배포할 수 있는 multi-tenant 호스트다. origin만 맞추면 `?api=https://script.google.com/macros/s/<공격자 배포 ID>/exec`가 통과해 저장된 링크 코드가 그대로 공격자 배포본으로 나갔다(`ISS-000109`).
  - 채택하는 주소에서는 **query와 fragment를 버린다.** 저장되는 주소에 자격 정보가 섞일 자리를 없앤다. `연결 해제`는 저장된 연결 주소까지 지운다.
- **이전 독립 앱은 더 이상 배포하지 않는다.** 루트 서비스 워커 v21이 기존 `cardcapture-v20` 캐시를 활성화 시 삭제하고, 현재 앱만 `config/public-runtime.json`에서 고정 endpoint를 받는다(`ISS-000110`).
- **사적 브라우저 상태는 subject(= API origin + token) 별로 격리된다.** 기준은 **목록이 아니라 원칙**이다 — **그 사람이 직접 적었거나 그 사람에게만 보이는 값은 모두 사적 상태다.** 브리핑 캐시·owner 게이트·검색 기록과 **만남 맥락(만난 상황·관계 메모·조사 지시 초안과 그 유지 시각)**이 여기 해당한다. owner 링크로 쓰던 기기를 guest 링크로 열면 이전 subject의 것이 보이지 않고, 그 namespace는 기기에서 제거된다. 촬영 대기열(IndexedDB)은 유일본이라 이 정리 대상이 아니다 — **유일한 예외다.**
  - 이 항목이 닫힌 열거로 쓰여 있던 것이 `ISS-000112`의 원인이다. 만남 맥락이 목록에 없어 격리되지 않았고, 그것은 화면 노출로 끝나지 않았다 — sticky 값이 다음 촬영에 붙어 **owner의 관계 메모가 guest의 캡처로 서버에 기록**됐다.
  - **namespace 없는 전역 자리에 남아 있던 사적 상태는 어느 subject로도 이관하지 않고 버린다.** 누가 적었는지 증거가 없기 때문이다. 브리핑은 다음 조회에서, owner 게이트는 서버 응답에서 다시 얻는다.

## Threat Model (현재 완화 상태)

| 위협 | 경로 | 완화 | 상태 |
| --- | --- | --- | --- |
| 토큰 유출 | 공유 링크 전달·스크린샷·브라우저 이력 | 개인별 토큰 분리, 회수/rotation 절차, DAILY_LIMIT | 절차 문서화됨, rotation은 human gate |
| 토큰 탈취 (악성 API 주소) | `?api=https://attacker.example/`가 붙은 링크를 한 번 열면 그 주소가 저장되고 이후 모든 업로드·조회가 그리로 감. **같은 호스트의 다른 Apps Script 배포본**도 같은 경로다 | build-time **endpoint**(origin + pathname) pinning + fail-closed 판정, 채택 주소에서 query·fragment 폐기, 거부한 주소는 저장하지 않음, 저장돼 있던 신뢰 밖 주소도 boot에서 폐기, 고급 설정 입력도 동일 판정 | 구현됨, `credential-boundary.spec.ts`가 빌드에 박힌 endpoint 밖 요청 0건을 검증 |
| 토큰 잔류 (주소창·이력·Referer) | 개인 링크의 `?k=`가 주소창·방문 기록·화면 공유·외부 링크 Referer에 남음 | 저장 직후 `history.replaceState`로 `k`·`api` 제거(push 아님), `<meta name="referrer" content="no-referrer">` | 구현됨, 현재 root·React 앱 e2e 회귀. 폐기된 앱과 캐시도 다시 노출되지 않음을 별도 retirement gate가 검증한다 |
| 기기 내 subject 교차 노출 | 한 폰을 owner 링크 → guest 링크로 열 때 이전 사람의 캐시가 그대로 렌더 | 사적 키를 subject namespace로 분리, 링크 코드 없으면 사적 캐시를 읽지도 쓰지도 않음, 다른 subject namespace는 boot에서 제거 | 구현됨, e2e 회귀(서버 침묵 상태에서 이전 기록 0건) |
| 기기 양도·링크 회수 후 잔류 | 폰을 넘기거나 토큰을 회수해도 기기에 브리핑 사본이 남음 | 설정의 `연결 해제`가 토큰·이름·사적 캐시·만남 맥락을 제거(대기 중 촬영은 보존하고 건수를 먼저 경고) | 구현됨, e2e 회귀 |
| Owner 토큰 유출 | 위와 동일 | persondoc·search는 OWNER_NAMES 한정, Private 포함이므로 owner 토큰은 고민감 취급 | 경계 구현됨 |
| Prompt injection | 명함 인쇄 문구·note·웹 검색 결과 → 처리 agent | 처리 계약의 untrusted-input 규칙 + write allowlist + `eval/` adversarial fixture | 계약·fixture 존재, 회귀로 검증 |
| 조사 지시 권한 상승 | guest가 숨겨진 UI/API를 직접 호출 | UI capability + `researchInstruction_` server-side OWNER_NAMES 재검증 | owner-only, negative fixture |
| 조사 지시 prompt injection | owner raw instruction이 system·schema·write gate를 덮어씀 | 별도 field·receipt, fixed policy snapshot, raw/system prompt 분리, bounded-plan fixture | fail-closed 계약·회귀 구현 |
| 사생활·외부 effect | private login·credential·민감 특성·doxxing·send/write·paid API 요청 | public-lawful-only plan, external effect false, source·confidence·unknown receipt | 금지 계약·adversarial fixture |
| 경계 밖 write | 처리 agent의 vault 전체 쓰기 권한 | allowlist 계약 + 워처 프롬프트 강제 + eval 회귀 | 계약 수준(OS 강제는 없음 — RELEASE.md known limitation) |
| Path traversal | captureId·파일명 | `sanitizeId_`(`[A-Za-z0-9_-]{4,64}`), 업로드 파일명은 서버 소유 슬롯 allowlist | 구현됨 |
| **산출물 슬롯 탈취** | 업로드 파일 이름을 `brief.md`·`brief-zzz.md`·`capture.json`으로 지정 → `listCaptures_`가 `brief*.md` 최신본을 `item.brief`로 내려주므로 **유효 토큰 보유자(초대 게스트 포함)가 owner의 브리핑 목록에 임의 텍스트를 시스템 생성 브리핑으로 띄움**. 처리 완료 후 올리면 최신본 우선 규칙 때문에 진짜 브리핑을 영구 대체 | 이미지 슬롯을 `front.jpg`·`back.jpg` 두 개로 고정하고 **서버가 이름을 소유**한다(`captureSlotName_`). 그 밖의 이름은 `bad_image_name`으로 거절하고 폴더·파일을 만들지 않는다. 같은 슬롯 중복은 `duplicate_image_slot`으로 거절 | 구현됨(`TSK-000279`), eval 회귀(`upload-filename-allowlist.test.js` + `adversarial-capture.test.js`). **재배포 전까지 live에는 미적용** |
| 부분 커밋 | 여러 장 중 하나가 실패하면 앞쪽만 저장돼 처리 가능한 반쪽 캡처가 남음 | 업로드 전체 검증을 Drive 접근보다 앞으로 이동 — 하나라도 틀리면 폴더 생성도 파일 쓰기도 없음 | 구현됨, eval 회귀 |
| 대용량/오염 업로드 | images | 4장 제한, 8MB/장, base64 검증, DAILY_LIMIT(기본 100/일) | 구현됨 |
| Pages 공급망 | 외부 CDN 스크립트 | OpenCV.js self-hosted(`docs/vendor/`), 외부 CDN 미사용 | 구현됨 |
| 재전송 위·변조 | 같은 captureId 재업로드 | 토큰 소유자만 자기 captureId 폴더 갱신, 최신 파일 우선 규칙 | 구현됨 |
| 남의 captureId 덮어쓰기 | 다른 사람의 captureId를 알아내 그 폴더에 업로드 | 업로드 시 기존 `capture.json`의 `capturer`를 확인하고 불일치면 `capture_conflict`로 거절(owner는 예외). 거절 시 파일·메타 무변경 | 구현됨, eval 회귀(`upload-idempotency.test.js`) |
| 처리 상태 되돌림 | 같은 촬영을 다시 올리면 `capture.json`이 `status:'received'`로 덮어써져 이미 `processed`인 캡처가 처음부터 재처리 | 업로드 내용 지문(`uploadFingerprint`)으로 같은 업로드를 멱등 처리해 아무것도 쓰지 않음. 지문 이전 캡처는 `capturedAt`·`event`·`note`·파일 목록으로 판정. 내용이 실제로 달라진 재업로드만 받아들이며 `requeueRequested`·`previousStatus`·`previousProcessedAt`·`previousPerson`으로 명시적 감사 흔적을 남김 | 구현됨, eval 회귀 |

## Token Lifecycle Runbook

canonical 저장소는 GAS Script Properties `TOKENS`(JSON `{token: name}`)이며, 실제 값은 이 저장소에 절대 넣지 않는다. 절차 실행은 사람(또는 승인된 세션)이 GAS 편집기에서 수행한다.

1. **발급(초대)**: 64자 랜덤 토큰 생성 → `TOKENS`에 `"토큰":"이름"` 추가 → 저장 → `?action=whoami&k=…`로 이름 확인 → 개인 채널로 링크 전달. 이름 중복 금지(브리핑 scope가 이름 기준).
2. **이름 변경**: `TOKENS` 값 수정. `OWNER_NAMES`에 있던 이름이면 함께 수정.
3. **Owner 승격/강등**: `OWNER_NAMES`(쉼표 구분)에 이름 추가/제거. 승격 전에 그 사람이 Private 포함 Person 전문을 보게 됨을 확인한다(scope preview).
4. **회수**: `TOKENS`에서 해당 항목 삭제 → 저장 → 삭제된 토큰으로 `whoami`가 `invalid_token`인지 확인.
5. **긴급 전체 회수**: `TOKENS`를 `{}`로 교체(모든 접근 즉시 차단) → 새 토큰 재발급.
6. **Rotation**: (a) 새 토큰들 생성·추가 → (b) replacement 링크를 각 사용자에게 전달·수신 확인 → (c) 구 토큰 삭제 → (d) 구 토큰 `invalid_token`·신 토큰 `whoami` 정상·폰 실동작 확인. **(c)는 기존 링크를 무효화하는 external effect이므로 사람 승인 후 실행한다.**
7. **감사(audit)**: GAS 편집기 → 실행(Executions) 로그에서 `doGet`/`doPost` 호출 이력·오류를 확인한다. Script Properties 변경 시 변경 일시·사유를 vault `CardCapture_Setup.md`의 변경 이력 표에 기록한다(값은 기록하지 않는다).
8. **조사 지시 rollback**: 긴급 시 `RESEARCH_INSTRUCTION_ENABLED=false`로 접수 UI/API를 닫는다. 기존 raw receipt는 삭제하지 않고 실행만 중단한다. 재활성화는 원인과 검증 결과를 확인한 뒤 사람이 수행한다.

## Secret Hygiene

- 금지: 토큰 값, `TOKENS` JSON, `INBOX_FOLDER_ID` 등 Drive folder ID, 실캡처 이미지·capture.json·brief, Person 개인정보.
- 허용: `config/public-runtime.json`의 `apiUrl` exec URL(제품 동작상 공개), 합성 fixture. `scripts/validate.ps1`은 이 파일 한 곳만 예외로 검사한다.
- `scripts/validate.ps1`이 위 패턴을 스캔하며 PR 전 필수 실행이다.

## Reporting

취약점 발견 시 public issue 대신 저장소 소유자에게 직접 알린다. 실캡처·토큰이 포함된 로그는 공유 전에 마스킹한다.
