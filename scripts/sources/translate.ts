/**
 * 機械翻訳によるアイテム本文の日本語補完（原文→日本語）。
 *
 * enrichOgp.ts と同じ「state に永続キャッシュ・毎回アイテムへ再適用・トリム後の
 * 最終アイテムだけ対象・未確認のみ API」パターン。X bookmark / feedly 等は毎回
 * フレッシュ取得され titleJa を失うが、transCache（state.translations）から再適用
 * するので再翻訳しない。原文が日本語のアイテムは検出してスキップ（コスト削減）。
 *
 * Gemini REST API（generateContent）を fetch のみで叩く（layerx.ts と同方式・依存追加なし）。
 * responseMimeType=application/json + responseSchema で配列 JSON を堅牢に受け取る。
 * バッチ失敗（network / parse / 件数不一致）はそのバッチをスキップし run 全体は落とさない。
 */
import type { FeedItem } from "../../src/lib/feed";
import { mapLimit } from "./util";

export interface TranslateOptions {
  model: string;
  batchSize: number;
  concurrency: number;
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
  titleJa: string;
  summaryJa?: string;
}

/**
 * `items` のうち翻訳が必要な（キャッシュ無し & 原文が日本語でない）ものを Gemini で日本語化する。
 * transCache を参照して既知分は流用、未確認のみ翻訳する。transCache は破壊的に更新される
 * （呼び出し側で state に保存する）。
 */
export async function enrichTranslations(
  items: FeedItem[],
  transCache: Record<string, TransCacheEntry>,
  apiKey: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  // 対象: キャッシュ済みは流用、原文が日本語ならスキップ、それ以外を翻訳対象に。
  const targets: FeedItem[] = [];
  for (const item of items) {
    const cached = transCache[item.id];
    if (cached) {
      item.titleJa = cached.titleJa; // 既知の翻訳を流用
      if (cached.summaryJa) item.summaryJa = cached.summaryJa;
      continue;
    }
    // タイトル・要約のどちらかに非日本語があれば翻訳対象。両方とも日本語ならスキップ。
    const needsTitle = item.title && !isJapanese(item.title);
    const needsSummary = item.summary && !isJapanese(item.summary);
    if (!needsTitle && !needsSummary) continue;
    targets.push(item);
  }

  // バッチに分割
  const batches: FeedItem[][] = [];
  for (let i = 0; i < targets.length; i += opts.batchSize) {
    batches.push(targets.slice(i, i + opts.batchSize));
  }

  let translated = 0;
  await mapLimit(batches, opts.concurrency, async (batch) => {
    const out = await translateBatch(batch, apiKey, opts.model);
    if (!out) return; // バッチ失敗 → 次回 run で再試行
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const t = out[i];
      if (!t || !t.titleJa) continue;
      item.titleJa = t.titleJa;
      if (t.summaryJa) item.summaryJa = t.summaryJa;
      transCache[item.id] = { titleJa: t.titleJa, summaryJa: t.summaryJa || undefined };
      translated++;
    }
  });

  return { translated, attempted: targets.length, batches: batches.length };
}

interface BatchTranslation {
  titleJa: string;
  summaryJa?: string;
}

/** 1バッチを Gemini で翻訳。失敗時は null（呼び出し側でスキップ）。 */
async function translateBatch(
  batch: FeedItem[],
  apiKey: string,
  model: string,
): Promise<BatchTranslation[] | null> {
  const input = batch.map((it, i) => ({
    i,
    title: it.title ?? "",
    summary: it.summary ?? "",
  }));

  const prompt =
    "次の配列の各エントリの title と summary を自然な日本語に翻訳してください。\n" +
    "技術用語・製品名・固有名詞は無理に訳さず一般的な表記を使い、意味を保ってください。\n" +
    "summary が空文字の場合は summaryJa も空文字にしてください。\n" +
    "入力と同じ順序・同じ件数で、各要素 {titleJa, summaryJa} の JSON 配列のみを返してください。\n\n" +
    JSON.stringify(input);

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
