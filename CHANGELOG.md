# Changelog — Kairen Card Capture

사용자에게 보이는 변화 중심으로 기록한다. 형식: 버전 — 날짜 — 커밋. 배포(GAS/Pages) 시점은 `RELEASE.md`의 release evidence가 진실이다.

## [Unreleased] — v1.1 후보 (branch `agent/product-baseline-v1`, Kairen-Ref: TSK-000140·141·142·143·148·153·154·155)

추가 (배포 전 — GAS 재배포·사람 승인 필요):
- **검색**: owner 토큰 한정 Person 검색(`action=search`) + 웹앱 "검색" 탭 — 이름·회사로 축적된 인맥을 폰에서 회상.
- **처리 완료 알림**: 워처가 처리 완료 시 GAS(`action=notify`)를 통해 소유자 메일로 알림(0원, 옵트인 설정 파일).
- **수정 요청**: 브리핑에서 "수정 요청" 전송(`action=correction`) → 다음 처리 때 사용자 정정으로 반영.
- **워처 v2**: health 파일(`watcher-health.json`)·상태 점검 스크립트·연속 실패 추적·백로그 나이 노출 + 처리 프롬프트에 쓰기 allowlist·untrusted 입력 방어 삽입.
- **저장소 거버넌스**: AGENTS.md, SECURITY.md(위협 모델·토큰 runbook), RELEASE.md(release evidence 계약), CHANGELOG.md, `scripts/validate.ps1`(secret scan 포함), `eval/`(합성 회귀 fixture 14종 + 채점기).

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
