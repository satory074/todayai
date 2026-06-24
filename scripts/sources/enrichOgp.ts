/**
 * OGP 画像によるサムネ補完（X 以外のソース用）。
 *
 * feed.json 全体でサムネ付きは少数のため、サムネが無いアイテムの記事 URL から
 * og:image / twitter:image を解決して補完する。X は basecamp 公開JSON 経由で
 * 既に `state.xOgImages` で補完済み・LayerX は Substack リダイレクト＆物量が大きい
 * ため対象外（呼び出し側が allowed で制御）。
 *
 * 結果は ogCache（item.id -> 画像URL / ""＝確認済み・画像なしの負キャッシュ）に
 * 記録し、次回以降の再取得を回避する。失敗は resolveOgImage 側で握りつぶされる。
 */
import type { FeedItem, FeedSource } from "../../src/lib/feed";
import { resolveOgImage } from "./ogp";
import { mapLimit } from "./util";

export interface EnrichResult {
  /** 今回新たに画像を解決できた件数 */
  resolved: number;
  /** 今回 OGP 解決を試みた件数 */
  attempted: number;
}

/**
 * `items` のうちサムネが無く `allowed` に含まれるソースのものを対象に OGP 画像を解決する。
 * ogCache を参照して未確認のものだけ取得し、解決できたら item.thumbnail に代入。
 * ogCache は破壊的に更新される（呼び出し側で state に保存する）。
 */
export async function enrichOgImages(
  items: FeedItem[],
  ogCache: Record<string, string>,
  allowed: Set<FeedSource>,
  opts: { concurrency?: number; maxNew?: number } = {},
): Promise<EnrichResult> {
  // 対象: サムネ無し & 許可ソース。キャッシュ済みは流用、未確認のみ取得する。
  const targets: FeedItem[] = [];
  for (const item of items) {
    if (item.thumbnail) continue;
    if (!allowed.has(item.source)) continue;
    const cached = ogCache[item.id];
    if (cached !== undefined) {
      if (cached) item.thumbnail = cached; // 既知の画像を流用
      continue; // 既知（画像有/無）は再取得しない
    }
    targets.push(item);
  }

  // 物量の多いソース（LayerX 等）は 1run あたりの新規取得を上限で絞る。
  // items は publishedAt 降順なので、先頭＝新しい順に取得される。
  if (opts.maxNew !== undefined && targets.length > opts.maxNew) {
    targets.length = opts.maxNew;
  }

  let resolved = 0;
  await mapLimit(targets, opts.concurrency ?? 5, async (item) => {
    const found = await resolveOgImage(item.url);
    if (found) {
      item.thumbnail = found;
      resolved++;
    }
    ogCache[item.id] = found ?? ""; // 取得失敗は負キャッシュ
  });

  return { resolved, attempted: targets.length };
}
