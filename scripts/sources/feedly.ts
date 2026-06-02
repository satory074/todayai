/**
 * Feedly ソース取得。
 * カテゴリ(フォルダ)を streamId 経由で取得する。
 *   GET /v3/streams/contents?streamId=<encoded>&count=N
 *   Authorization: Bearer <FEEDLY_API_TOKEN>
 */
import type { FeedItem } from "../../src/lib/feed";

const FEEDLY_API = "https://feedly.com/v3";

interface FeedlyEntry {
  id: string;
  title?: string;
  published?: number; // epoch ms
  crawled?: number;
  summary?: { content?: string };
  content?: { content?: string };
  alternate?: { href: string; type: string }[];
  canonicalUrl?: string;
  visual?: { url?: string };
  origin?: { title?: string; htmlUrl?: string };
}

interface FeedlyStreamResponse {
  items?: FeedlyEntry[];
  continuation?: string;
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
}

function entryUrl(e: FeedlyEntry): string | undefined {
  if (e.canonicalUrl) return e.canonicalUrl;
  const html = e.alternate?.find((a) => a.type === "text/html");
  return html?.href ?? e.alternate?.[0]?.href ?? e.origin?.htmlUrl;
}

export async function fetchFeedly(opts: {
  streamId: string;
  count: number;
  token: string;
}): Promise<FeedItem[]> {
  const url = new URL(`${FEEDLY_API}/streams/contents`);
  url.searchParams.set("streamId", opts.streamId);
  url.searchParams.set("count", String(opts.count));
  url.searchParams.set("ranked", "newest");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    throw new Error(`Feedly streams/contents failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as FeedlyStreamResponse;
  const items: FeedItem[] = [];
  for (const e of json.items ?? []) {
    const link = entryUrl(e);
    if (!link) continue;
    const published = e.published ?? e.crawled;
    items.push({
      id: `feedly-${e.id}`,
      source: "feedly",
      title: e.title?.trim() || link,
      url: link,
      publishedAt: published ? new Date(published).toISOString() : new Date().toISOString(),
      summary: stripHtml(e.summary?.content ?? e.content?.content),
      thumbnail: e.visual?.url && e.visual.url !== "none" ? e.visual.url : undefined,
      author: e.origin?.title,
    });
  }
  return items;
}
