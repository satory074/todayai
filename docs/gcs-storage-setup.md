# GCS storage モードのセットアップ

`feed.json` を git にコミットする代わりに **Google Cloud Storage（GCS）を正本**にするモード。
有効化するまでコードは**従来どおり**（ローカルファイル＋コミット）動く＝下記を実施して初めて切替わる。

仕組みは `src/lib/feedStore.ts`（読み）/ `scripts/lib/feedWrite.ts`（書き）。ワークフローの
全 GCS ステップは **`vars.GCS_BUCKET` が空なら無効**（後方互換）。

## 1. GCP リソース作成（gcloud。`PROJECT` は basecamp と同じでも別でも可）

```bash
PROJECT=basecamp-satory074            # 既存の WIF プールがある project を流用
BUCKET=todayai-feeds                  # 新設する専用バケット
SA=gha-todayai-writer                 # 新設する専用サービスアカウント
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
# 既存 WIF プール（basecamp の update-*-feed.yml と同じ。project number 130346180231）
WIF_PROVIDER="projects/130346180231/locations/global/workloadIdentityPools/github-pool/providers/github"

# バケット（uniform bucket-level access）＋ public 読み取り
gcloud storage buckets create "gs://${BUCKET}" --project="${PROJECT}" --location=US --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member=allUsers --role=roles/storage.objectViewer

# 書き込み用 SA ＋ バケットへの書き込み権限
gcloud iam service-accounts create "${SA}" --project="${PROJECT}" --display-name="GHA todayai feed writer"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin

# GitHub Actions（satory074/todayai リポジトリ）が SA を借用できるよう WIF バインド
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --project="${PROJECT}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/130346180231/locations/global/workloadIdentityPools/github-pool/attribute.repository/satory074/todayai"
```

> 注: 既存の WIF プロバイダの attribute mapping が `attribute.repository = assertion.repository`
> であること（basecamp と同じ google-github-actions 構成なら満たす）。別 project に分離したい
> 場合は pool/provider も新規作成し、`WIF_PROVIDER` を差し替える。

## 2. GitHub リポジトリ変数（Secrets ではなく **Variables**）

`Settings → Secrets and variables → Actions → Variables` に3つ追加:

| 変数 | 値 |
| --- | --- |
| `GCS_BUCKET` | `todayai-feeds` |
| `GCP_WIF_PROVIDER` | `projects/130346180231/locations/global/workloadIdentityPools/github-pool/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `gha-todayai-writer@basecamp-satory074.iam.gserviceaccount.com` |

これだけでワークフローが GCS モードに切替わる（コードの再デプロイ不要・次の cron / 手動実行から）。

## 3. 初回シード

`workflow_dispatch` で1回手動実行する。GCS に `feed.json` が無い初回は `readFeed` が
committed `src/data/feed.json` を種に読み、マージ結果を `gs://todayai-feeds/feed.json` に書く。
以降は GCS が正本。確認:

```bash
curl -s "https://storage.googleapis.com/todayai-feeds/feed.json" | jq '.items|length, .updatedAt'
```

## ローカルで GCS に書きたいとき（任意）

```bash
gcloud auth application-default login          # ADC を用意
GCS_BUCKET=todayai-feeds npm run aggregate      # GCS へ書く（未設定ならローカルファイルのまま）
```

## ロールバック

GitHub Variables の `GCS_BUCKET` を削除（空に）するだけで、次回 run から従来のローカルファイル
＋コミット運用に戻る（コード変更不要）。committed `src/data/feed.json` が常にフォールバックとして
残っているのでサイトは壊れない。
