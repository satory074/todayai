/**
 * Feedly フォルダ相当の RSS 集約（Feedly API の代替）。
 *
 * Feedly の開発者トークンは現在 Enterprise プラン限定で個人利用できないため、
 * フォルダに入れていた各 RSS フィードを rss-parser で直接取得する。
 * トークン・課金・失効なし。フィードごとに try/catch し、1本が死んでも他は活かす。
 * 全フィードが失敗した場合のみ throw して、呼び出し側で前回キャッシュへフォールバックさせる。
 *
 * 表示は従来どおり `source: "feedly"`（バッジ「Feedly」）。著者欄にはフィード名を入れる。
 */
import Parser from "rss-parser";
import type { FeedItem } from "../../src/lib/feed";

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
  return (
    it.enclosure?.url ?? it.mediaThumbnail?.$?.url ?? it.mediaContent?.$?.url ?? undefined
  );
}

function publishedAt(it: RssItem): string {
  if (it.isoDate) return it.isoDate;
  if (it.pubDate) {
    const d = new Date(it.pubDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function fetchFeedly(opts: {
  rssUrls: string[];
  perFeedLimit: number;
}): Promise<FeedItem[]> {
  const collected: FeedItem[] = [];
  const failures: string[] = [];

  for (const url of opts.rssUrls) {
    try {
      const feed = await parser.parseURL(url);
      const feedName = feed.title?.trim();
      let taken = 0;
      for (const it of feed.items) {
        if (taken >= opts.perFeedLimit) break;
        const link = it.link ?? it.guid;
        if (!link) continue;
        collected.push({
          id: `feedly-${link}`,
          source: "feedly",
          title: it.title?.trim() || link,
          url: link,
          publishedAt: publishedAt(it),
          summary: snippet(it.contentSnippet ?? it.content),
          thumbnail: thumbnail(it),
          author: feedName,
        });
        taken++;
      }
    } catch (e) {
      failures.push(`${url}: ${(e as Error).message}`);
      console.warn(`[feedly] 1フィード取得失敗（スキップ）: ${url}: ${(e as Error).message}`);
    }
  }

  // 全フィードが失敗したときだけ呼び出し側にフォールバックさせる。
  if (collected.length === 0 && failures.length === opts.rssUrls.length) {
    throw new Error(`全 ${opts.rssUrls.length} フィードの取得に失敗`);
  }
  return collected;
}
