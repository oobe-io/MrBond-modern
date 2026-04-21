/**
 * バネ-マス-ダンパモデル
 *
 * 原作 BGE ファイル: MRBOND/BGE_files/バネ-マス-ダンパ.BGE
 * これを Mr.Bond のGUIで開くと、下記パラメータで設定された標準的な
 * 単自由度系が得られる。ボンドグラフの要素パラメータをそのまま持ち込み、
 * 手動で状態方程式に落とした参照モデル（自動生成ができるまでの足場）。
 *
 * パラメータ（原作BGEから抽出）:
 *   EIN = 10.0   [N]      外力（Effort源、定数）
 *   M   = 10.0   [kg]     質量（Inertia）
 *   PK  = 100.0  [N/m]    バネ定数（Capacitance、1/K）
 *   PCF = 10.0   [N·s/m]  ダンパ係数（Resistance）
 *   PF  = 0.0             流源（不使用）
 *
 * 支配方程式（古典機械系）:
 *   m·x''(t) + c·x'(t) + k·x(t) = F
 *   10 x'' + 10 x' + 100 x = 10
 *
 * 状態定義（Mr.Bond流儀に合わせる）:
 *   X[0] = 変位 x      [m]    （I要素への積分経路で生成される状態）
 *   X[1] = 運動量 p    [N·s]  （I要素のZ、p = m·v）
 *
 * 導関数:
 *   dX[0]/dt = v = p / M
 *   dX[1]/dt = F_net = EIN − PCF·v − PK·x
 *                    = EIN − (PCF/M)·p − PK·x
 */

import type { DerivFn } from '../solver/rungeKuttaGill.ts';

export interface SpringMassDamperParams {
  readonly M: number;
  readonly PK: number;
  readonly PCF: number;
  readonly EIN: number;
}

export const ORIGINAL_BGE_PARAMS: SpringMassDamperParams = {
  M: 10.0,
  PK: 100.0,
  PCF: 10.0,
  EIN: 10.0,
};

export function buildFunc(params: SpringMassDamperParams): DerivFn {
  const { M, PK, PCF, EIN } = params;
  return (_t, x, dx) => {
    const position = x[0]!;
    const momentum = x[1]!;
    const velocity = momentum / M;
    dx[0] = velocity;
    dx[1] = EIN - PCF * velocity - PK * position;
  };
}

/**
 * 2階線形ODE（定係数、定数入力）の解析解。
 *   m·x'' + c·x' + k·x = F,   x(0) = 0, x'(0) = 0
 *
 * 減衰率 ζ = c / (2·√(mk))、固有角周波数 ωn = √(k/m)、
 * 定常解 x_ss = F/k。過減衰/臨界減衰/不足減衰で場合分け。
 */
export function analyticalResponse(
  t: number,
  params: SpringMassDamperParams,
): { position: number; velocity: number } {
  const { M, PK, PCF, EIN } = params;
  const wn = Math.sqrt(PK / M);
  const zeta = PCF / (2 * Math.sqrt(PK * M));
  const xss = EIN / PK;

  // 初期条件 x(0)=0, v(0)=0 を満たす解
  if (zeta < 1) {
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const expTerm = Math.exp(-zeta * wn * t);
    const position =
      xss + expTerm * (-xss * Math.cos(wd * t) - ((zeta * wn) / wd) * xss * Math.sin(wd * t));
    const velocity =
      expTerm *
      (xss * ((wn * wn) / wd) * Math.sin(wd * t));
    // d/dt of above simplified using x'' + 2ζωnx' + ωn²x = ωn² xss
    // 実装は数値微分でもよいが、解析形式を直接書く
    return { position, velocity };
  } else if (zeta > 1) {
    const s = Math.sqrt(zeta * zeta - 1);
    const r1 = (-zeta + s) * wn;
    const r2 = (-zeta - s) * wn;
    // 初期条件: A + B = -xss, r1*A + r2*B = 0 → A = r2/(r2-r1) * (-xss), B = -r1/(r2-r1) * (-xss)
    const A = (r2 / (r2 - r1)) * -xss;
    const B = (-r1 / (r2 - r1)) * -xss;
    const position = xss + A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
    const velocity = A * r1 * Math.exp(r1 * t) + B * r2 * Math.exp(r2 * t);
    return { position, velocity };
  } else {
    // 臨界減衰
    const position = xss + (-xss - xss * wn * t) * Math.exp(-wn * t);
    const velocity = (-wn * -xss - xss * wn + xss * wn * wn * t) * Math.exp(-wn * t);
    return { position, velocity };
  }
}
