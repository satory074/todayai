/**
 * 記事系ソース（feedly / hatena / workspace）のエンリッチ。
 *
 * 記事 URL を **1回だけ** fetch（`resolvePage`）し、その HTML から:
 *   - og:image（サムネが無く未確認のもの）→ `item.thumbnail` ＋ `ogCache`（負キャッシュ込み）
 *   - 本文プレーンテキスト（これから要約されるもの）→ `item.contentText`（一時・要約入力用）
 * を同時に取り出す。従来の `enrichOgp.ts`（og:image のみ）の置き換えで、本文取得のための
 * 二重 fetch を避ける。
 *
 * `item.contentText` は集約中だけの一時フィールドで、要約（translate.ts）の入力に使われ、
 * `aggregate.ts` が `feed.json` 書き出し前に削除する（肥大化回避）。本文が取れない記事
 * （取得失敗・有料・JS レンダリング等）は `contentText` 未設定のまま＝要約側が `summary`
 * （RSS 抜粋）にフォールバックする（graceful degradation）。
 *
 * `transCache`（state.translations）にキャッシュ済みの item は「要約済み」とみなし本文を
 * 取りに行かない。`extractText:false`（GEMINI 無し等で要約しない run）のときは og:image だけ。
 */
import type { FeedItem, FeedSource } from "../../src/lib/feed";
import { resolvePage, extractOgImage, extractMainText } from "./ogp";
import { mapLimit } from "./util";

export interface EnrichArticlesResult {
  /** 今回 og:image を解決できた件数 */
  ogResolved: number;
  /** 今回 本文テキストを取れた件数 */
  textResolved: number;
  /** 今回 実際に fetch した件数 */
  fetched: number;
}

interface TransCacheEntry {
  titleJa?: string;
  summaryJa?: string;
}

export async function enrichArticles(
  items: FeedItem[],
  ogCache: Record<string, string>,
  transCache: Record<string, TransCacheEntry>,
  allowed: Set<FeedSource>,
  opts: { concurrency?: number; maxLen?: number; extractText?: boolean } = {},
): Promise<EnrichArticlesResult> {
  const extractText = opts.extractText !== false;

  // 対象: og or 本文のどちらかが必要なもの。既知サムネは fetch せず再適用。
  const targets: FeedItem[] = [];
  for (const item of items) {
    if (!allowed.has(item.source)) continue;
    if (!item.thumbnail) {
      const cachedOg = ogCache[item.id];
      if (cachedOg) item.thumbnail = cachedOg; // 既知の画像を流用
    }
    const needOg = !item.thumbnail && ogCache[item.id] === undefined;
    const needText = extractText && transCache[item.id] === undefined; // 未要約＝本文が要る
    if (needOg || needText) targets.push(item);
  }

  let ogResolved = 0;
  let textResolved = 0;
  let fetched = 0;
  await mapLimit(targets, opts.concurrency ?? 5, async (item) => {
    const doOg = !item.thumbnail && ogCache[item.id] === undefined;
    const doText = extractText && transCache[item.id] === undefined;
    const page = await resolvePage(item.url);
    fetched++;
    if (!page || !page.html) {
      if (doOg) ogCache[item.id] = ""; // 取得失敗は og 負キャッシュ（本文は次回再試行）
      return;
    }
    if (doOg) {
      const og = extractOgImage(page.html, page.finalUrl);
      if (og) {
        item.thumbnail = og;
        ogResolved++;
      }
      ogCache[item.id] = og ?? ""; // 解決失敗は負キャッシュ
    }
    if (doText) {
      const text = extractMainText(page.html, opts.maxLen);
      if (text.length > 0) {
        item.contentText = text;
        textResolved++;
      }
    }
  });

  return { ogResolved, textResolved, fetched };
}
