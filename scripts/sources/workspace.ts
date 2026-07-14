/**
 * Google Workspace Updates ブログ（Blogger 製）の取得。
 *
 * 既定の /feeds/posts/default は FeedBurner（http URL）へ 302 リダイレクトするため、
 * `?redirect=false`（feeds.config.ts で付与済み）で Google ドメインから直接 https の Atom を
 * rss-parser でパースする。公開フィードなのでトークン・課金・失効なし。
 *
 * 表示は `source: "workspace"`（バッジ「Workspace」）。著者欄にはフィード名を入れる。
 * サムネは media:thumbnail を優先し、無ければ本文 HTML の最初の <img src> をフォールバック抽出。
 */
import Parser from "rss-parser";
import type { FeedItem } from "../../src/lib/feed";
import { truncateSafe } from "./util";

type WsItem = {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  mediaThumbnail?: { $?: { url?: string } };
};

const parser: Parser<{ title?: string }, WsItem> = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (todayai feed aggregator)" },
  customFields: {
    item: [["media:thumbnail", "mediaThumbnail"]],
  },
});

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return truncateSafe(text, 200, 197);
}

function thumbnail(it: WsItem): string | undefined {
  if (it.mediaThumbnail?.$?.url) return it.mediaThumbnail.$.url;
  // 本文 HTML の最初の <img src> をフォールバック抽出（Blogger は本文に画像/GIF を埋め込む）。
  const m = it.content?.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m?.[1];
}

function publishedAt(it: WsItem): string {
  if (it.isoDate) return it.isoDate;
  if (it.pubDate) {
    const d = new Date(it.pubDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function fetchWorkspace(opts: {
  rssUrl: string;
  perFeedLimit: number;
}): Promise<FeedItem[]> {
  const feed = await parser.parseURL(opts.rssUrl);
  const feedName = feed.title?.trim() ?? "Google Workspace Updates";
  const items: FeedItem[] = [];
  for (const it of feed.items) {
    if (items.length >= opts.perFeedLimit) break;
    const link = it.link ?? it.guid;
    if (!link) continue;
    items.push({
      id: `workspace-${link}`,
      source: "workspace",
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
