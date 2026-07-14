/**
 * フィード情報源の設定。
 *
 * ★ 実運用前に以下を埋めること:
 *   - x.username : 取得したい X(Twitter) アカウントのユーザー名（@ なし）
 *   - zenn/qiita.rssUrl : 集約したい AI 関連 RSS フィードの URL
 *
 * トークン類（X_*）は .env / GitHub Secrets に置く（このファイルには書かない）。
 * 記事系（Zenn/Qiita/はてブ/Workspace）は公開 RSS を rss-parser で直接取得する
 * （トークン・課金・失効なし）。
 */

import type { FeedSource } from "./src/lib/feed";

export type XCategory = "post" | "like" | "bookmark";

export interface FeedsConfig {
  x: {
    /**
     * basecamp が公開している x-tweets.json の URL。
     * これを読むことで X API・トークン・追加課金が不要になり、
     * basecamp の X feed とトークンが競合しない。
     */
    sourceUrl: string;
    /** 取得対象アカウントのユーザー名（@ なし）。リンク生成・表示に使う */
    username: string;
    /** basecamp公開JSONから取り込むカテゴリ。post=自分の投稿 / like=いいね / bookmark=ブックマーク */
    categories: XCategory[];
    /**
     * 外部アカウントのポスト（@なしのユーザー名の配列）。
     * X API App-only Bearer Token（env: X_BEARER_TOKEN）で取得し、
     * since_id 増分で新着のみ課金（重複課金回避）。
     */
    accounts: string[];
    /** 外部アカウント1件あたり1回に取得する最大件数（5〜100） */
    accountMaxResults: number;
    /** このソースの保持上限件数（newest を残す）。全ソース共通の全期間アーカイブ安全弁（後述 retentionMax）。 */
    retentionMax: number;
    /** true の場合、X取得を完全にスキップ */
    disabled?: boolean;
  };
  /** Zenn「AI」トピックの公開 RSS（rss-parser で直接取得。トークン不要）。 */
  zenn: {
    rssUrl: string;
    /** 1回に取り込む最大件数（取得窓。蓄積は retentionMax まで） */
    limit?: number;
    /** 保持上限件数（全期間アーカイブの安全弁） */
    retentionMax: number;
    disabled?: boolean;
  };
  /** Qiita「AI」タグの公開 RSS（rss-parser で直接取得。トークン不要）。 */
  qiita: {
    rssUrl: string;
    /** 1回に取り込む最大件数（取得窓。蓄積は retentionMax まで） */
    limit?: number;
    /** 保持上限件数（全期間アーカイブの安全弁） */
    retentionMax: number;
    disabled?: boolean;
  };
  /**
   * Google Cloud リリースノートの公開 Atom（rss-parser で直接取得。トークン不要）。
   * 1エントリ=1日で本文にその日の全製品更新がまとまる。scripts/sources/gcloud.ts が
   * 製品名を抽出して見出しにする。
   */
  gcloud: {
    rssUrl: string;
    /** 1回に取り込む最大件数（取得窓。蓄積は retentionMax まで） */
    limit?: number;
    /** 保持上限件数（全期間アーカイブの安全弁） */
    retentionMax: number;
    disabled?: boolean;
  };
  hatena: {
    /** はてなブックマーク 人気エントリー テクノロジー の RSS */
    rssUrl: string;
    /** 保持上限件数（全期間アーカイブの安全弁。後述 retentionMax） */
    retentionMax: number;
    disabled?: boolean;
  };
  workspace: {
    /**
     * Google Workspace Updates ブログ（Blogger 製）の Atom フィード。
     * 既定の /feeds/posts/default は FeedBurner（http）へ 302 するため、
     * `?redirect=false` を付けて Google ドメインから直接 https の Atom を取得する。
     * 公開フィードなのでトークン・課金・失効なし。表示は「Workspace」バッジ。
     */
    rssUrl: string;
    /** 1回に取り込む最大件数（取得窓。蓄積は retentionMax まで） */
    perFeedLimit: number;
    /** 保持上限件数（全期間アーカイブの安全弁） */
    retentionMax: number;
    disabled?: boolean;
  };
  layerx: {
    /**
     * LayerX AI・LLM Newsletter（Substack 発行・毎週 Gmail に届く）の取得設定。
     * Substack の公開 RSS は invite-only のため、Gmail REST API でこの送信元のメールを読む。
     * 認証情報は env / GitHub Secrets（GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN）。
     * いずれか未設定ならこのソースはスキップされる。
     */
    sender: string;
    /** この日数より新しいメールのみ取得（Gmail クエリ newer_than:Nd） */
    newerThanDays: number;
    /** 1回に取得する最大メール数 */
    maxResults: number;
    /** 保持上限件数（全期間アーカイブの安全弁。~190件/通と物量大） */
    retentionMax: number;
    disabled?: boolean;
  };
  translate: {
    /**
     * 集約時の機械翻訳（原文→日本語）。Gemini REST API を使う。
     * 認証は env / GitHub Secrets（GEMINI_API_KEY）。未設定なら翻訳をスキップし、
     * カードは原文のまま表示される（graceful degradation）。
     * 原文が日本語のアイテムは検出して翻訳しない（コスト削減）。
     */
    model: string;
    /** 1回の API 呼び出しで翻訳するアイテム数 */
    batchSize: number;
    /** バッチを並列実行する数 */
    concurrency: number;
    /**
     * 概要を「翻訳」ではなく「生成AIで3行要約」に切り替えるソース。
     * ここに含まれるソースは原文が日本語でも要約する（記事系を想定）。
     * それ以外のソース（X 等）は従来どおり summary を翻訳する。
     */
    summarizeSources: FeedSource[];
    /** この文字数未満の summary は要約せず翻訳扱い（短すぎる抜粋の無駄要約を防ぐ） */
    summaryMinLen: number;
    disabled?: boolean;
  };
}

