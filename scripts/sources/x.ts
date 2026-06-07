/**
 * X (Twitter) ソース取得。
 *
 * X API を直接叩く代わりに、basecamp が公開している x-tweets.json を読む。
 *   - X API / トークン / 追加課金が不要
 *   - OAuth リフレッシュトークンが basecamp と競合しない
 *
 * 公開JSONの構造: { username, tweets: [{ id, date, category, description, isRetweet? }] }
 * category は "post" | "like" | "bookmark"。
 */
import type { FeedItem } from "../../src/lib/feed";
import type { XCategory } from "../../feeds.config";

interface XTweetEntry {
  id: string;
  date: string;
  category: XCategory;
  description?: string;
  isRetweet?: boolean;
}

interface XTweetsFile {
  username: string;
  tweets: XTweetEntry[];
}

const CATEGORY_LABEL: Record<XCategory, string> = {
  post: "投稿",
  like: "いいね",
  bookmark: "ブックマーク",
};

/** 末尾の t.co 短縮URLを除去して表示を整える。 */
function cleanText(text: string): string {
  return text.replace(/\s*https?:\/\/t\.co\/\S+\s*$/g, "").trim();
}

export async function fetchX(opts: {
  sourceUrl: string;
  username: string;
  categories: XCategory[];
}): Promise<FeedItem[]> {
  const res = await fetch(opts.sourceUrl, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    throw new Error(`x-tweets.json fetch failed (${res.status}): ${opts.sourceUrl}`);
  }
  const file = (await res.json()) as XTweetsFile;
  const wanted = new Set(opts.categories);

  const items: FeedItem[] = [];
  for (const t of file.tweets ?? []) {
    if (!wanted.has(t.category)) continue;
    if (t.isRetweet) continue;
    const raw = (t.description ?? "").trim();
    const text = cleanText(raw) || raw;
    if (!text) continue;
    const title = text.length > 140 ? text.slice(0, 137) + "…" : text;
    // 自分の投稿は自アカウントURL、いいね/ブックマークは作者不明のため /i/status を使う
    const url =
      t.category === "post"
        ? `https://x.com/${opts.username}/status/${t.id}`
        : `https://x.com/i/status/${t.id}`;
    items.push({
      id: `x-${t.id}`,
      source: "x",
      title,
      url,
      publishedAt: t.date,
      summary: text !== title ? text : undefined,
      author: t.category === "post" ? `@${opts.username}` : CATEGORY_LABEL[t.category],
    });
  }
  return items;
}
