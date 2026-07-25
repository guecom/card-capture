# Device·Offline Acceptance Matrix

Kairen-Ref: `TSK-000144` / [[ISS-000035]] — release SHA별로 이 matrix를 채워 core journey acceptance를 닫는다.

MVP build/testability gate comes before customer proof.

## 지원 경계

| 등급 | 대상 | 기준 |
| --- | --- | --- |
| 지원 | Android Chrome(최신 2개 메이저), iOS Safari(iOS 16+) | 전 journey 통과 |
| 제한 지원 | iOS Chrome/카카오·인앱 브라우저 | 촬영은 네이티브 폴백 허용, 브리핑 조회 필수 |
| 미지원 | 데스크톱(카메라 journey) | 조회·검색만 — 촬영은 폰 전용 |

## Matrix (release마다 1열 추가)

체크 표기: ✓ 통과 / ✗ 실패 / － 해당 없음 / ⏳ 사람 확인 대기

### v1.0 @ 2d4704c — 검증 2026-07-24

| # | Journey step | 자동(desktop·모바일 뷰포트) | Android Chrome | iOS Safari |
| --- | --- | --- | --- | --- |
| 1 | 페이지 로드·콘솔 에러 0 | ✓ (에러 0) | ⏳ | ⏳ |
| 2 | 토큰 없음 → 설정 안내 표시 | ✓ ("링크 설정이 필요해요") | ⏳ | ⏳ |
| 3 | SW 등록·앱 셸 캐시 | ✓ (reg 1, cache v10) | ⏳ | ⏳ |
| 4 | 캡처 UI(앞면 버튼·전송 비활성 초기값·4필드) | ✓ | ⏳ | ⏳ |
| 5 | 카메라 권한 허용·사각형 인식·크롭 | － (카메라 없음) | ⏳(2026-07-23 v1.0 실사용 통과 이력) | ⏳ |
| 6 | 카메라 거부 → 네이티브 폴백 | － | ⏳ | ⏳ |
| 7 | 앞면 후 뒷면 버튼 항상 보임 | ✗ **(toast bottom:28px — ISS-000049 실재 확인, v1.1 수정)** | ✗ (사용자 보고) | ⏳ |
| 8 | 오프라인 촬영→큐→재접속 전송 | ⏳ | ⏳ | ⏳ |
| 9 | 재전송(같은 captureId 교체) | － | ⏳(v0.4 이력) | ⏳ |
| 10 | GAS 도달·무효 토큰 거부(CORS 포함) | ✓ (live origin fetch: invalid_token) | ⏳ | ⏳ |
| 11 | 브리핑 목록·펼침 유지 | UI 존재 ✓ | ⏳(v1.0 실사용 이력) | ⏳ |
| 12 | owner 전용 Person 전문 조회 | － (실토큰 미사용 원칙) | ⏳ | ⏳ |
| 13 | 처리 대기 중 상태 표시 | v1.0은 "처리 대기 중"만(v1.1에서 경과·경고) | ⏳ | ⏳ |

자동 열 evidence: 2026-07-24 브라우저 자동 점검(모바일 뷰포트 375x812, live https://guecom.github.io/card-capture/, sha256 == 2d4704c artifact).

### v1.1 후보 (merge·재배포 후 채움)

추가 확인 행: 검색→프렙 카드→연락 버튼(전화·문자·메일·vCard) / 메모 추가 왕복 / 예전 브리핑 더 보기 / 다시 처리 요청 / 토스트 상단(#7 재검) / 진행 표시(경과·경고) / 홈화면 shortcuts / sw v12 갱신.

### Capture experience 후보 (`agent/card-capture-interview-wave`)

Kairen-Ref: `TSK-000178`, `TSK-000217`~`TSK-000220` / `TST-000014`~`TST-000018`

| # | Acceptance | 자동 검증 | Android Chrome | iOS Safari |
| --- | --- | --- | --- | --- |
| C1 | 한국어·영어 자체 호스팅 OCR 기동, 제3자 이미지 전송 없음 | ✓ 브라우저 smoke PASS, 합성 텍스트 522ms | ⏳ 실명함 P50/P95 측정 | ⏳ 실명함 P50/P95 측정 |
| C2 | 이름 후보가 회사명·직함·연락처를 이름으로 만들지 않음 | ✓ 결정적 3-case PASS | ⏳ 익명화 fixture 20장 | ⏳ 익명화 fixture 20장 |
| C3 | 안정된 명함만 2초 이내 자동 촬영 | ✓ 결정적 gate PASS | ⏳ 실물 30회 | ⏳ 실물 30회 |
| C4 | 움직임·흐림·심한 과노출·비명함에서 자동 촬영하지 않음 | ✓ 결정적 negative PASS | ⏳ 조건별 10회 | ⏳ 조건별 10회 |
| C5 | 흰 배경·저대비에서 적응형 임계값 폴백이 사각형을 찾음 | 코드 경로·문법 PASS, 실카메라 해당 없음 | ⏳ 흰 명함/흰 배경 10회 | ⏳ 흰 명함/흰 배경 10회 |
| C6 | 자동 촬영 끄기·수동 셔터·기본 카메라 폴백·재촬영 | DOM·문법 PASS | ⏳ journey 전부 | ⏳ journey 전부 |
| C7 | 390×844 핵심 화면에 가로 overflow·콘솔 오류·Blocker/Major visual defect 없음 | ✓ overflow 0, console error 0 | ⏳ 실제 기기 시각 승인 | ⏳ 실제 기기 시각 승인 |

### Research instruction 후보 (`DEC-000035`, `TSK-000218`)

| # | Acceptance | 자동 검증 | Owner phone | Guest phone |
| --- | --- | --- | --- | --- |
| R1 | 최초 등록에 메모와 분리된 조사 지시 tab, guest에는 미노출 | ✓ 390×844 smoke·DOM·capability gate | ⏳ | ⏳ |
| R2 | 기존 Person 카드의 조사 지시 action·modal·2,000자 입력 | ✓ synthetic Person card smoke, overflow 0 | ⏳ | － |
| R3 | owner success, guest direct API `owner_only`, feature off `feature_disabled` | ✓ GAS mock path PASS | ⏳ live receipt | ⏳ direct rejection |
| R4 | capture/Person target mismatch가 Person write 전 `target_mismatch` | ✓ GAS mock path PASS | ⏳ | － |
| R5 | raw·requester·target·server time·receipt·fixed policy가 note와 별도 보존 | ✓ initial/existing GAS mock PASS | ⏳ Drive receipt 확인 | － |
| R6 | prompt injection·private·credential·sensitive·doxxing·external·paid 요구가 경계를 바꾸지 않고 source·confidence·unknown receipt를 남김 | ✓ 9 fixture policy PASS | ⏳ bounded processing receipt | － |

R1~R6의 phone·Drive·processing 열이 통과하기 전에는 [[TST-000015]]을 live PASS나 release-ready로 닫지 않는다. Script Property 변경과 GAS deployment는 사람 gate다.

자동 검증은 합성·로컬 evidence다. C1~C7의 사람 열이 모두 ✓가 되기 전에는 실제 기기 acceptance PASS나 release-ready로 판정하지 않는다.

## Evidence 기록 형식

- 사람 확인: 이 파일의 해당 칸을 ✓/✗로 바꾸고 커밋(또는 vault Task work log에 기기·OS·일시 기록).
- 실패는 재현 단계와 함께 GitHub Issue로 — `Kairen-Ref: TSK-000144`.
- 실토큰이 필요한 행(12 등)은 폰에서만 확인하고 자동 점검에서는 무효 토큰 거부까지만 검증한다.
