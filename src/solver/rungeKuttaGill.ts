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
 * @param t  現在時刻
 * @param x  現在の状態ベクトル（読み取り専用で扱うこと）
 * @param dx 微分を書き込む出力バッファ（dx.length === x.length を前提）
 */
export type DerivFn = (t: number, x: readonly number[], dx: number[]) => void;

/**
 * 制約方程式ソルバ（Fortran版 SOLV に対応）
 * 制約が無いモデルでは何もせず即リターンでよい。
 * @param t 現在時刻
 * @param x 状態ベクトル（必要なら in-place で補正してよい）
 */
export type ConstraintFn = (t: number, x: number[]) => void;

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

  // ---- Stage 1 ----
  solv(t, x1);
  func(t, x1, dx);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! + 0.5 * h * dx[i]!;
    phi[i] = phi[i]! + dx[i]!;
    k0[i] = dx[i]!;
  }

  // ---- Stage 2 ----
  t = t + 0.5 * h;
  solv(t, x1);
  func(t, x1, dx);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! + (CS1 - 0.5) * h * k0[i]! + (1.0 - CS1) * h * dx[i]!;
    phi[i] = phi[i]! + (2.0 - CS2) * dx[i]!;
    k0[i] = dx[i]!;
  }

  // ---- Stage 3 ----
  solv(t, x1);
  func(t, x1, dx);
  for (let i = 0; i < n; i++) {
    x1[i] = x[i]! - CS1 * h * k0[i]! + (1.0 + CS1) * h * dx[i]!;
    phi[i] = phi[i]! + (2.0 + CS2) * dx[i]!;
  }

  // ---- Stage 4 ----
  t = t + 0.5 * h;
  solv(t, x1);
  func(t, x1, dx);
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
