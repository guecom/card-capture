# 서체 (founder 판정 2026-07-28)

## 왜 이 파일이 있나

`app.css`는 `--ion-font-family`에 `Inter, Pretendard`를 적어 두고 **한 번도 싣지 않았다.** 그래서 모든 기기가 OS 기본 서체로 떨어졌고, 스타일시트가 요구하는 numeric weight 15종(550~800)이 대부분 렌더되지 않았다. Windows Chrome 실측: `font-weight: 650`과 `780`의 글자 폭이 **완전히 동일**(둘 다 bold로 스냅). 위계를 위해 쓴 값이 화면에서는 두 단계로 뭉개진 것이다.

## 무엇을 넣었나

`pretendard-variable-korean.woff2` — Pretendard Variable v1.3.9의 부분집합.

| 항목 | 값 |
| --- | --- |
| 원본 | `PretendardVariable.woff2` 2,057,688 B (sha256 `9599f12f…`) |
| 부분집합 | 1,759,564 B (sha256 `58f28b65…`) |
| 가변 축 | `wght` 45–930 (**그대로 둠**) |
| 남긴 문자 | 라틴/라틴-1, 일반 문장부호, 한글 자모·호환자모·확장, **한글 음절 전체(U+AC00–D7A3, 11,172자)**, CJK 문장부호, 전각 |
| 덜어낸 문자 | 한자(U+4E00–9FFF), CJK 확장, 미사용 기호류 |
| 라이선스 | SIL Open Font License 1.1 (`OFL.txt`) — 상용 이용·임베딩·부분집합 모두 허용 |

## 왜 이 크기인가

용량의 대부분은 한글 음절 11,172자의 윤곽선이다. 실측으로 확인한 것:

- 축을 300–800으로 좁혀도 1,692,296 B (−4%)
- layout feature를 필수만 남겨도 1,739,464 B (−1%)
- 라틴만 남기면 55,344 B — 하지만 **본문 대부분이 한글**이라 한글은 시스템 서체로 떨어지고, 한 화면에 두 서체가 섞여 오히려 나빠진다

즉 "한글을 제대로 그린다"의 값은 ~1.7 MB이고 그 아래로 깎을 방법이 없다. 흔한 음절만 넣는 방법(KS X 1001 2,350자)은 **사람 이름**에서 깨진다 — 이 앱의 핵심 콘텐츠라 받아들일 수 없다. 실제로 `뷁`·`쫑`·`빾` 같은 희귀 음절까지 포함되는지 확인했다.

## 가변 축을 왜 안 좁혔나

지금 CSS가 쓰는 최대 weight는 800이라 45–930은 과하다. 그래도 그대로 둔 이유는, 축을 좁히면 나중에 다른 작업자가 `font-weight: 900`을 썼을 때 **조용히 800으로 잘리기** 때문이다. 병렬로 여러 세션이 이 저장소를 고치고 있어 그런 함정을 남기지 않는다. 대가는 90 KB다.

## 서비스 워커 SHELL에서 제외한 이유

`vite.config.ts`가 SHELL 목록을 만들 때 `.woff2`를 제외한다. `cache.addAll(SHELL)`은 **원자적**이라 하나라도 실패하면 설치 전체가 실패하고 오프라인 껍데기가 통째로 안 만들어진다. 전시장 회선에서 1.7 MB 하나 때문에 그 위험을 지는 대신, `font-display: swap`으로 필요할 때 받아 오고 브라우저 HTTP 캐시에 맡긴다. 오프라인이고 아직 못 받았으면 지금까지처럼 시스템 서체로 그려진다 — 기능은 하나도 안 잃는다.

## 갱신 절차

`scripts/validate.ps1`의 pinned asset 해시에 이 파일이 들어 있다. 바꾸려면 부분집합을 다시 만들고 해시도 같이 갱신해야 한다. 재현 명령(fonttools 필요):

```
python -m fontTools.subset PretendardVariable.woff2 \
  --output-file=pretendard-variable-korean.woff2 --flavor=woff2 \
  --layout-features='*' --name-IDs='*' --notdef-outline \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20A9,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+25A0-25CF,U+FEFF,U+FFFD,U+1100-11FF,U+3000-303F,U+3130-318F,U+A960-A97F,U+AC00-D7A3,U+D7B0-D7FF,U+FF01-FF60,U+FFE0-FFE6'
```
