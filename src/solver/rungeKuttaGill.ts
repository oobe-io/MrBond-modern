/**
 * Runge-Kutta-Gill 4次法のソルバ
 *
 * 忠実な移植元: MRBOND/Runge.f (Fortran版、こちらが参照実装)
 *   - C版 (Runge.c) は SOLV 内に軽微な齟齬があるため不採用
 *
 * アルゴリズム詳細は docs/SOLVER_SPEC.md および
 *   Obsidian vault: 🗂️notes/📕Mr.Bondソルバ仕様.md を参照
 *
 * 係数:
 *   CS1 = 1/√2, CS2 = √2
 *   4ステージの重み合計: 1 + (2-√2) + (2+√2) + 1 = 6
 *   最終更新: X[i] += PHI[i] * H / 6
 */

const CS1 = 1.0 / Math.sqrt(2.0);
const CS2 = Math.sqrt(2.0);

/**
 * 状態導関数の評価関数（Fortran版 FUNC に対応）
 *
 * @param t        現在時刻
 * @param xProbe   RKステージの試算点（FUNC 内 `X[i]` 直接参照はこれを指す）
 * @param dx       微分を書き込む出力バッファ
 * @param xGlobal  積分対象の「グローバル状態」配列。Mr.Bond 生成の一部要素関数
 *                 （valve クランプ等）が書き換え、同じ RK ステップの後続ステージに
 *                 副作用として伝播する。省略時は xProbe と同一視。
 */
export type DerivFn = (
  t: number,
  xProbe: readonly number[],
  dx: number[],
  xGlobal?: number[],
) => void;

/**
 * 制約方程式ソルバ（Fortran版 SOLV に対応）
 * 制約が無いモデルでは何もせず即リターンでよい。
 * @param t 現在時刻
 * @param x 状態ベクトル（必要なら in-place で補正してよい）
 */
export type ConstraintFn = (t: number, x: number[]) => void;

/**
 * Runge.f の SUBROUTINE SOLV を忠実に再現する制約ソルバ構築関数。
 *
 * ND > 0 のモデル（代数方程式・constraints あり）で、状態を代入して
 * FU 関数（1-based index, 1..ND）で残差を求め、変化量が閾値 D0 (=1e-8) 以下
 * になるまで反復。DE/DF は ND/2 個のペアで、各ペアが 1 つの constraint。
 *
 * ND = 0 なら noop を返す（fast path）。
 */
export function buildSolv(
  fu: (i: number, t: number, x: number[]) => number,
  nd: number,
): ConstraintFn {
  if (nd <= 0) return noopConstraint;
  const I0 = nd / 2;
  if (!Number.isInteger(I0)) {
    throw new Error(`SOLV: ND must be even, got ${nd}`);
  }
  const D0 = 1.0e-8;
  const DE = new Array<number>(I0).fill(0);
  const DF = new Array<number>(I0).fill(0);
  const MAX_ITERATIONS = 1000;
  return (t: number, x: number[]) => {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let ichk = 0;
      for (let i = 0; i < I0; i++) {
        // Mr.Bond の 1-based: DE は 2i-1（i=1..I0）→ JSでは 2*i+1 の odd index
        // ただし元コードは FU(2I-1,...) = FU(1,3,5,..)、FU(2I,..)=FU(2,4,6,..)
        // JS では FU を 1-based で呼ぶよう統一（FU 側が 0-based を期待するなら FU 内で調整）
        const d1e = Math.abs(DE[i]!) * D0;
        const de1 = fu(2 * (i + 1) - 1, t, x);
        const d2e = Math.abs(de1 - DE[i]!);
        if (d2e > d1e) ichk = 1;
        DE[i] = de1;

        const d1f = Math.abs(DF[i]!) * D0;
        const df1 = fu(2 * (i + 1), t, x);
        const d2f = Math.abs(df1 - DF[i]!);
        if (d2f > d1f) ichk = 1;
        DF[i] = df1;
      }
      if (ichk === 0) return;
    }
    throw new Error(`SOLV did not converge after ${MAX_ITERATIONS} iterations`);
  };
}

