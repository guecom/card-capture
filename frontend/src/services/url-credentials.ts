// 주소창에서 개인 링크 코드를 즉시 지운다 (FI-005) — Kairen-Ref: TSK-000269
//
// `?k=` 는 개인 링크가 코드를 전달하는 유일한 경로다. 저장이 끝난 뒤에도 주소창에 남으면
// 브라우저 방문 기록, 탭 공유, 스크린샷, 나중에 열릴 외부 링크의 Referer로 계속 새어 나간다.
// 저장 직후 한 번 replaceState로 지우면 기록에 남지 않는다(push가 아니라 replace여야 한다).

export const CREDENTIAL_PARAMS = ['k', 'api'] as const;

/** 자격 파라미터만 제거한 주소. 나머지 파라미터(`view` 등)와 hash는 그대로 둔다. */
export function scrubbedHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  let changed = false;
  for (const param of CREDENTIAL_PARAMS) {
    if (!url.searchParams.has(param)) continue;
    url.searchParams.delete(param);
    changed = true;
  }
  if (!changed) return href;
  // 파라미터가 하나도 남지 않으면 `?`도 남기지 않는다.
  const search = url.searchParams.toString();
  return `${url.origin}${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
}

/** 실제 주소창에 적용한다. 지운 것이 있으면 true. */
export function scrubCredentialParams(): boolean {
  const history = globalThis.history;
  const href = globalThis.location?.href ?? '';
  if (!history?.replaceState || !href) return false;
  const next = scrubbedHref(href);
  if (next === href) return false;
  try {
    history.replaceState(history.state, '', next);
    return true;
  } catch {
    return false;
  }
}
