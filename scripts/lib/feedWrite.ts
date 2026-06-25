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

const LOCAL_FILE = path.join(process.cwd(), "src", "data", "feed.json");

/** feed.json をローカルに保存する（GCS への反映はワークフローの gcloud cp が行う）。 */
export async function writeFeed(data: unknown, filename = "feed.json"): Promise<void> {
  const target = filename === "feed.json" ? LOCAL_FILE : path.join(path.dirname(LOCAL_FILE), filename);
  const body = JSON.stringify(data, null, 2) + "\n";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  console.log(`[store] ローカル書き込み: ${target} (${body.length} bytes)`);
}
