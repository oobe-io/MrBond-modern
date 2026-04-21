/**
 * バネ-マス-ダンパモデル（Mr.Bond生成コード忠実移植版）。
 *
 * 原典: Mr.Bond ver 1.5.2 が バネ-マス-ダンパ.BGE から生成した temp.c。
 *       tests/fixtures/springMassDamper.model.c に原典を保管。
 *
 * 手動移植版 (springMassDamper.ts) とは **状態変数の配置が異なる** ため別ファイル化:
 *   - X[0] = 運動量 p  （I1 要素の積分状態、Mr.Bondの流儀）
 *   - X[1] = バネの変位 x  （C1 要素の積分状態）
 *   - X[2] = 出力用の追加積分（bond 2 の変位、IN=1 でプラスされる）
 *
 * 定数:
 *   PA[1] = EIN = 10.0  (効果源)
 *   PA[2] = M   = 10.0  (質量)
 *   PA[3] = PK  = 100.0 (バネ定数)
 *   PA[4] = PCF = 10.0  (ダンパ係数)
 *   PA[5] = PF  = 0.0   (流源)
 *
 * 要素関数（temp.c を直訳）:
 *   E1() = PA[1]           // 効果源 Se1 出力
 *   L1(Z) = Z / PA[2]      // I1 要素: 流れ = 運動量/質量 = 速度
 *   C1(Z) = PA[3] * Z      // C1 要素: 効果 = バネ定数 × 変位
 *   R1(_, Z) = PA[4] * Z   // R1 要素: 効果 = ダンパ係数 × 流れ
 *   F1() = PA[5]           // 流源 Sf1 出力
 *
 * 状態方程式（temp.c を直訳）:
 *   DX[0] = -C1(X[1]) + E1() - R1(0, -F1() + L1(X[0]))
 *         = -PK*X[1] + EIN - PCF*(-PF + X[0]/M)
 *         = EIN - PK*X[1] - PCF*X[0]/M    (PF=0 の時)
 *           ↑ 力学: dp/dt = F - kx - cv
 *
 *   DX[1] = -F1() + L1(X[0])
 *         = -PF + X[0]/M
 *         = X[0]/M           (PF=0 の時)
 *           ↑ 運動学: dx/dt = v = p/m
 *
 *   DX[2] = L1(X[0])
 *         = X[0]/M
 *           ↑ bond 2 の流れ（= 速度）を積分 → bond 2 の変位
 *
 * 出力:
 *   OP[0] = X[2]   // "DP2" = Displacement on Bond 2
 */

import type { DerivFn } from '../solver/rungeKuttaGill.ts';

/** PA 配列を受け取り、Mr.Bond temp.c 互換の FUNC 関数を返す。 */
export function buildMrBondFunc(pa: ReadonlyMap<number, number>): DerivFn {
  const get = (idx: number): number => {
    const v = pa.get(idx);
    if (v === undefined) throw new Error(`PA[${idx}] missing`);
    return v;
  };
  const PA1 = get(1); // EIN
  const PA2 = get(2); // M
  const PA3 = get(3); // PK
  const PA4 = get(4); // PCF
  const PA5 = get(5); // PF

  const E1 = (): number => PA1;
  const L1 = (Z: number): number => Z / PA2;
  const C1 = (Z: number): number => PA3 * Z;
  const R1 = (_J: number, Z: number): number => PA4 * Z;
  const F1 = (): number => PA5;

  return (_t, x, dx) => {
    dx[0] = -C1(x[1]!) + E1() - R1(0, -F1() + L1(x[0]!));
    dx[1] = -F1() + L1(x[0]!);
    dx[2] = L1(x[0]!);
  };
}

/** temp.c の DOUT() に対応。OP[0] = X[2]。 */
export function buildMrBondDout(): (x: readonly number[], op: number[]) => void {
  return (x, op) => {
    op[0] = x[2]!;
  };
}
