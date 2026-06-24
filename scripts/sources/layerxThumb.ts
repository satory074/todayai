/**
 * LayerX アイテムのサムネ補完（syndication ＋ OGP ハイブリッド）。
 *
 * LayerX ニュースレターの掲載リンク（Substack リダイレクト）の多くは x.com（ツイート）に
 * 解決される。x.com はログイン壁で og:image が取れないため、リダイレクト先を判定して:
 *   - x.com/status/<id> → 非公式 syndication でツイートのメディア画像を取得。
 *       メディアが無いリンク共有ツイートは、本文中の外部リンクの og:image を解決。
 *   - それ以外（記事サイト等） → 通常どおり og:image を抽出。
 *
 * `enrichOgp.ts` と同じ「state 永続キャッシュ（負キャッシュ込み）＋トリム後対象＋未確認のみ取得
 * ＋1run あたり maxNew で段階補完」パターン。失敗は握りつぶしサムネ無しにフォールバック。
 */
import type { FeedItem } from "../../src/lib/feed";
import { resolvePage, resolveOgImage, extractOgImage } from "./ogp";
import { tweetIdFromUrl, fetchTweet } from "./syndication";
import { mapLimit } from "./util";

export interface EnrichResult {
  resolved: number;
  attempted: number;
}

/** 1 リンクのサムネを解決する（x.com はツイート経由、それ以外は og:image）。 */
async function resolveThumb(url: string): Promise<string | undefined> {
  const page = await resolvePage(url);
  if (!page) return undefined;

  const tweetId = tweetIdFromUrl(page.finalUrl);
  if (tweetId) {
    const tw = await fetchTweet(tweetId);
    if (!tw) return undefined;
    if (tw.photo) return tw.photo; // メディア付きツイート
    // リンク共有ツイート: 本文中の外部リンク（非X）の og:image を解決
    for (const link of tw.links) {
      let host: string;
      try {
        host = new URL(link).host;
      } catch {
        continue;
      }
      if (/(?:^|\.)(x\.com|twitter\.com|t\.co)$/.test(host)) continue;
      const og = await resolveOgImage(link);
      if (og) return og;
    }
    return undefined;
  }

  // x.com 以外の通常ページ: 取得済み HTML から og:image
  if (page.html) return extractOgImage(page.html, page.finalUrl);
  return undefined;
}

/**
 * `items` のうち LayerX でサムネが無いものを対象に、上記ハイブリッドでサムネを補完する。
 * ogCache を参照して未確認のみ取得（負キャッシュ込み）、`maxNew` で1run の新規取得を制限。
 * ogCache は破壊的に更新される（呼び出し側で state に保存）。
 */
export async function enrichLayerxThumbs(
  items: FeedItem[],
  ogCache: Record<string, string>,
  opts: { concurrency?: number; maxNew?: number } = {},
): Promise<EnrichResult> {
  const targets: FeedItem[] = [];
  for (const item of items) {
    if (item.source !== "layerx") continue;
    if (item.thumbnail) continue;
    const cached = ogCache[item.id];
    if (cached !== undefined) {
      if (cached) item.thumbnail = cached;
      continue;
    }
    targets.push(item);
  }

  if (opts.maxNew !== undefined && targets.length > opts.maxNew) {
    targets.length = opts.maxNew;
  }

  let resolved = 0;
  await mapLimit(targets, opts.concurrency ?? 3, async (item) => {
    const thumb = await resolveThumb(item.url);
    if (thumb) {
      item.thumbnail = thumb;
      resolved++;
    }
    ogCache[item.id] = thumb ?? ""; // 取得失敗・サムネ無しは負キャッシュ
  });

  return { resolved, attempted: targets.length };
}
