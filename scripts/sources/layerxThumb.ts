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
  /** 診断用: 解決経路/失敗段階の内訳 */
  stages: Record<string, number>;
  /** 診断用: Substack 自体の応答内訳（ブロック切り分け） */
  probes: Record<string, number>;
}

/** 解決の段階コード（診断用）。 */
type Stage =
  | "page-fail" // リダイレクト解決失敗（x.com が Actions IP を弾く等）
  | "tweet-fail" // syndication 取得失敗
  | "x-media" // ツイートのメディア画像で解決
  | "x-link-og" // リンク共有ツイートの飛び先 og:image で解決
  | "x-none" // x ツイートだがサムネ無し
  | "page-og" // x 以外ページの og:image で解決
  | "page-none"; // x 以外ページだが og:image 無し

const UA =
  "Mozilla/5.0 (compatible; todayai-aggregator/1.0; +https://satory074.github.io/todayai/)";

/** 診断: Substack 自体の応答（リダイレクトを追わない）を確認し、Substack ブロックか
 *  下流(x.com 等)ブロックかを切り分ける。`s<status>→<redirect先host>` / `s-throw` を返す。 */
async function probeSubstack(url: string): Promise<string> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  try {
    const p = await fetch(url, { redirect: "manual", signal: c.signal, headers: { "user-agent": UA } });
    const loc = p.headers.get("location");
    let host = "";
    try {
      if (loc) host = new URL(loc, url).host;
    } catch {
      /* ignore */
    }
    return `s${p.status}${host ? "→" + host : ""}`;
  } catch {
    return "s-throw";
  } finally {
    clearTimeout(t);
  }
}

/** 1 リンクのサムネを解決し、画像URLと診断段階を返す。 */
async function resolveThumb(url: string): Promise<{ thumb?: string; stage: Stage; probe: string }> {
  const probe = await probeSubstack(url);
  const page = await resolvePage(url);
  if (!page) return { stage: "page-fail", probe };

  const tweetId = tweetIdFromUrl(page.finalUrl);
  if (tweetId) {
    const tw = await fetchTweet(tweetId);
    if (!tw) return { stage: "tweet-fail", probe };
    if (tw.photo) return { thumb: tw.photo, stage: "x-media", probe }; // メディア付きツイート
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
      if (og) return { thumb: og, stage: "x-link-og", probe };
    }
    return { stage: "x-none", probe };
  }

  // x.com 以外の通常ページ: 取得済み HTML から og:image
  if (page.html) {
    const og = extractOgImage(page.html, page.finalUrl);
    return { thumb: og, stage: og ? "page-og" : "page-none", probe };
  }
  return { stage: "page-none", probe };
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
  const stages: Record<string, number> = {};
  const probes: Record<string, number> = {};
  await mapLimit(targets, opts.concurrency ?? 3, async (item) => {
    const { thumb, stage, probe } = await resolveThumb(item.url);
    stages[stage] = (stages[stage] ?? 0) + 1;
    probes[probe] = (probes[probe] ?? 0) + 1;
    if (thumb) {
      item.thumbnail = thumb;
      resolved++;
    }
    ogCache[item.id] = thumb ?? ""; // 取得失敗・サムネ無しは負キャッシュ
  });

  return { resolved, attempted: targets.length, stages, probes };
}
