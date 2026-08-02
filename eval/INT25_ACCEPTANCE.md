# INT-000025 Acceptance Matrix

Kairen-Ref: `TSK-000496`, `INT-000025`. `ISS-000218`은 사용자 지시에 따라 범위에서 제외한다.

MVP build/testability gate comes before customer proof.

| Acceptance | 범위 | 기계 검증 | 운영·실기기 판정 |
| --- | --- | --- | --- |
| `APP-AC-234` | 여섯 가지 일 중심 설정 IA, 개인정보·지원·버전, OS reduced-motion 우선 | PASS — unit/build/Playwright | 실제 Android 가독성 확인 필요 |
| `APP-AC-235` | 닫힌 앱 알림: final / human input / recovery만, 민감 본문 금지 | PASS — frontend/GAS/watcher/outbox/service-worker 합성 gate | VAPID·private registry·sender provisioning과 실제 Android 닫힌 앱 수신·열기·해제 증거 필요 |
| `APP-AC-236` | 자동·수동 refresh 단일 비행, trailing refresh, offline/error/last-update | PASS — Playwright 동시성·상태 회귀 | 실제 Android foreground/background 전환 확인 필요 |
| `APP-AC-237` | 서버가 증명한 진행 단계와 경과만 표시, fake percent/ETA 제거, recovery action | PASS — unit + Playwright | 운영 watcher 상태 왕복 확인 필요 |
| `APP-AC-238` | 추천 8개 독립 선택, 전체 선택 none/partial/all, 자유 입력 보존 | PASS — unit + Playwright | 실제 터치 사용성 확인 필요 |
| `APP-AC-239` | 목적 제한 Deep Evidence Graph(nodes/edges/sourceId), 성공·실패 실측 12분·누적 90분 process-tree hard stop, 순차 checkpoint, 전체 capture 폴더 rollback, durable request recovery, 일반 작업 우선 | PASS — frontend/GAS/watcher 합성 gate | GAS 재배포·watcher 재기동 후 owner 요청 1건 검증 필요 |
| `APP-AC-240` | 레거시 진입점·캐시·라우트 완전 제거 | PASS — 파일·서비스 워커·번들 회귀 gate | Pages 배포 후 레거시 URL 404 확인 필요 |

`APP-AC-235`의 machine PASS는 표준 Web Push 전송기와 private 구독 registry가 구현됐다는 뜻이다. 기능은 운영 provisioning 전 기본 off이고, 실제 Android에서 권한 opt-in → 닫힌 앱 수신 → 알림 열기 → 해제를 확인하기 전 live PASS가 아니다.

`PASS`는 명시한 machine gate의 판정이다. PR merge, Pages 배포, 합성 PASS를 실제 폰 PASS, GAS live PASS, MVP gate PASS, customer proof로 해석하지 않는다.
