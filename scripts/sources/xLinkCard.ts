/**
 * X ツイート本文リンク（t.co）のリンクプレビュー（OGP カード）補完。
 *
 * X フィードには本文が t.co 短縮リンクだけ / 末尾リンクのツイートがある。外部アカウント経路
 * （X API・`fetchXAccounts`）は t.co を一切解決しないため、これらはサムネもプレビューも付かない。
 * そこで両経路（fetchX / fetchXAccounts）の X 項目を横断し、t.co を解決してカード
 * （画像＋タイトル＋説明＋ドメイン）を `item.linkPreview` に載せる。
 *
 * `layerxThumb.ts` の `resolveThumb` を土台にしたハイブリッド解決:
 *   - x.com/…/status/<id> → 非公式 syndication でツイートのメディア画像 / 本文リンク先 og:image。
 *   - それ以外（外部サイト・主ケース） → og:image + og:title + og:description。
 *
 * `enrichArticles.ts` / `enrichLayerxThumbs` と同じ「state 永続キャッシュ（負キャッシュ込み）＋
 * 毎回再適用＋トリム後対象＋未確認のみ取得＋1run あたり maxNew で段階補完」パターン。
 * 失敗は握りつぶしプレビュー無しにフォールバック（集約全体を止めない）。
 *
 * ⚠️ CI（datacenter IP）では Cloudflare bot ウォール等で一部の外部サイトが 403 になり得る。
 * 未解決分は負キャッシュ＋再適用で吸収し、ローカル `npm run enrich:xlinks` で補完できる。
 */
import type { FeedItem, XLinkCard } from "../../src/lib/feed";
import {
  resolvePage,
  resolveOgImage,
  extractOgImage,
  extractOgTitle,
  extractOgDescription,
} from "./ogp";
import { tweetIdFromUrl, fetchTweet } from "./syndication";
import { extractTcoUrls } from "./x";
import { mapLimit, truncateSafe } from "./util";

export interface EnrichXLinksResult {
  resolved: number;
  attempted: number;
}

const X_HOST = /(?:^|\.)(x\.com|twitter\.com|t\.co)$/;

/** URL のホスト（www. 除去）。パース不能なら undefined。 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** 末尾/文中の t.co を除去（表示・翻訳に使う本文整形）。 */
function stripTco(text: string): string {
  return text.replace(/\s*https?:\/\/t\.co\/\S+/g, "").trim();
}

/** 1 リンク（t.co）を解決してカードを作る。x.com はツイート経由、それ以外は OGP。 */
async function resolveLinkCard(url: string): Promise<XLinkCard | undefined> {
  const page = await resolvePage(url);
  if (!page) return undefined;
  const finalUrl = page.finalUrl;

  // x.com/…/status/<id>: ログイン壁で og が取れないので syndication で解決。
  const tweetId = tweetIdFromUrl(finalUrl);
  if (tweetId) {
    const tw = await fetchTweet(tweetId);
    if (!tw) return undefined;
    let image = tw.photo; // メディア付きツイート
    if (!image) {
      // メディア無しのリンク共有ツイート: 本文中の外部リンク先の og:image
      for (const link of tw.links) {
        const h = hostOf(link);
        if (!h || X_HOST.test(h)) continue;
        image = await resolveOgImage(link);
        if (image) break;
      }
    }
    const text = stripTco(tw.text ?? "");
    const title = text ? truncateSafe(text, 200, 197) : undefined;
    if (!title && !image) return undefined;
    return {
      url: finalUrl,
      title,
      description: tw.author ? `@${tw.author.handle}` : undefined,
      image,
      domain: "x.com",
    };
  }

  // 外部サイト: 取得済み HTML から OGP。
  if (!page.html) return undefined;
  const image = extractOgImage(page.html, finalUrl);
  const rawTitle = extractOgTitle(page.html);
  const rawDesc = extractOgDescription(page.html);
  if (!rawTitle && !image) return undefined;
  return {
    url: finalUrl,
    title: rawTitle ? truncateSafe(rawTitle, 200, 197) : undefined,
    description: rawDesc ? truncateSafe(rawDesc, 300, 297) : undefined,
    image,
    domain: hostOf(finalUrl) ?? finalUrl,
  };
}

/**
 * `items` のうち t.co リンクを含む X 項目にリンクプレビューを補完する。
 * cache を参照して未確認のみ取得（null 負キャッシュ込み）、`maxNew` で1run の新規取得を制限。
 * cache は破壊的に更新される（呼び出し側で state に保存）。
 */
export async function enrichXLinks(
  items: FeedItem[],
  cache: Record<string, XLinkCard | null>,
  opts: { concurrency?: number; maxNew?: number } = {},
): Promise<EnrichXLinksResult> {
  const targets: FeedItem[] = [];
  for (const item of items) {
    if (item.source !== "x") continue;
    if (item.linkPreview) continue;
    const cached = cache[item.id];
    if (cached !== undefined) {
      if (cached) item.linkPreview = cached; // null は確認済み・カードなし＝スキップ
      continue;
    }
    const body = item.summary ?? item.title;
    if (extractTcoUrls(body).length === 0) continue; // t.co を含まない＝対象外
    targets.push(item);
  }

  if (opts.maxNew !== undefined && targets.length > opts.maxNew) {
    targets.length = opts.maxNew;
  }

  let resolved = 0;
  await mapLimit(targets, opts.concurrency ?? 5, async (item) => {
    const tcoUrls = extractTcoUrls(item.summary ?? item.title);
    let card: XLinkCard | undefined;
    for (const tco of tcoUrls) {
      card = await resolveLinkCard(tco);
      if (card) break;
    }
    if (card) {
      item.linkPreview = card;
      resolved++;
    }
    cache[item.id] = card ?? null; // 取得失敗・カードなしは負キャッシュ
  });

  return { resolved, attempted: targets.length };
}
