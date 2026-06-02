import rss from "@astrojs/rss";
import { absUrl } from "@/lib/url";
import { sourceLabel, type FeedData } from "@/lib/feed";
import feedJson from "@/data/feed.json";

export async function GET() {
  const feed = feedJson as FeedData;
  const items = [...feed.items].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  return rss({
    title: "today.ai — AI情報フィード",
    description:
      "特定のXアカウント・Feedlyフォルダ・はてなブックマーク（テクノロジー）から集約したAI関連情報。",
    site: absUrl("/"),
    items: items.map((item) => ({
      title: `[${sourceLabel(item.source)}] ${item.title}`,
      link: item.url,
      pubDate: new Date(item.publishedAt),
      description: item.summary ?? "",
    })),
    customData: `<language>ja</language>`,
  });
}
