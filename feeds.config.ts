/**
 * フィード情報源の設定。
 *
 * ★ 実運用前に以下を埋めること:
 *   - x.username     : 取得したい X(Twitter) アカウントのユーザー名（@ なし）
 *   - feedly.rssUrls : 集約したい AI 関連 RSS フィードの URL 一覧
 *
 * トークン類（X_*）は .env / GitHub Secrets に置く（このファイルには書かない）。
 * Feedly は API トークンが現在 Enterprise プラン限定のため使わず、フォルダ相当の
 * 各 RSS を直接取得する方式に変更（トークン不要）。
 */

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
    /** true の場合、X取得を完全にスキップ */
    disabled?: boolean;
  };
  feedly: {
    /**
     * 直接取得する RSS フィードの URL 一覧（Feedly API の代替）。
     * Feedly の開発者トークンは現在 Enterprise プラン限定で個人利用できないため、
     * Feedly フォルダに入れていた各 RSS を rss-parser で直接取得する。
     * トークン・課金・失効なし。表示は従来どおり「Feedly」バッジ。
     */
    rssUrls: string[];
    /** 1フィードあたり取り込む最大件数（1ソースの占有を防ぐ） */
    perFeedLimit: number;
    disabled?: boolean;
  };
  hatena: {
    /** はてなブックマーク 人気エントリー テクノロジー の RSS */
    rssUrl: string;
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
    /** 1回に取り込む最大件数（1ソースの占有を防ぐ） */
    perFeedLimit: number;
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
    disabled?: boolean;
  };
  /** 集約後、保持する最大件数 */
  maxItems: number;
  /** 集約後、この日数より古いアイテムは捨てる */
  maxAgeDays: number;
}

export const feedsConfig: FeedsConfig = {
  x: {
    sourceUrl: "https://storage.googleapis.com/basecamp-feeds/x-tweets.json",
    username: "satory074",
    categories: ["bookmark"], // 自分のデータからはブックマークのみ取り込む
    accounts: ["NotebookLM"], // 外部アカウントのポスト（@なし）。複数可
    accountMaxResults: 20,
    disabled: false,
  },
  feedly: {
    // AI 関連 RSS（Feedly フォルダ相当）。@なしのトークン不要・課金不要・失効なし。
    rssUrls: [
      "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", // ITmedia AI＋
      "https://www.techno-edge.net/rss20/index.rdf", // テクノエッジ TechnoEdge
      "https://note.com/npaka/rss", // npaka（AI/LLM）
      "https://ainow.ai/feed", // AINOW
      "https://zenn.dev/topics/ai/feed", // Zenn AIトピック
      "https://qiita.com/tags/ai/feed", // Qiita AIタグ
      "https://tech.algomatic.jp/feed", // Algomatic Tech Blog
      "https://www.publickey1.jp/atom.xml", // Publickey
    ],
    perFeedLimit: 15,
    disabled: false,
  },
  hatena: {
    rssUrl: "https://b.hatena.ne.jp/hotentry/it.rss",
    disabled: false,
  },
  workspace: {
    rssUrl: "https://workspaceupdates.googleblog.com/feeds/posts/default?redirect=false",
    perFeedLimit: 15,
    disabled: false,
  },
  layerx: {
    sender: "layerxnews@substack.com",
    newerThanDays: 30,
    maxResults: 20,
    disabled: false,
  },
  translate: {
    model: "gemini-2.0-flash",
    batchSize: 20,
    concurrency: 3,
    disabled: false,
  },
  maxItems: 1000, // LayerX は1通あたり ~190 トピックを個別取り込みするため大きめ
  maxAgeDays: 30,
};
