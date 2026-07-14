/** ソース取得まわりの共有ユーティリティ。 */

/** 末尾に残った上位サロゲート単独を落とす（slice が絵文字等を分断したときの後始末）。 */
export function dropSplitSurrogateEnd(s: string): string {
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

/** サロゲートペアを分断しない切り詰め。max 文字超なら keep 文字で切って「…」を付ける。 */
export function truncateSafe(text: string, max: number, keep: number): string {
  return text.length > max ? dropSplitSurrogateEnd(text.slice(0, keep)) + "…" : text;
}

/**
 * 対を成さないサロゲートを除去。混入すると feed.json が jq 等の厳格なパーサで
 * 不正 JSON 扱いになり、rss.xml では不正 XML 文字になる。
 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** 並列数を制限して非同期タスクを実行する簡易プール。 */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
