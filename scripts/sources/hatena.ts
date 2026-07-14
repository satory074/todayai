/**
 * はてなブックマーク 人気エントリー テクノロジー の取得。
 * 公開 RSS（認証不要）を rss-parser でパースする。
 *   https://b.hatena.ne.jp/hotentry/it.rss
 * RDF/RSS1.0 形式で、各 item に hatena:bookmarkcount 名前空間が付く。
 */
import Parser from "rss-parser";
import type { FeedItem } from "../../src/lib/feed";
import { truncateSafe } from "./util";

type HatenaItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  bookmarkcount?: string;
  imageurl?: string;
};

const parser: Parser<unknown, HatenaItem> = new Parser({
  customFields: {
    item: [
      ["hatena:bookmarkcount", "bookmarkcount"],
      ["hatena:imageurl", "imageurl"],
    ],
  },
});

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = s.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return truncateSafe(text, 200, 197);
}

export async function fetchHatena(opts: { rssUrl: string }): Promise<FeedItem[]> {
  const feed = await parser.parseURL(opts.rssUrl);
  const items: FeedItem[] = [];
  for (const it of feed.items) {
    if (!it.link) continue;
    const count = it.bookmarkcount ? parseInt(it.bookmarkcount, 10) : undefined;
    items.push({
      id: `hatena-${it.link}`,
      source: "hatena",
      title: it.title?.trim() || it.link,
      url: it.link,
      publishedAt: it.isoDate ?? (it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString()),
      summary: snippet(it.contentSnippet ?? it.content),
      thumbnail: it.imageurl,
      bookmarkCount: Number.isFinite(count) ? count : undefined,
    });
  }
  return items;
}
