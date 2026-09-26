// Navigation policy for web targets (architecture §5 위험 정책): `open` goes only where the profile's origins allow.
// Deterministic; checked before dispatch. The profile origins are the authorization, so `allowRisky` does not lift it.

/**
 * Why `open: url` must not be dispatched on a web target, or null when it may. Accepted: an absolute http(s) URL
 * without credentials whose origin is in `origins`, or a path starting with `/` — resolved against `origins[0]` exactly
 * like `new URL(url, origins[0])`, and the resolved origin is checked too (`//host` and `/\host` leave the origin).
 */
export function navigationProblem(url: string, origins: readonly string[]): string | null {
  const first = origins[0];
  if (first === undefined) return '허용 origin이 없음';
  if (!url.startsWith('/') && !/^https?:\/\//i.test(url)) return `절대 http(s) URL이나 /로 시작하는 경로만 열 수 있음: ${url}`;
  let target: URL;
  try {
    target = new URL(url, first);
  } catch {
    return `URL 형식 오류: ${url}`;
  }
  if (target.username || target.password) return `URL에 계정 정보가 있음: ${target.origin}`;
  if (!origins.includes(target.origin)) return `허용 origin(${origins.join(', ')}) 밖으로 이동: ${target.origin}`;
  return null;
}
