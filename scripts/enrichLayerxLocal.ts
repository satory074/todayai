/**
 * LayerX サムネをローカルで補完する単体スクリプト（`npm run enrich:layerx`）。
 *
 * なぜ単体か: 通常の集約（aggregate.ts）の LayerX サムネ補完は CI で動かない。全リンクが
 * 通る `substack.com/redirect` が Cloudflare に datacenter IP を 403 で弾かれるため
 * （memory: todayai-gemini-quota-429 参照）。一方 residential IP（手元）なら ~70% 解決できる。
 *
 * このスクリプトは **他ソースを再取得せず**、いまコミットされている `src/data/feed.json` の
 * LayerX 項目にサムネ（ツイートのメディア or リンク先 og:image）だけを足して上書きする。
 * トークン不要（Gmail/Gemini/X 不要）。`state.ogImages` の負キャッシュで取得済みはスキップ。
 *
 * 運用:
 *   git pull               # CI 生成の最新 feed.json を取得
 *   npm run enrich:layerx  # LayerX 項目にサムネを補完（数百件は数回に分けて段階的に）
 *   git add src/data/feed.json && git commit -m "chore: layerx thumbs" && git push
 *
 *   npm run enrich:layerx -- --fresh
 *     負キャッシュ（""＝確認済み画像なし）を一掃して未補完分を再試行する。CI の 403 で
 *     誤って負キャッシュされた分（false negative）をやり直したいときに使う。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { FeedData } from "../src/lib/feed";
import { enrichLayerxThumbs } from "./sources/layerxThumb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "src", "data", "feed.json");

/** 1回に解決を試みる LayerX の最大件数（rate-limit 配慮。数回回せば全件カバー）。 */
const MAX_NEW = 200;

async function main(): Promise<void> {
  const fresh = process.argv.includes("--fresh");

  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const data = JSON.parse(raw) as FeedData;
  data.state = data.state ?? {};
  const ogImages = data.state.ogImages ?? {};

  // --fresh: LayerX の負キャッシュ（""）を一掃して未補完分を再試行（CI 403 の false negative 対策）。
  if (fresh) {
    let cleared = 0;
    for (const [id, v] of Object.entries(ogImages)) {
      if (id.startsWith("layerx-") && v === "") {
        delete ogImages[id];
        cleared++;
      }
    }
    console.log(`[layerx-local] --fresh: 負キャッシュ ${cleared} 件を一掃`);
  }

  const layerxTotal = data.items.filter((i) => i.source === "layerx").length;
  const before = data.items.filter((i) => i.source === "layerx" && i.thumbnail).length;

  const r = await enrichLayerxThumbs(data.items, ogImages, { maxNew: MAX_NEW, concurrency: 4 });

  // 現存 item id 分だけ残して負キャッシュの無限増殖を防ぐ（aggregate.ts と同様）。
  const liveIds = new Set(data.items.map((i) => i.id));
  data.state.ogImages = Object.fromEntries(
    Object.entries(ogImages).filter(([id]) => liveIds.has(id)),
  );

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");

  const after = data.items.filter((i) => i.source === "layerx" && i.thumbnail).length;
  const remaining = layerxTotal - after;
  console.log(
    `[layerx-local] +${r.resolved} 件解決 (試行 ${r.attempted}) / LayerXサムネ ${before} → ${after} / ${layerxTotal} 件` +
      (remaining > 0 ? `（未補完 ${remaining} 件・もう一度 npm run enrich:layerx で続き）` : "（全件補完済み）"),
  );
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
