/**
 * Google Cloud リリースノート（Atom を直接取得。トークン・課金・失効なし）。
 *
 * 公開フィード `https://docs.cloud.google.com/feeds/gcp-release-notes.xml` を rss-parser で
 * パースする（旧 `cloud.google.com/feeds/gcp-release-notes.xml` は 301 でここへ転送される）。
 *
 * ⚠️ このフィードは **1エントリ = 1日** で、`<title>` は日付だけ（例 "July 07, 2026"）、
 * `<content>`（HTML）にその日の全製品の更新がまとまっている。today.ai は日付でグルーピング
 * するので日付見出しは冗長 → **本文の `<h2 class="release-note-product-title">製品名</h2>` を
 * 抽出して「App Engine・Bigtable ほかN製品のリリースノート」を見出しにする**（robust: 製品名
 * の hook は安定。抽出0件なら日付フォールバック）。
 *
 * 要約は 1日分の本文から生成したいので、`contentText`（要約入力・一時フィールド。aggregate が
 * feed.json 書き出し前に削除）に長め、`summary`（表示用の原文抜粋）に短めを入れる。`gcloud` は
 * `feeds.config.ts` の `translate.summarizeSources` に入れて3行要約する。**enrichArticles には
 * 渡さない**（エントリの link を辿ると当日だけでなく60日分のページ全体が返るため・サムネも不要）。
 *
 * 表示は `source: "gcloud"`（赤バッジ「GCP」）。サムネ無し＝コンパクト行で描画される。
 */
import Parser from "rss-parser";
import type { FeedItem } from "../../src/lib/feed";

type GcItem = {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
};

const parser: Parser<{ title?: string }, GcItem> = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (todayai feed aggregator)" },
});

/** HTML → プレーンテキスト（タグ除去＋空白畳み込み）。maxLen 超は `…` で切る。 */
function plainText(html: string | undefined, maxLen: number): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

/** 当日の `<content>` から製品名（`<h2 class="release-note-product-title">…</h2>`）を順序保持で抽出。 */
function productTitles(html: string | undefined): string[] {
  if (!html) return [];
  const re = /<h2[^>]*class=["'][^"']*release-note-product-title[^"']*["'][^>]*>(.*?)<\/h2>/gis;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 製品名から日本語見出しを作る。抽出0件なら日付フォールバック。 */
function headline(products: string[], date: string): string {
  if (products.length === 0) return `Google Cloud リリースノート（${date}）`;
  const head = products.slice(0, 3).join("・");
  const rest = products.length - 3;
  // 末尾に日本語（「のリリースノート」）を必ず付ける → isJapanese() が true になり、
  // 見出しの無駄な機械翻訳（製品名は訳さない）をスキップできる。
  return rest > 0 ? `${head} ほか${rest}製品のリリースノート` : `${head}のリリースノート`;
}

function publishedAt(it: GcItem): string {
  if (it.isoDate) return it.isoDate;
  if (it.pubDate) {
    const d = new Date(it.pubDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function fetchGcloud(opts: {
  rssUrl: string;
  /** 取り込む最大件数（1ソースの占有を防ぐ） */
  limit?: number;
}): Promise<FeedItem[]> {
  const feed = await parser.parseURL(opts.rssUrl);
  const feedName = feed.title?.trim() || "Google Cloud release notes";
  const items: FeedItem[] = [];
  for (const it of feed.items) {
    if (opts.limit !== undefined && items.length >= opts.limit) break;
    const link = it.link ?? it.guid;
    if (!link) continue;
    const date = it.title?.trim() || "";
    const products = productTitles(it.content);
    items.push({
      id: `gcloud-${link}`,
      source: "gcloud",
      title: headline(products, date),
      url: link,
      publishedAt: publishedAt(it),
      // 表示用（原文モード）は短め、要約入力（contentText）は1日分を長めに。
      summary: plainText(it.contentSnippet ?? it.content, 200),
      contentText: plainText(it.content, 2000),
      author: feedName,
    });
  }
  return items;
}
