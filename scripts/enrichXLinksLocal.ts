/**
 * X ツイートのリンクプレビューをローカルで補完する単体スクリプト（`npm run enrich:xlinks`）。
 *
 * 通常の集約（aggregate.ts）は CI でも既定でリンクプレビューを解決する（外部サイトは多くが
 * datacenter IP でも取れる。LayerX と違い Substack 壁を通らない）。ただし 1run あたり
 * `X_LINK_MAX_NEW`(既定40) の上限があり、一部の外部サイトは Cloudflare 等で 403 になり得る。
 * このスクリプトはその **バックフィル / stragglers 用の安全網**。
 *
 * **他ソースを再取得せず**、いまコミットされている `src/data/feed.json` の X 項目に
 * リンクプレビュー（画像＋タイトル＋説明＋ドメイン）だけを足して上書きする。トークン不要。
 * `state.xLinkCards` の負キャッシュ（null）で取得済みはスキップ。※日本語訳は付かない（翻訳は
 * aggregate の Gemini ステップが担当。ここで足した原文カードは次回 aggregate で翻訳される）。
 *
 * 運用:
 *   git pull                # 最新 feed.json を取得
 *   npm run enrich:xlinks   # X 項目にリンクプレビューを補完（数百件は数回に分けて段階的に）
 *   git add src/data/feed.json && git commit -m "chore: x link previews" && git push
 *
 *   npm run enrich:xlinks -- --fresh
 *     負キャッシュ（null＝確認済みカードなし）を一掃して未補完分を再試行する。CI の 403 で
 *     誤って負キャッシュされた分（false negative）をやり直したいときに使う。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { FeedData, XLinkCard } from "../src/lib/feed";
import { enrichXLinks } from "./sources/xLinkCard";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "src", "data", "feed.json");

/** 1回に解決を試みる X の最大件数（rate-limit 配慮。数回回せば全件カバー）。 */
const MAX_NEW = 300;

async function main(): Promise<void> {
  const fresh = process.argv.includes("--fresh");

  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const data = JSON.parse(raw) as FeedData;
  data.state = data.state ?? {};
  const cache: Record<string, XLinkCard | null> = data.state.xLinkCards ?? {};

  // --fresh: 負キャッシュ（null）を一掃して未補完分を再試行（CI 403 の false negative 対策）。
  if (fresh) {
    let cleared = 0;
    for (const [id, v] of Object.entries(cache)) {
      if (v === null) {
        delete cache[id];
        cleared++;
      }
    }
    console.log(`[xlink-local] --fresh: 負キャッシュ ${cleared} 件を一掃`);
  }

  const xTotal = data.items.filter((i) => i.source === "x").length;
  const before = data.items.filter((i) => i.source === "x" && i.linkPreview).length;

  const r = await enrichXLinks(data.items, cache, { maxNew: MAX_NEW, concurrency: 5 });

  // 現存 item id 分だけ残して負キャッシュの無限増殖を防ぐ（aggregate.ts と同様）。
  const liveIds = new Set(data.items.map((i) => i.id));
  data.state.xLinkCards = Object.fromEntries(
    Object.entries(cache).filter(([id]) => liveIds.has(id)),
  );

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");

  const after = data.items.filter((i) => i.source === "x" && i.linkPreview).length;
  console.log(
    `[xlink-local] +${r.resolved} 件解決 (試行 ${r.attempted}) / X リンクプレビュー ${before} → ${after} / X ${xTotal} 件`,
  );
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