/**
 * 保持ポリシー（全ソース共通）:
 * 集約は各ソースとも「前回分を土台に蓄積」し、id で重複排除する（全期間アーカイブ）。
 * 年齢による一律トリム（旧 maxAgeDays）は行わず、各ソースの `retentionMax`（newest を残す件数上限）が
 * 唯一の上限＝ソース別枠なので、物量の多いソース（LayerX）が他ソースを押し出さない。
 * feed.json 肥大を抑える安全弁なので、無制限に近づけたいソースは値を大きくする。
 */

export const feedsConfig: FeedsConfig = {
  x: {
    sourceUrl: "https://storage.googleapis.com/basecamp-feeds/x-tweets.json",
    username: "satory074",
    categories: ["bookmark"], // 自分のデータからはブックマークのみ取り込む
    accounts: ["NotebookLM", "claudeai", "itm_aiplus", "OpenAIDevs", "OpenAI", "GeminiApp"], // 外部アカウントのポスト（@なし）。複数可
    accountMaxResults: 20,
    retentionMax: 1000,
    disabled: false,
  },
  zenn: {
    rssUrl: "https://zenn.dev/topics/ai/feed", // Zenn AIトピック
    limit: 20,
    retentionMax: 1000, // 取りこぼしが激しかった主対象。数ヶ月〜相当
    disabled: false,
  },
  qiita: {
    rssUrl: "https://qiita.com/tags/ai/feed", // Qiita AIタグ
    limit: 20,
    retentionMax: 1000, // 取りこぼしが激しかった主対象。数ヶ月〜相当
    disabled: false,
  },
  gcloud: {
    rssUrl: "https://docs.cloud.google.com/feeds/gcp-release-notes.xml", // Google Cloud リリースノート（Atom）
    limit: 30,
    retentionMax: 500, // 低頻度（~1件/日）。~1.4年分
    disabled: false,
  },
  hatena: {
    rssUrl: "https://b.hatena.ne.jp/hotentry/it.rss",
    retentionMax: 1000, // 過去分も保持（実質全期間）。feed.json 肥大を抑える安全弁
    disabled: false,
  },
  workspace: {
    rssUrl: "https://workspaceupdates.googleblog.com/feeds/posts/default?redirect=false",
    perFeedLimit: 15,
    retentionMax: 500, // 低頻度。~1.4年分
    disabled: false,
  },
  layerx: {
    sender: "layerxnews@substack.com",
    newerThanDays: 30,
    maxResults: 20,
    retentionMax: 2000, // ~190件/通と物量大。別枠なので他ソースを押し出さない
    disabled: false,
  },
  translate: {
    // gemini-2.0-flash は 2026-06-01 に提供終了（無料枠撤廃で 429 になる）。
    // 後継の Flash-Lite に切替（無料枠あり・翻訳/簡易処理向け）。memory: todayai-gemini-quota-429。
    model: "gemini-3.1-flash-lite",
    batchSize: 10, // 要約入力に記事本文(~3000字)を載せるので1コールが過大にならないよう小さめ
    concurrency: 3,
    summarizeSources: ["zenn", "qiita", "hatena", "workspace", "gcloud"],
    summaryMinLen: 40,
    disabled: false,
  },
};
