/**
 * フィード集約スクリプト。
 *
 * 5ソース（X / Feedly / はてブ / Workspace / LayerX）を取得 → FeedItem に正規化 → 既存キャッシュとマージ
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
import { fetchLayerX } from "./sources/layerx";
import { fetchWorkspace } from "./sources/workspace";
import { enrichOgImages } from "./sources/enrichOgp";
import { enrichLayerxThumbs } from "./sources/layerxThumb";
import { enrichTranslations } from "./sources/translate";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "src", "data", "feed.json");

/**
 * 翻訳/要約キャッシュ（state.translations）の生成ロジック版。
 * プロンプトや「翻訳→要約」などロジックを変えたら上げる → 旧キャッシュを破棄して再生成する。
 * v2: 記事系の summary を「翻訳」から「3行要約」に変更。
 */
const ENRICH_VERSION = "2";

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
      const r = await fetchX({
        sourceUrl: feedsConfig.x.sourceUrl,
        username: feedsConfig.x.username,
        categories: feedsConfig.x.categories,
        ogCache: state.xOgImages ?? {},
      });
      state.xOgImages = r.ogCache;
      xItems.push(...r.items);
      const withThumb = r.items.filter((i) => i.thumbnail).length;
      console.log(`[x] basecamp公開JSON: ${r.items.length} items (${feedsConfig.x.categories.join("/") || "なし"}, サムネ ${withThumb})`);
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

  // ---- Feedly（フォルダ相当の RSS を直接集約。トークン不要）----
  if (feedsConfig.feedly.disabled) {
    console.log("[feedly] disabled");
    collected.push(...cachedFor(cache, "feedly"));
  } else {
    try {
      const items = await fetchFeedly({
        rssUrls: feedsConfig.feedly.rssUrls,
        perFeedLimit: feedsConfig.feedly.perFeedLimit,
      });
      collected.push(...items);
      console.log(`[feedly] ${items.length} items (${feedsConfig.feedly.rssUrls.length} feeds)`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`feedly: ${msg}`);
      console.error("[feedly] 取得失敗（前回キャッシュを維持）:", msg);
      collected.push(...cachedFor(cache, "feedly"));
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

  // ---- Google Workspace Updates（Blogger Atom を直接取得。トークン不要）----
  if (feedsConfig.workspace.disabled) {
    console.log("[workspace] disabled");
    collected.push(...cachedFor(cache, "workspace"));
  } else {
    try {
      const items = await fetchWorkspace({
        rssUrl: feedsConfig.workspace.rssUrl,
        perFeedLimit: feedsConfig.workspace.perFeedLimit,
      });
      collected.push(...items);
      console.log(`[workspace] ${items.length} items`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`workspace: ${msg}`);
      console.error("[workspace] 取得失敗（前回キャッシュを維持）:", msg);
      collected.push(...cachedFor(cache, "workspace"));
    }
  }

  // ---- LayerX AI・LLM Newsletter（Gmail 経由）----
  if (feedsConfig.layerx.disabled) {
    console.log("[layerx] disabled");
    collected.push(...cachedFor(cache, "layerx"));
  } else {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      errors.push("layerx: GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN 未設定");
      console.error("[layerx] GMAIL_* 未設定（取得スキップ・前回キャッシュを維持）");
      collected.push(...cachedFor(cache, "layerx"));
    } else {
      try {
        const items = await fetchLayerX({
          sender: feedsConfig.layerx.sender,
          newerThanDays: feedsConfig.layerx.newerThanDays,
          maxResults: feedsConfig.layerx.maxResults,
          clientId,
          clientSecret,
          refreshToken,
        });
        collected.push(...items);
        console.log(`[layerx] ${items.length} items`);
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`layerx: ${msg}`);
        console.error("[layerx] 取得失敗（前回キャッシュを維持）:", msg);
        collected.push(...cachedFor(cache, "layerx"));
      }
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

  // ---- OGP 画像でサムネ補完（トリム後の最終アイテムのみ＝無駄fetch回避）----
  // X は basecamp 公開JSON 経由で補完済み。記事系（feedly/hatena/workspace）は上限なしで補完。
  const ogImages = state.ogImages ?? {};
  try {
    const r = await enrichOgImages(items, ogImages, new Set(["feedly", "hatena", "workspace"]));
    console.log(`[ogp] サムネ補完(記事系): +${r.resolved} 件解決 (試行 ${r.attempted})`);
  } catch (e) {
    console.error("[ogp] サムネ補完(記事系)でエラー（スキップ）:", (e as Error).message);
  }
  // LayerX は掲載リンクの多くが x.com（ツイート）に解決される。x.com はログイン壁で og:image が
  // 取れないため、syndication でツイートのメディア（無ければ本文リンク先の og:image）を取得する
  // ハイブリッド。物量大（~190件/通）なので maxNew で 1run の新規取得を絞り段階的に補完。
  try {
    const r = await enrichLayerxThumbs(items, ogImages, { maxNew: 40, concurrency: 3 });
    console.log(
      `[ogp] サムネ補完(LayerX): +${r.resolved} 件解決 (試行 ${r.attempted}) 内訳 ${JSON.stringify(r.stages)}`,
    );
  } catch (e) {
    console.error("[ogp] サムネ補完(LayerX)でエラー（スキップ）:", (e as Error).message);
  }
  // 現存 item id 分だけ残して負キャッシュの無限増殖を防ぐ。
  const liveIds = new Set(items.map((i) => i.id));
  state.ogImages = Object.fromEntries(
    Object.entries(ogImages).filter(([id]) => liveIds.has(id)),
  );

  // ---- 機械翻訳／3行要約で日本語を補完（GEMINI_API_KEY 任意・未設定ならスキップ）----
  // 記事系は summary を3行要約、その他は翻訳。既処理は state.translations から再適用。
  // 生成ロジックを変えたら ENRICH_VERSION を上げる → 旧キャッシュを破棄して作り直す。
  let translations = state.translations ?? {};
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!feedsConfig.translate.disabled && geminiKey) {
    // ロジック更新時のみ、実際に再生成できる（キーがある）ときに旧キャッシュを破棄する。
    if (state.enrichVersion !== ENRICH_VERSION) {
      translations = {};
      console.log(`[translate] enrichVersion 更新 (${state.enrichVersion ?? "なし"} → ${ENRICH_VERSION})・キャッシュ再生成`);
    }
    try {
      const r = await enrichTranslations(items, translations, geminiKey, {
        model: feedsConfig.translate.model,
        batchSize: feedsConfig.translate.batchSize,
        concurrency: feedsConfig.translate.concurrency,
        summarizeSources: feedsConfig.translate.summarizeSources,
        summaryMinLen: feedsConfig.translate.summaryMinLen,
      });
      console.log(
        `[translate] +${r.translated} 翻訳/要約 (試行 ${r.attempted}, バッチ ${r.batches})`,
      );
      state.enrichVersion = ENRICH_VERSION;
    } catch (e) {
      console.error("[translate] エラー（スキップ）:", (e as Error).message);
    }
  } else if (!feedsConfig.translate.disabled) {
    console.log("[translate] GEMINI_API_KEY 未設定（翻訳/要約スキップ）");
  }
  // 現存 item id 分だけ残してキャッシュの無限増殖を防ぐ。
  state.translations = Object.fromEntries(
    Object.entries(translations).filter(([id]) => liveIds.has(id)),
  );

  const out: FeedData = {
    updatedAt: new Date().toISOString(),
    items,
    state,
  };
  writeCache(out);

  const counts = { x: 0, feedly: 0, hatena: 0, layerx: 0, workspace: 0 } as Record<
    FeedSource,
    number
  >;
  for (const i of items) counts[i.source]++;
  const withThumb = items.filter((i) => i.thumbnail).length;
  const withJa = items.filter((i) => i.titleJa).length;
  console.log(
    `\n✅ feed.json 更新: 計 ${items.length} 件 (X=${counts.x} / Feedly=${counts.feedly} / はてブ=${counts.hatena} / LayerX=${counts.layerx} / Workspace=${counts.workspace}) サムネ ${withThumb} 件 / 翻訳 ${withJa} 件`,
  );
  if (errors.length) {
    console.warn(`⚠️  ${errors.length} 件のソースでエラー:\n  - ${errors.join("\n  - ")}`);
  }
}

run().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
