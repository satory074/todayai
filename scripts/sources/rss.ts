/**
 * 単一 RSS フィードを rss-parser で直接取得する汎用フェッチャ。
 *
 * Zenn「AI」トピック / Qiita「AI」タグのように「1本の公開 RSS をそのまま取り込む」
 * ソースで共用する（トークン・課金・失効なし）。`source` で FeedItem.source と id 接頭辞を
 * 切り替えるだけで中身は同一なので、ソースごとにファイルを分けず1関数にまとめている。
 *
 * `parser.parseURL` が throw したらそのまま呼び出し側（aggregate.ts）の try/catch へ伝播し、
 * 前回キャッシュへフォールバックさせる（graceful degradation、hatena.ts と同じ契約）。
 */
import Parser from "rss-parser";
import type { FeedItem, FeedSource } from "../../src/lib/feed";

type RssItem = {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  enclosure?: { url?: string };
  mediaThumbnail?: { $?: { url?: string } };
  mediaContent?: { $?: { url?: string } };
};

const parser: Parser<{ title?: string }, RssItem> = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (todayai feed aggregator)" },
  customFields: {
    item: [
      ["media:thumbnail", "mediaThumbnail"],
      ["media:content", "mediaContent"],
    ],
  },
});

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
}

function thumbnail(it: RssItem): string | undefined {
  return it.enclosure?.url ?? it.mediaThumbnail?.$?.url ?? it.mediaContent?.$?.url ?? undefined;
}

function publishedAt(it: RssItem): string {
  if (it.isoDate) return it.isoDate;
  if (it.pubDate) {
    const d = new Date(it.pubDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function fetchRss(opts: {
  rssUrl: string;
  source: FeedSource;
  /** 取り込む最大件数（未指定なら全件） */
  limit?: number;
}): Promise<FeedItem[]> {
  const feed = await parser.parseURL(opts.rssUrl);
  const feedName = feed.title?.trim();
  const items: FeedItem[] = [];
  for (const it of feed.items) {
    if (opts.limit !== undefined && items.length >= opts.limit) break;
    const link = it.link ?? it.guid;
    if (!link) continue;
    items.push({
      id: `${opts.source}-${link}`,
      source: opts.source,
      title: it.title?.trim() || link,
      url: link,
      publishedAt: publishedAt(it),
      summary: snippet(it.contentSnippet ?? it.content),
      thumbnail: thumbnail(it),
      author: feedName,
    });
  }
  return items;
}
