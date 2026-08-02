# card-capture

명함 캡처 → Kairen Person 파이프라인의 캡처 프런트엔드와 업로드 엔드포인트.

Kairen vault의 [PRJ-000005 명함 캡처 Person 파이프라인 구축]이 이 저장소의 거버넌스 원본이다. 배포 절차는 vault의 `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Setup.md`를 따른다.

## 구성

| 경로 | 역할 | 배포 위치 |
| --- | --- | --- |
| `Code.gs` | 업로드 API (토큰 검증, Drive 저장) | Google Apps Script 웹 앱 |
| `docs/` | 모바일 캡처 PWA, 기기 내 OCR·조사 지시 policy helper | GitHub Pages (이 저장소) |
| `frontend/` | React·TypeScript·Vite + Ionic React 운영 frontend (`TSK-000221`) | build output은 `docs/next/`; root는 query를 보존해 이 앱으로 이동 |
| `watcher/push/` | 표준 Web Push(VAPID) 전송 helper와 pinned runtime | 로컬 watcher가 stdin으로만 호출 |
| `PROCESSING_CONTRACT.md` | owner 조사 지시의 bounded public-source 처리·receipt 계약 | 로컬 processing 계약의 저장소 mirror |

## 동작 요약

폰 브라우저(개인 토큰 링크) → root entrypoint가 token query를 보존해 React 앱을 열고 사진을 IndexedDB 대기열에 저장 → GAS `Code.gs`로 업로드 → Drive `00_Inbox/BusinessCards/<captureId>/`에 front.jpg/back.jpg/capture.json 저장 → 데스크톱 vault 동기화 → 구독 세션에서 Person Instance 처리(G1).

- 공개 GAS 배포 URL은 `config/public-runtime.json` 한 곳이 소유하며 React build가 같은 값을 주입한다.
- 토큰과 폴더 ID는 코드가 아니라 GAS Script Properties에만 둔다. 이 저장소에는 비밀이 없다.
- 닫힌 앱 알림은 별도 유료 provider가 아닌 표준 Web Push를 쓴다. 구독은 token에서 유도한 opaque subject별 private Drive registry에 저장하고, VAPID private key와 watcher sender token은 이 PC의 DPAPI로 보호한다. 기능은 기본 off이며 실제 Android 검증 전까지 machine PASS와 live PASS를 구분한다.
- Push API는 bearer를 URL에 남기지 않는 POST-only `pushconfig`·`pushstatus`·`pushsubscribe`·`pushunsubscribe`와 watcher 전용 `pushsubscriptions`·`pushretire`로 나뉜다. 브라우저 route와 sender route는 서로의 credential을 받지 않는다.
- owner는 최초 등록과 기존 Person 카드의 `조사 지시` 탭에서 별도 요청을 남길 수 있다. 요청 원문은 system prompt가 아니라 provenance 데이터로 저장되며, 공개·합법 출처와 기존 write authority 안에서만 처리한다.
