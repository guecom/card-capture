# Agent Contract — guecom/card-capture

이 저장소는 Kairen Card Capture(internal operations product)의 코드 원본이다. Kairen vault의 계약 문서가 제품 의미를 소유하고, 이 저장소는 구현을 소유한다.

- Product contract: vault `03_Product/Kairen_Card_Capture_Product_Docs/README.md`
- Processing behavior: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`
- Deployment/runbook: vault `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Setup.md`
- Release evidence: 이 저장소 `RELEASE.md`

## Working Rules (all agents)

1. **Branch + draft PR로만 작업한다.** `main` 직접 push, self-merge, release tag 생성은 하지 않는다. merge·release·GAS deployment는 사람 승인 단계다.
2. 모든 커밋/PR에 Kairen Task 참조를 남긴다: `Kairen-Ref: TSK-XXXXXX`.
3. **secret 금지.** 토큰 값, `TOKENS` JSON, Drive folder ID, 실캡처 데이터(이미지·capture.json·brief), Person 개인정보를 이 저장소에 넣지 않는다. `docs/index.html`의 `DEFAULT_API`(GAS exec URL)만 예외로 허용된 공개값이다.
4. PR 전에 `scripts/validate.ps1`을 실행하고 PASS를 확인한다(secret scan, 필수 파일, .ps1 BOM, eval fixture 검사 포함).
5. **.ps1 인코딩:** 한글 경로를 다루는 PowerShell 파일은 반드시 UTF-8 **BOM** 으로 저장한다. BOM이 없으면 Windows PowerShell 5.1이 CP949로 읽어 `내 드라이브` 경로가 깨지고 워처가 시작 직후 죽는다(2026-07-23 실장애 원인). 편집 도구가 BOM을 지우면 저장 후 재적용한다.
6. PowerShell은 5.1 호환으로 작성한다(`&&`/`||`, 삼항, `??` 금지).
7. `docs/`는 GitHub Pages(main:/docs)로 서비스된다. `docs/` 변경 = 사용자 표면 변경이므로 CHANGELOG의 Unreleased에 사용자 관점 한 줄을 추가한다.
8. `Code.gs` 변경은 live GAS에 자동 반영되지 않는다. 배포는 사람이 vault `CardCapture_Setup.md` 절차로 수행하고, 배포 후 `RELEASE.md` 계약대로 behavior를 재검증한다.
9. eval fixture는 **합성 데이터만** 허용한다. 실명함 유래 fixture는 익명화 사람 승인 후에만 추가한다(`eval/README.md`).
10. 처리 파이프라인(워처·Codex 세션)의 쓰기 허용 경로는 vault `CardCapture_Processing.md`의 allowlist가 계약이다. 워처 프롬프트와 eval의 adversarial fixture가 이를 강제한다.

## Human Gates

에이전트가 최종 상태로 만들지 않는 것: PR merge, release tag, GAS deployment, 토큰 발급·회수·rotation, Script Properties 변경, 실데이터 삭제, 알림 채널 enablement.