export interface StepResult {
  /** 1ステップ進めた後の時刻 */
  t: number;
}

/**
 * 1ステップだけ Runge-Kutta-Gill で進める。
 * x は in-place で更新される。時刻 t はそのまま読むと進まないので、
 * 戻り値の t を採用すること（Fortran実装のセマンティクスに合わせる）。
 *
 * Fortran Runge.f の SUBROUTINE RUNGE をそのまま追従:
 *   - SOLV(t, X1)       ← X1 初期化直後
 *   - FUNC(t, X1, DX)
 *   - (stage1 update, t += 0.5H)
 *   - SOLV/FUNC
 *   - (stage2 update)
 *   - SOLV/FUNC
 *   - (stage3 update, t += 0.5H)
 *   - SOLV/FUNC
 *   - (stage4 update)
 *   - SOLV(t, X)        ← 最後にも呼ばれる（制約を満たした状態を確定）
 */
export function rungeKuttaGillStep(
  t: number,
  h: number,
  x: number[],
  func: DerivFn,
  solv: ConstraintFn = noopConstraint,
): StepResult {
  const n = x.length;
  const x1: number[] = new Array(n).fill(0);
  const k0: number[] = new Array(n).fill(0);
  const phi: number[] = new Array(n).fill(0);
  const dx: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    x1[i] = x[i]!;
  }

  // Mr.Bond 互換: func には RK 試算点 x1 と、積分対象の「グローバル状態」x の両方を渡す。
  // 一部の要素関数（FD_valve の E3 クランプなど）は x を書き換え、その副作用は
  // 続くステージの試算点再構成時に x 経由で反映される必要がある。

  // ---- Stage 1 ----
  solv(t, x1);
  func(t, x1, dx, x);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! + 0.5 * h * dx[i]!;
    phi[i] = phi[i]! + dx[i]!;
    k0[i] = dx[i]!;
  }

  // ---- Stage 2 ----
  t = t + 0.5 * h;
  solv(t, x1);
  func(t, x1, dx, x);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! + (CS1 - 0.5) * h * k0[i]! + (1.0 - CS1) * h * dx[i]!;
    phi[i] = phi[i]! + (2.0 - CS2) * dx[i]!;
    k0[i] = dx[i]!;
  }

  // ---- Stage 3 ----
  solv(t, x1);
  func(t, x1, dx, x);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! - CS1 * h * k0[i]! + (1.0 + CS1) * h * dx[i]!;
    phi[i] = phi[i]! + (2.0 + CS2) * dx[i]!;
  }

  // ---- Stage 4 ----
  t = t + 0.5 * h;
  solv(t, x1);
  func(t, x1, dx, x);
  for (let i = 0; i < n; i++) {
    phi[i] = phi[i]! + dx[i]!;
    x[i] = x[i]! + (phi[i]! * h) / 6.0;
  }

  solv(t, x);
  return { t };
}

export function noopConstraint(_t: number, _x: number[]): void {
  // 制約なしのモデルではソルバは何もしない
}

/**
 * 指定区間を固定刻み H で積分するヘルパー。
 * 進捗コールバックで (t, x) のスナップショットを通知する。
 * サンプリングを間引く機能は呼び出し側で制御する想定。
 */
export function integrate(options: {
  t0: number;
  t1: number;
  h: number;
  x0: readonly number[];
  func: DerivFn;
  solv?: ConstraintFn;
  onStep?: (t: number, x: readonly number[]) => void;
}): { t: number; x: number[] } {
  const { t0, t1, h, x0, func, solv = noopConstraint, onStep } = options;
  const x: number[] = [...x0];
  let t = t0;
  onStep?.(t, x);

  // 浮動小数の累積誤差を避けるため、ステップ数を整数で決める
  const totalSteps = Math.round((t1 - t0) / h);
  for (let step = 0; step < totalSteps; step++) {
    const res = rungeKuttaGillStep(t, h, x, func, solv);
    t = res.t;
    onStep?.(t, x);
  }

  return { t, x };
}
