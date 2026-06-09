/**
 * OGP 画像抽出。
 *
 * 任意の URL（X の t.co 短縮含む）からページの og:image / twitter:image を取り出す。
 * X 自身（x.com / twitter.com）はログイン壁で画像が取れないため対象外。
 *
 * aggregate 内で X ブックマークのサムネ補完に使う。失敗は握りつぶし undefined を返す
 * （集約全体を止めない）。
 */

const UA =
  "Mozilla/5.0 (compatible; todayai-aggregator/1.0; +https://satory074.github.io/todayai/)";
const TIMEOUT_MS = 5000;

function isXHost(host: string): boolean {
  return /(^|\.)(x\.com|twitter\.com|t\.co)$/.test(host);
}

/** タイムアウト付き fetch。 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** HTML から og:image / twitter:image の content を抽出（属性順不同に対応）。 */
function extractOgImage(html: string, baseUrl: string): string | undefined {
  // <meta ... property="og:image" ... content="..."> / name="twitter:image" の両順序を許容
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (key !== "og:image" && key !== "og:image:url" && key !== "twitter:image") continue;
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (content) {
      try {
        return new URL(content, baseUrl).toString();
      } catch {
        return content;
      }
    }
  }
  return undefined;
}

/**
 * URL を解決して og:image を返す。取得不可・X 由来・エラー時は undefined。
 */
export async function resolveOgImage(url: string): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return undefined;
    const finalUrl = res.url || url;
    if (isXHost(new URL(finalUrl).host)) return undefined; // ログイン壁で og:image 無し
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return undefined;
    const html = await res.text();
    return extractOgImage(html, finalUrl);
  } catch {
    return undefined;
  }
}
