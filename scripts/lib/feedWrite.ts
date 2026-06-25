/**
 * feed.json の**書き込み**バックエンド。`GCS_BUCKET` 設定時は @google-cloud/storage SDK で PUT
 * （public-read 前提・`Cache-Control` 付与・ADC 認証＝CI は `google-github-actions/auth` が用意）、
 * 未設定ならローカル `src/data/feed.json` に書く（従来どおり）。
 *
 * SDK は **dynamic import**（GCS モードのときだけ読み込む）＝ローカル実行に SDK 不要。
 * このモジュールは **scripts からのみ** import する（Astro のビルドグラフに SDK を持ち込まない）。
 * 読み込みは `src/lib/feedStore.ts` の `readFeed`（SDK 不要・src/scripts 両用）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const LOCAL_FILE = path.join(process.cwd(), "src", "data", "feed.json");
// 読み（feedStore.readFeed）と揃える。書き込み直後はビルドが ?t= でキャッシュを跨ぐ。
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

/** feed.json を保存する。GCS_BUCKET 設定時は GCS、未設定ならローカルファイル。 */
export async function writeFeed(data: unknown, filename = "feed.json"): Promise<void> {
  const body = JSON.stringify(data, null, 2) + "\n";
  const bucket = process.env.GCS_BUCKET?.trim();
  if (bucket) {
    const { Storage } = await import("@google-cloud/storage");
    await new Storage().bucket(bucket).file(filename).save(body, {
      contentType: "application/json; charset=utf-8",
      metadata: { cacheControl: CACHE_CONTROL },
      resumable: false,
    });
    console.log(`[store] GCS 書き込み: gs://${bucket}/${filename} (${body.length} bytes)`);
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, body);
  console.log(`[store] ローカル書き込み: ${LOCAL_FILE} (${body.length} bytes)`);
}
