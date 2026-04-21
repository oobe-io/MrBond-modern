/**
 * シミュレーション実行ランタイム（Mr.Bond の main() 相当）。
 *
 * 参照実装: MRBOND/Runge.c main()、MRBOND/Runge.f PROGRAM
 *
 * Mr.Bond の main() は以下のフロー:
 *   1. OFILE()  -  temp.PAR を開く、temp.csv を開く
 *   2. PARM()   -  temp.PAR から設定読み込み（→ parsePar で代替）
 *   3. INIT()   -  SOLV(T, X) 1回呼び出し
 *   4. DOUT()   -  OP を埋める
 *   5. PLO(0)   -  ヘッダ + 初期値を CSV に書く
 *   6. ループ:
 *        RUNGE()                 -  1 RK-Gill ステップ進める
 *        サンプリング条件成立時: DOUT() → PLO(j)
 *   7. CFILE()  -  ファイルを閉じる
 *
 * この TypeScript 版は DerivFn + DoutFn + ParFile を受け取り、CSV 文字列を返す。
 * ファイル I/O は呼び出し側の責任。
 */

import { rungeKuttaGillStep, type DerivFn, type ConstraintFn } from '../solver/rungeKuttaGill.ts';
import { formatCsv } from '../output/csvWriter.ts';
import type { ParFile } from '../parser/parFile.ts';

export type DoutFn = (x: readonly number[], op: number[]) => void;

export interface RunOptions {
  readonly par: ParFile;
  readonly func: DerivFn;
  readonly dout: DoutFn;
  readonly solv?: ConstraintFn;
  /** 出力ラベル（PAR.labels が空の時のフォールバック） */
  readonly fallbackLabels?: readonly string[];
}

export interface RunResult {
  readonly csv: string;
  readonly finalState: readonly number[];
  readonly finalTime: number;
  readonly rowCount: number;
}

/**
 * Runge.c の main() と PLO() を一体でシミュレートする。
 *
 * サンプリングロジックは Runge.c の QUOTIENT/ODD/CONSTVALUE の2重ループを
 * 単純化した等価版を使う:
 *   total_steps = round((T1-T0) / TI)
 *   conum = round(total_steps / NOT)
 *   ステップ毎に count をインクリメント、count === conum で出力
 */
export function runSimulation(options: RunOptions): RunResult {
  const { par, func, dout, solv, fallbackLabels } = options;
  const totalStates = par.NS + par.ING;
  const x: number[] = new Array(totalStates).fill(0);
  // 初期値適用（ST レコード）
  for (const [idx, val] of par.stateInit) {
    if (idx >= 0 && idx < totalStates) {
      x[idx] = val;
    }
  }

  const op: number[] = new Array(par.NOUT).fill(0);

  let t = par.T0;
  const h = par.TI;

  // ⚠️ Mr.Bond 互換: 原作C/Fortran版は (T1-T0)/h を (int) で切り捨てる。
  // IEEE 754 の丸めで `10/1e-5 = 999999.9999...` となり、結果は 999999（1000000 ではない）。
  // NOT=1000 のとき samplingInterval も同じく切り捨てで 999 になる。
  // これを無視すると Mr.Bond のCSVと各サンプル時刻が 1ステップずれる。
  const totalSteps = Math.trunc((par.T1 - par.T0) / h);
  const samplingInterval = par.NOT > 0 ? Math.max(1, Math.trunc(totalSteps / par.NOT)) : 1;

  const rows: { time: number; values: number[] }[] = [];

  // 初期出力（t=T0 の時点、RUNGE呼び出し前）
  dout(x, op);
  rows.push({ time: t, values: [...op] });

  // Runge.c main() と同じループ: count++ は check の後、reset は sample 時
  let count = 0;
  for (let step = 0; step < totalSteps; step++) {
    const res = rungeKuttaGillStep(t, h, x, func, solv);
    t = res.t;
    if (count === samplingInterval) {
      dout(x, op);
      rows.push({ time: t, values: [...op] });
      count = 0;
    }
    count++;
  }

  // ラベル解決
  const labels: string[] = [];
  for (let i = 0; i < par.NOUT; i++) {
    const fromPar = par.labels.get(i + 1);
    if (fromPar !== undefined) {
      // Mr.Bondの LA 形式は "DP2 DP2" のような重複があるので最初のトークンを使う
      const first = fromPar.trim().split(/\s+/)[0] ?? fromPar;
      labels.push(first);
    } else if (fallbackLabels && i < fallbackLabels.length) {
      labels.push(fallbackLabels[i]!);
    } else {
      labels.push(`OP${i + 1}`);
    }
  }

  const csv = formatCsv(labels, rows);

  return {
    csv,
    finalState: x,
    finalTime: t,
    rowCount: rows.length,
  };
}
