// 検索エンジン向けの共通部品（canonical の URL と構造化データ JSON-LD）。Layout.astro だけが使う。
// 画面に出ていない内容はここに書かない。集約した他人の記事は JSON-LD に並べない（中身は元サイトのもの）。

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export const SITE_NAME = "today.ai";

/** トップページの絶対 URL（末尾 /）。例: https://satory074.github.io/todayai/ */
export const HOME_URL = new URL(`${base}/`, import.meta.env.SITE).href;

/** トップの WebSite を指す @id。下層ページの isPartOf から参照する */
export const WEBSITE_ID = `${HOME_URL}#website`;

/** 作者。この @id は satory074.com 側で Person として定義している */
export const AUTHOR = {
  "@type": "Person",
  "@id": "https://satory074.com/#person",
  name: "satory074",
  url: "https://satory074.com/",
} as const;

/**
 * ページのパス → canonical の絶対 URL。全ページをディレクトリ形式（…/index.html）で出しているので末尾は必ず / 。
 * trailingSlash: "ignore" のままだとトップの Astro.url.pathname は "/todayai"（/ 無し）になり、
 * canonical が 301 される側の URL を指していた（og:url・サイトマップは / 付きで食い違っていた）。
 */
export function canonicalOf(pathname: string): string {
  return new URL(pathname.endsWith("/") ? pathname : `${pathname}/`, import.meta.env.SITE).href;
}

export type SchemaType = "WebSite" | "WebPage" | "AboutPage" | "CollectionPage";

/** 1 ページ 1 つの JSON-LD。url・description は canonical・meta description と同じ値を渡す */
export function pageJsonLd(opts: {
  type: SchemaType;
  name: string;
  url: string;
  description: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const common = { url: opts.url, description: opts.description, inLanguage: "ja", author: AUTHOR };
  if (opts.type === "WebSite") {
    return { "@context": "https://schema.org", "@type": "WebSite", "@id": WEBSITE_ID, name: SITE_NAME, ...common };
  }
  return {
    "@context": "https://schema.org",
    "@type": opts.type,
    name: opts.name,
    ...common,
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: SITE_NAME, url: HOME_URL },
    ...opts.extra,
  };
}

/** `<script type="application/ld+json">` に埋める文字列。文字列に `</script>` があっても閉じないよう < を逃がす */
export function jsonLdString(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
