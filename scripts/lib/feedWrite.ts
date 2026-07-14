/**
 * feed.json の**書き込み**バックエンド。常にローカル `src/data/feed.json` に書く。
 *
 * GCS モードでも aggregate はローカルへ書き、**GCS へのアップロードはワークフローの
 * `gcloud storage cp` ステップ**が担う（`.github/workflows/update-and-deploy.yml`）。
 * これは @google-cloud/storage SDK の WIF→STS トークン交換が CI の node-fetch 経路で
 * `ERR_STREAM_PREMATURE_CLOSE` を起こすため＝SDK を使わず、runner プリインストールの
 * gcloud（ADC を native に解決）でアップロードする方が堅牢、という判断。
 * 読み込みは `src/lib/feedStore.ts` の `readFeed`（GCS は public URL を fetch・認証不要）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { stripLoneSurrogates } from "../sources/util";

const LOCAL_FILE = path.join(process.cwd(), "src", "data", "feed.json");

/** feed.json をローカルに保存する（GCS への反映はワークフローの gcloud cp が行う）。 */
export async function writeFeed(data: unknown, filename = "feed.json"): Promise<void> {
  const target = filename === "feed.json" ? LOCAL_FILE : path.join(path.dirname(LOCAL_FILE), filename);
  // 単独サロゲート（絵文字を分断した切り詰め等の名残）を全文字列から除去してから書く。
  // 混入すると jq 等の厳格なパーサが feed.json 全体を不正 JSON として拒否する。
  const body =
    JSON.stringify(data, (_key, v) => (typeof v === "string" ? stripLoneSurrogates(v) : v), 2) + "\n";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  console.log(`[store] ローカル書き込み: ${target} (${body.length} bytes)`);
}
