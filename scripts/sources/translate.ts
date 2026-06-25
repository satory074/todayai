/**
 * 機械翻訳／生成AI要約によるアイテム本文の日本語補完。
 *
 * enrichArticles.ts と同じ「state に永続キャッシュ・毎回アイテムへ再適用・トリム後の
 * 最終アイテムだけ対象・未確認のみ API」パターン。X bookmark / feedly 等は毎回
 * フレッシュ取得され titleJa/summaryJa を失うが、transCache（state.translations）から
 * 再適用するので再生成しない。
 *
 * - title: 原文が非日本語なら自然な日本語に翻訳（titleJa）。日本語ならスキップ。
 * - summary: `summarizeSources`（記事系）は原文の言語によらず **3行要約**（summaryJa）。
 *   それ以外（X 等）は従来どおり summary を翻訳（非日本語のときのみ）。
 *
 * Gemini REST API（generateContent）を fetch のみで叩く（layerx.ts と同方式・依存追加なし）。
 * responseMimeType=application/json + responseSchema で配列 JSON を堅牢に受け取る。
 * バッチ失敗（network / parse / 件数不一致）はそのバッチをスキップし run 全体は落とさない。
 */
import type { FeedItem, FeedSource } from "../../src/lib/feed";
import { mapLimit } from "./util";

export interface TranslateOptions {
  model: string;
  batchSize: number;
  concurrency: number;
  /** 概要を翻訳ではなく3行要約にするソース（記事系）。 */
  summarizeSources: FeedSource[];
  /** この文字数未満の summary は要約せず翻訳扱い。 */
  summaryMinLen: number;
}

export interface TranslateResult {
  /** 今回新たに翻訳できた件数 */
  translated: number;
  /** 今回 API 翻訳を試みた件数 */
  attempted: number;
  /** 実行したバッチ数 */
  batches: number;
}

/** かな・カタカナ・漢字を含めば日本語とみなす（翻訳不要）。 */
export function isJapanese(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(text);
}

interface TransCacheEntry {
  titleJa?: string;
  summaryJa?: string;
}

/** 翻訳/要約の対象アイテムと、要約/翻訳の入力テキスト・処理種別。 */
interface Target {
  item: FeedItem;
  /** true=入力を3行要約 / false=入力を翻訳 */
  summarize: boolean;
  /** 処理対象テキスト。要約=本文(contentText)優先・翻訳=summary（抜粋） */
  input: string;
}

/**
 * `items` のうち翻訳/要約が必要な（キャッシュ無し）ものを Gemini で日本語化する。
 * transCache を参照して既知分は流用、未確認のみ処理する。transCache は破壊的に更新される
 * （呼び出し側で state に保存する）。
 */
export async function enrichTranslations(
  items: FeedItem[],
  transCache: Record<string, TransCacheEntry>,
  apiKey: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const summSet = new Set(opts.summarizeSources);

  // 対象: キャッシュ済みは流用、必要な処理（title翻訳 / summary要約 or 翻訳）があるものだけ。
  const targets: Target[] = [];
  for (const item of items) {
    const cached = transCache[item.id];
    if (cached) {
      if (cached.titleJa) item.titleJa = cached.titleJa; // 既知の翻訳/要約を流用
      if (cached.summaryJa) item.summaryJa = cached.summaryJa;
      continue;
    }
    const summary = item.summary?.trim() ?? "";
    // 要約は記事本文（enrichArticles が付ける contentText）を優先、無ければ抜粋。
    const body = item.contentText?.trim() || summary;
    const isSummSrc = summSet.has(item.source);
    // 記事系 & 十分な長さの本文/抜粋 → 3行要約（日本語記事も対象）。その他 → 翻訳。
    const summarize = isSummSrc && body.length >= opts.summaryMinLen;
    const needTitle = !!item.title && !isJapanese(item.title);
    const needSummary = summarize || (summary.length > 0 && !isJapanese(summary));
    if (!needTitle && !needSummary) continue;
    targets.push({ item, summarize, input: summarize ? body : summary });
  }

  // バッチに分割
  const batches: Target[][] = [];
  for (let i = 0; i < targets.length; i += opts.batchSize) {
    batches.push(targets.slice(i, i + opts.batchSize));
  }

  let translated = 0;
  await mapLimit(batches, opts.concurrency, async (batch) => {
    const out = await translateBatch(batch, apiKey, opts.model);
    if (!out) return; // バッチ失敗 → 次回 run で再試行
    for (let i = 0; i < batch.length; i++) {
      const { item } = batch[i];
      const t = out[i];
      if (!t) continue;
      const titleJa = t.titleJa?.trim() || undefined; // 原文が日本語なら空文字で返る
      const summaryJa = t.summaryJa?.trim() || undefined;
      if (!titleJa && !summaryJa) continue;
      if (titleJa) item.titleJa = titleJa;
      if (summaryJa) item.summaryJa = summaryJa;
      transCache[item.id] = { titleJa, summaryJa };
      translated++;
    }
  });

  return { translated, attempted: targets.length, batches: batches.length };
}

interface BatchTranslation {
  titleJa: string;
  summaryJa?: string;
}

/** 1バッチを Gemini で翻訳/要約。失敗時は null（呼び出し側でスキップ）。 */
async function translateBatch(
  batch: Target[],
  apiKey: string,
  model: string,
): Promise<BatchTranslation[] | null> {
  const entries = batch.map(({ item, summarize, input }, i) => ({
    i,
    title: item.title ?? "",
    body: input,
    summarize,
  }));

  const prompt =
    "次の配列の各エントリを処理し、{titleJa, summaryJa} を返してください。\n" +
    "・titleJa: title を自然な日本語に翻訳。title が既に日本語ならそのまま、訳す必要が無ければ空文字。\n" +
    "・summaryJa:\n" +
    "    summarize が true → body（記事本文）の要点を一読でつかめる日本語の要約にする:\n" +
    "      - 最重要の要点を結論から1つ書く。複数トピックの記事でも要点を1〜2点に絞り、網羅的に列挙しない。\n" +
    "      - 前置き・宣伝文句・筆者の感想は省き、事実だけを書く。タイトルの言い換えで終わらせない。\n" +
    "      - 最大2文・100字以内。やさしい言葉と短い文で必ず言い切る。本文に無い情報は足さない。\n" +
    "    summarize が false → body を自然な日本語に翻訳（body が空文字なら空文字）。\n" +
    "技術用語・製品名・固有名詞は無理に訳さず一般的な表記を使い、意味を保ってください。\n" +
    "入力と同じ順序・同じ件数で、各要素 {titleJa, summaryJa} の JSON 配列のみを返してください。\n\n" +
    JSON.stringify(entries);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            titleJa: { type: "STRING" },
            summaryJa: { type: "STRING" },
          },
          required: ["titleJa"],
        },
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[translate] Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as BatchTranslation[];
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      console.error(
        `[translate] 件数不一致（in ${batch.length} / out ${Array.isArray(parsed) ? parsed.length : "?"}）`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    console.error("[translate] バッチ失敗:", (e as Error).message);
    return null;
  }
}
