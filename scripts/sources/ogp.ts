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
export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
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
export function extractOgImage(html: string, baseUrl: string): string | undefined {
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

/** 最小限の HTML エンティティ復号（要約入力用なので主要なものだけ）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * HTML から記事本文のプレーンテキストを抽出する（要約入力用の heuristic・依存追加なし）。
 * script/style/nav/header/footer/aside 等の非本文とコメントを除去 → <article>/<main> があれば
 * その中、無ければ全体 → タグ除去・エンティティ復号・空白整形 → 先頭 maxLen 字に cap。
 * 完璧な抽出ではない（多少の boilerplate は混じり得る）が、LLM 要約の入力には十分。
 */
export function extractMainText(html: string, maxLen = 3000): string {
  const h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|head|nav|header|footer|aside|form|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
  // タグ片 → プレーンテキスト（ブロック境界は空白に、残タグ除去、復号、空白整形）。
  const toText = (frag: string): string =>
    decodeEntities(
      frag
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section)\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();

  // 本文らしい領域（最初の <article> / <main>）を優先。ただし空/薄い（SPA で本文が
  // クライアント描画される Qiita 等）の場合は全体にフォールバックする。
  const scopeHtml =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(h)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h)?.[1];
  let text = scopeHtml ? toText(scopeHtml) : "";
  if (text.length < 200) text = toText(h);

  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

export interface ResolvedPage {
  /** リダイレクト追跡後の最終 URL */
  finalUrl: string;
  /** HTML 本文。X ホスト（ログイン壁）/ 非HTML / 取得失敗時は未設定 */
  html?: string;
}

/**
 * URL をリダイレクト追跡で解決し、最終 URL と（取れれば）HTML を返す。
 * X ホストは og:image が無いので本文は読まない（最終 URL だけ返す＝呼び出し側で
 * ツイート ID を取り出して syndication 等に回せる）。取得失敗・エラー時は undefined。
 */
export async function resolvePage(url: string): Promise<ResolvedPage | undefined> {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return undefined;
    const finalUrl = res.url || url;
    if (isXHost(new URL(finalUrl).host)) return { finalUrl }; // ログイン壁・本文不要
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return { finalUrl };
    return { finalUrl, html: await res.text() };
  } catch {
    return undefined;
  }
}

/**
 * URL を解決して og:image を返す。取得不可・X 由来・エラー時は undefined。
 */
export async function resolveOgImage(url: string): Promise<string | undefined> {
  const page = await resolvePage(url);
  if (!page || !page.html) return undefined;
  return extractOgImage(page.html, page.finalUrl);
}
