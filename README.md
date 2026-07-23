# card-capture

명함 캡처 → Kairen Person 파이프라인의 캡처 프런트엔드와 업로드 엔드포인트.

Kairen vault의 [PRJ-000005 명함 캡처 Person 파이프라인 구축]이 이 저장소의 거버넌스 원본이다. 배포 절차는 vault의 `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Setup.md`를 따른다.

## 구성

| 경로 | 역할 | 배포 위치 |
| --- | --- | --- |
| `Code.gs` | 업로드 API (토큰 검증, Drive 저장) | Google Apps Script 웹 앱 |
| `docs/` | 모바일 캡처 PWA (정적 파일 5개) | GitHub Pages (이 저장소) |

## 동작 요약

폰 브라우저(개인 토큰 링크) → `docs/index.html`이 사진 리사이즈 후 IndexedDB 대기열에 저장 → GAS `Code.gs`로 업로드 → Drive `00_Inbox/BusinessCards/<captureId>/`에 front.jpg/back.jpg/capture.json 저장 → 데스크톱 vault 동기화 → 구독 세션에서 Person Instance 처리(G1).

- `docs/index.html`의 `DEFAULT_API`에 GAS 배포 URL을 넣은 뒤 Pages에 올린다.
- 토큰과 폴더 ID는 코드가 아니라 GAS Script Properties에만 둔다. 이 저장소에는 비밀이 없다.
