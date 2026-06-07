/**
 * フィード情報源の設定。
 *
 * ★ 実運用前に以下を埋めること:
 *   - x.username       : 取得したい X(Twitter) アカウントのユーザー名（@ なし）
 *   - feedly.streamId  : Feedly カテゴリ(フォルダ)の streamId
 *                        形式: "user/<userId>/category/<categoryName>"
 *                        取得方法は README.md 参照
 *
 * トークン類（X_*, FEEDLY_API_TOKEN）は .env / GitHub Secrets に置く（このファイルには書かない）。
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
    /** "user/<userId>/category/<categoryName>" 形式の streamId */
    streamId: string;
    /** 1回に取得する記事数 */
    count: number;
    disabled?: boolean;
  };
  hatena: {
    /** はてなブックマーク 人気エントリー テクノロジー の RSS */
    rssUrl: string;
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
    streamId:
      "user/25e9a004-74fc-4204-9c66-0e1687f69f73/category/fcda305b-0f50-44d9-a1da-689b3d1fe43a",
    count: 30,
    disabled: false,
  },
  hatena: {
    rssUrl: "https://b.hatena.ne.jp/hotentry/it.rss",
    disabled: false,
  },
  maxItems: 200,
  maxAgeDays: 30,
};
