/**
 * フィード集約スクリプト。
 *
 * 3ソース（X / Feedly / はてブ）を取得 → FeedItem に正規化 → 既存キャッシュとマージ
 * → 重複排除・ソート・トリム → src/data/feed.json に書き出す。
 *
 * 各ソースは個別に try/catch する。あるソースの取得に失敗した場合、
 * そのソースの「前回キャッシュ分」を維持し、他ソースだけ更新する（graceful degradation）。
 *
 * ローカル実行: `npm run aggregate`（.env を読む）
 * CI 実行    : GitHub Actions が Secrets を env に渡して実行。
 */
import { config as loadEnv } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { feedsConfig } from "../feeds.config";
import type { FeedData, FeedItem, FeedSource } from "../src/lib/feed";
import { fetchX, fetchXAccounts } from "./sources/x";
import { fetchFeedly } from "./sources/feedly";
import { fetchHatena } from "./sources/hatena";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "src", "data", "feed.json");

function readCache(): FeedData {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as FeedData;
    if (!Array.isArray(parsed.items)) parsed.items = [];
    return parsed;
  } catch {
    return { updatedAt: new Date(0).toISOString(), items: [], state: {} };
  }
}

function writeCache(data: FeedData): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

/** 指定ソースの前回キャッシュ分。失敗時のフォールバックに使う。 */
function cachedFor(cache: FeedData, source: FeedSource): FeedItem[] {
  return cache.items.filter((i) => i.source === source);
}

async function run(): Promise<void> {
  const cache = readCache();
  const state = cache.state ?? {};
  const collected: FeedItem[] = [];
  const errors: string[] = [];

  // ---- X ----
  // 前回キャッシュを土台にし、取れたソースだけ上書き/追記する。
  // ・ブックマーク: basecamp公開JSONが全件返すので毎回フレッシュに置換（dedupで更新）
  // ・外部アカウント: since_id増分なので前回分を保持しつつ新着を追記（重複課金回避）
  // 同一idはdedupで1件に集約される。
  if (feedsConfig.x.disabled) {
    console.log("[x] disabled");
    collected.push(...cachedFor(cache, "x"));
  } else {
    // 外部アカウントのポストは since_id 増分のため前回分を保持する。
    // ブックマークは公開JSONが全件返すので保持せず毎回フレッシュに置換（古い設定の残骸も purge）。
    const accountAuthors = new Set(feedsConfig.x.accounts.map((u) => `@${u}`));
    const xItems: FeedItem[] = cachedFor(cache, "x").filter(
      (i) => i.author !== undefined && accountAuthors.has(i.author),
    );

    // (a) 自分のブックマーク等（basecamp 公開JSON、トークン不要）
    try {
      const items = await fetchX({
        sourceUrl: feedsConfig.x.sourceUrl,
        username: feedsConfig.x.username,
        categories: feedsConfig.x.categories,
      });
      xItems.push(...items);
      console.log(`[x] basecamp公開JSON: ${items.length} items (${feedsConfig.x.categories.join("/") || "なし"})`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`x(json): ${msg}`);
      console.error("[x] 公開JSON取得失敗（前回分維持）:", msg);
    }

    // (b) 外部アカウントのポスト（X API App-only Bearer + since_id 増分）
    if (feedsConfig.x.accounts.length > 0) {
      const bearer = process.env.X_BEARER_TOKEN;
      if (!bearer) {
        errors.push("x(accounts): X_BEARER_TOKEN 未設定");
        console.error("[x] X_BEARER_TOKEN 未設定（外部アカウント取得スキップ・前回分維持）");
      } else {
        const r = await fetchXAccounts({
          accounts: feedsConfig.x.accounts,
          bearer,
          maxResults: feedsConfig.x.accountMaxResults,
          sinceIds: state.xAccountSinceIds ?? {},
          userIds: state.xAccountUserIds ?? {},
        });
        state.xAccountSinceIds = r.sinceIds;
        state.xAccountUserIds = r.userIds;
        xItems.push(...r.items);
        for (const e of r.errors) errors.push(e);
        console.log(`[x] 外部アカウント: +${r.items.length} new (${feedsConfig.x.accounts.join(",")})`);
      }
    }

    collected.push(...xItems);
  }

  // ---- Feedly ----
  if (feedsConfig.feedly.disabled) {
    console.log("[feedly] disabled");
    collected.push(...cachedFor(cache, "feedly"));
  } else {
    const token = process.env.FEEDLY_API_TOKEN;
    if (!token) {
      errors.push("feedly: FEEDLY_API_TOKEN 未設定");
      console.error("[feedly] FEEDLY_API_TOKEN 未設定（前回キャッシュを維持）");
      collected.push(...cachedFor(cache, "feedly"));
    } else {
      try {
        const items = await fetchFeedly({
          streamId: feedsConfig.feedly.streamId,
          count: feedsConfig.feedly.count,
          token,
        });
        collected.push(...items);
        console.log(`[feedly] ${items.length} items`);
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`feedly: ${msg}`);
        console.error("[feedly] 取得失敗（前回キャッシュを維持）:", msg);
        collected.push(...cachedFor(cache, "feedly"));
      }
    }
  }

  // ---- はてブ ----
  if (feedsConfig.hatena.disabled) {
    console.log("[hatena] disabled");
    collected.push(...cachedFor(cache, "hatena"));
  } else {
    try {
      const items = await fetchHatena({ rssUrl: feedsConfig.hatena.rssUrl });
      collected.push(...items);
      console.log(`[hatena] ${items.length} items`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`hatena: ${msg}`);
      console.error("[hatena] 取得失敗（前回キャッシュを維持）:", msg);
      collected.push(...cachedFor(cache, "hatena"));
    }
  }

  // ---- 重複排除 → ソート → トリム ----
  const byId = new Map<string, FeedItem>();
  for (const item of collected) {
    // 同一IDは新しい publishedAt のものを優先
    const prev = byId.get(item.id);
    if (!prev || new Date(item.publishedAt) > new Date(prev.publishedAt)) {
      byId.set(item.id, item);
    }
  }
  let items = [...byId.values()].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  const cutoff = Date.now() - feedsConfig.maxAgeDays * 86400000;
  items = items.filter((i) => new Date(i.publishedAt).getTime() >= cutoff);
  items = items.slice(0, feedsConfig.maxItems);

  const out: FeedData = {
    updatedAt: new Date().toISOString(),
    items,
    state,
  };
  writeCache(out);

  const counts = { x: 0, feedly: 0, hatena: 0 } as Record<FeedSource, number>;
  for (const i of items) counts[i.source]++;
  console.log(
    `\n✅ feed.json 更新: 計 ${items.length} 件 (X=${counts.x} / Feedly=${counts.feedly} / はてブ=${counts.hatena})`,
  );
  if (errors.length) {
    console.warn(`⚠️  ${errors.length} 件のソースでエラー:\n  - ${errors.join("\n  - ")}`);
  }
}

run().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
