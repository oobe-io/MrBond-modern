/**
 * Mr.Bond 互換の CSV 出力フォーマッタ。
 *
 * 参照実装: MRBOND/Runge.c PLO()
 * 実出力例（MRBOND/CSV_files/test1.csv 冒頭）:
 *   TIME         , DP2
 *   0.000000e+00, 0.000000e+00
 *   1.000000e-02, 4.982960e-05
 *   ...
 *
 * 書式の要点:
 * - ヘッダ: 先頭 "TIME         ," 次いで各ラベル
 *   - 最後のラベルは先頭にスペース1つ付く、カンマで区切り、末尾はなし
 * - データ行: 時刻、次いで各出力変数値
 *   - 各値は C の `%e`（小数6桁、2桁以上のゼロ埋め指数、符号付き）
 *   - 正値は先頭にスペース1つ、負値はスペースなし（Runge.cの挙動）
 *   - カンマ区切り、最終値の後に区切りなし
 */

/**
 * C の %e 書式に一致する指数表記文字列を生成する。
 *   - 小数部は 6 桁固定
 *   - 仮数部は 1 桁整数部（0 は 0.000000e+00）
 *   - 指数は符号付き、2 桁以上のゼロ埋め
 */
export function formatExponential(value: number, precision = 6): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`formatExponential: non-finite value ${value}`);
  }
  // JavaScript の toExponential は指数が1桁でもそのまま返す ("1.000000e-5" 等)
  // C は常に2桁以上のゼロ埋め "1.000000e-05" なので補正する
  const jsFormat = value.toExponential(precision);
  const match = /^(-?\d+\.\d+)e([+-])(\d+)$/.exec(jsFormat);
  if (!match) {
    throw new Error(`unexpected exponential format: ${jsFormat}`);
  }
  const [, mantissa, sign, expDigits] = match;
  const paddedExp = expDigits!.length === 1 ? `0${expDigits}` : expDigits;
  return `${mantissa}e${sign}${paddedExp}`;
}

export interface CsvOutputOptions {
  /** ヘッダの "TIME" 列名後の空白数。Runge.cは 9 空白（"TIME         "）。 */
  readonly timeColumnPaddingSpaces?: number;
}

const DEFAULT_TIME_PADDING = 9;

/**
 * Mr.Bond のヘッダ行を生成する。
 *   "TIME         , LABEL1, LABEL2, ..., LAST_LABEL"
 *
 * 最後のラベルの前にだけスペースが入る点に注意（Runge.c の挙動）。
 */
export function formatHeader(labels: readonly string[], options: CsvOutputOptions = {}): string {
  const pad = options.timeColumnPaddingSpaces ?? DEFAULT_TIME_PADDING;
  const timeField = `TIME${' '.repeat(pad)},`;

  if (labels.length === 0) return timeField;

  const parts: string[] = [timeField];
  for (let i = 0; i < labels.length; i++) {
    const isLast = i === labels.length - 1;
    if (isLast) {
      parts.push(` ${labels[i]!}`);
    } else {
      parts.push(`${labels[i]!},`);
    }
  }
  return parts.join('');
}

/**
 * データ行を1行分生成する。
 *   "<time>,<val1>, <val2>, ..., <valN>"
 * 正値の前のみスペースが入る（C の " %e" vs "%e"）。
 */
export function formatRow(time: number, values: readonly number[]): string {
  const parts: string[] = [`${formatExponential(time)},`];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const isLast = i === values.length - 1;
    const formatted = formatExponential(v);
    const leadingSpace = v >= 0 ? ' ' : '';
    if (isLast) {
      parts.push(`${leadingSpace}${formatted}`);
    } else {
      parts.push(`${leadingSpace}${formatted},`);
    }
  }
  return parts.join('');
}

/**
 * 完全な CSV 文字列を生成する（ヘッダ + 行 × N）。
 * 行末は Runge.c の動作に合わせて "\n"（LF）とする。
 */
export function formatCsv(
  labels: readonly string[],
  rows: readonly { time: number; values: readonly number[] }[],
  options: CsvOutputOptions = {},
): string {
  const lines: string[] = [formatHeader(labels, options)];
  for (const row of rows) {
    lines.push(formatRow(row.time, row.values));
  }
  return lines.join('\n') + '\n';
}
