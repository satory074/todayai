/**
 * feed.json の**読み込み**バックエンド。GCS（本番/CI）かローカルファイル（開発）を透過的に切替える。
 *
 * - `GCS_BUCKET` 環境変数があれば GCS の public URL を `fetch`（読みは認証不要）。
 * - 無ければローカル `src/data/feed.json` を読む（従来どおり）。
 * GCS 取得に失敗したら ローカルファイル → fallback の順にデグレードする（ビルドを落とさない）。
 *
 * 書き込みは `scripts/lib/feedWrite.ts`（常にローカルへ書き、GCS 反映はワークフローの
 * `gcloud storage cp`）。読みは `fetch` + `fs` のみで依存が軽く、Astro のビルドグラフ
 * （`src/`）から安全に import できる。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const LOCAL_FILE = path.join(process.cwd(), "src", "data", "feed.json");

/** GCS バケット名（未設定/空ならローカルモード）。 */
function bucket(): string | undefined {
  const b = process.env.GCS_BUCKET?.trim();
  return b || undefined;
}

/** feed.json の公開 URL（GCS）またはローカル file:// パス。 */
export function feedPublicUrl(filename = "feed.json"): string {
  const b = bucket();
  return b ? `https://storage.googleapis.com/${b}/${filename}` : `file://${LOCAL_FILE}`;
}

function readLocal<T>(fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * feed.json を読み込む。`GCS_BUCKET` 設定時は public URL を fetch、未設定ならローカル読み。
 * GCS 取得失敗時は ローカル（あれば）→ fallback の順にデグレード。
 *
 * `bust` を渡すと URL に `?t=` を付ける＝**書き込み直後の読み取り**で古いエッジキャッシュ
 * （`Cache-Control: max-age=300`）を避ける。集約→GCS書き込みと同じ run のビルドが
 * 最新を確実に読むために使う（`GITHUB_RUN_ID` を渡す想定）。
 */
export async function readFeed<T>(
  fallback: T,
  opts: { filename?: string; bust?: string } = {},
): Promise<T> {
  const filename = opts.filename ?? "feed.json";
  const b = bucket();
  if (b) {
    try {
      const bust = opts.bust ? `?t=${encodeURIComponent(opts.bust)}` : "";
      const res = await fetch(`https://storage.googleapis.com/${b}/${filename}${bust}`, {
        cache: "no-store",
      });
      if (res.status === 404) return readLocal(fallback); // 未シードならローカルへ
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch {
      return readLocal(fallback); // GCS 障害時はローカルへフォールバック（ビルドを落とさない）
    }
  }
  return readLocal(fallback);
}
