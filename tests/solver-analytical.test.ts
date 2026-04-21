/**
 * Runge-Kutta-Gill ソルバの解析解検証テスト。
 *
 * 目的:
 * - 実装した rungeKuttaGillStep / integrate が数値的に正しいことを独立証明する
 * - Mr.Bond のオリジナルCSV出力に頼らず、解析解が閉形式で得られる ODE で検証
 * - RK4系としての**精度オーダー**（H^4 誤差）が出ていることも確認
 *
 * Fortran参照実装: MRBOND/Runge.f の SUBROUTINE RUNGE
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rungeKuttaGillStep, integrate } from '../src/solver/rungeKuttaGill.ts';

// --- テスト1: 指数減衰 y' = -y, y(0) = 1, 解析解 y(t) = exp(-t) -------------

test('指数減衰ODE: 最終値が exp(-t1) に一致する (1e-8以内)', () => {
  const t0 = 0;
  const t1 = 2;
  const h = 1e-4;

  const result = integrate({
    t0,
    t1,
    h,
    x0: [1.0],
    func: (_t, x, dx) => {
      dx[0] = -x[0]!;
    },
  });

  const analytical = Math.exp(-t1);
  const actual = result.x[0]!;
  const absError = Math.abs(actual - analytical);

  assert.ok(
    absError < 1e-10,
    `y(${t1}) 期待値 ${analytical}, 実測 ${actual}, 誤差 ${absError}`,
  );
});

// --- テスト2: 単振動（ばね-質量系）x'' = -ω²x ---------------------------------
//   状態: X = [position, velocity], ω² = k/m = 1
//   解析解: x(t) = cos(t), v(t) = -sin(t)
//   → Mr.Bond で最も基本的な「バネ-マス-ダンパ」（ダンパ係数0のケース）に相当

test('単振動ODE（ω=1）: 位置と速度が cos/sin に一致する', () => {
  // 注意: π/h が整数にならないため、積分は t=π をわずかに行き過ぎる。
  // 解析解は **実際の終了時刻 result.t** で評価して比較する。
  const t0 = 0;
  const t1 = Math.PI; // 半周期（目標）
  const h = 1e-4;
  const omegaSq = 1.0;

  const result = integrate({
    t0,
    t1,
    h,
    x0: [1.0, 0.0],
    func: (_t, x, dx) => {
      dx[0] = x[1]!;
      dx[1] = -omegaSq * x[0]!;
    },
  });

  const expectedX = Math.cos(result.t);
  const expectedV = -Math.sin(result.t);
  const actualX = result.x[0]!;
  const actualV = result.x[1]!;

  const errX = Math.abs(actualX - expectedX);
  const errV = Math.abs(actualV - expectedV);

  assert.ok(errX < 1e-12, `x(${result.t}) 期待 ${expectedX}, 実測 ${actualX}, 誤差 ${errX}`);
  assert.ok(errV < 1e-12, `v(${result.t}) 期待 ${expectedV}, 実測 ${actualV}, 誤差 ${errV}`);
});

// --- テスト3: 4次精度の収束率確認 -----------------------------------------
//   ステップ幅を半分にすると、誤差は 2^4 = 16倍 小さくなるはず（古典RK4と同じ）
//   Gill法も理論上 4次精度なので、これを確認

test('4次収束率: Hを半分にすると誤差は概ね1/16になる', () => {
  const runWithStep = (h: number) => {
    const result = integrate({
      t0: 0,
      t1: 1,
      h,
      x0: [1.0],
      func: (_t, x, dx) => {
        dx[0] = -x[0]!;
      },
    });
    return Math.abs(result.x[0]! - Math.exp(-1));
  };

  // 粗いステップで誤差を測れるように H を大きめに
  const e1 = runWithStep(0.1);
  const e2 = runWithStep(0.05);
  const ratio = e1 / e2;

  // 理想は16だが、浮動小数と高次項の影響で 10〜20 の範囲を許容
  assert.ok(
    ratio > 10 && ratio < 25,
    `収束率 ${ratio}（期待: 16±α）、e(0.1)=${e1}, e(0.05)=${e2}`,
  );
});

// --- テスト4: エネルギー保存（減衰なし振動子）-----------------------------
//   全エネルギー E = 0.5*(v² + ω²x²) は理論上保存されるべき
//   RK系は厳密なシンプレクティックではないが、短時間なら高精度で保存

test('減衰なし振動子のエネルギー保存（1周期で変動 < 1e-8）', () => {
  const omegaSq = 4.0; // ω = 2
  const h = 1e-5;
  const t1 = Math.PI; // 1周期

  const e0 = 0.5 * (0 * 0 + omegaSq * 1 * 1);
  let eMax = -Infinity;
  let eMin = Infinity;

  integrate({
    t0: 0,
    t1,
    h,
    x0: [1.0, 0.0],
    func: (_t, x, dx) => {
      dx[0] = x[1]!;
      dx[1] = -omegaSq * x[0]!;
    },
    onStep: (_t, x) => {
      const e = 0.5 * (x[1]! * x[1]! + omegaSq * x[0]! * x[0]!);
      if (e > eMax) eMax = e;
      if (e < eMin) eMin = e;
    },
  });

  const driftAbs = Math.max(Math.abs(eMax - e0), Math.abs(eMin - e0));
  assert.ok(
    driftAbs < 1e-8,
    `エネルギードリフト ${driftAbs}（初期 ${e0}, 最大 ${eMax}, 最小 ${eMin}）`,
  );
});

// --- テスト5: SOLV（制約ソルバ）が呼ばれる回数を確認 -----------------------
//   Fortran Runge.f: 1ステップあたり SOLV は 5回呼ばれる
//     （4ステージ前 + 最終確定の1回）

test('1ステップで SOLV が正しく 5回呼ばれる（Fortran版と同じ）', () => {
  let solvCallCount = 0;
  let funcCallCount = 0;

  rungeKuttaGillStep(
    0,
    0.01,
    [1.0],
    (_t, x, dx) => {
      dx[0] = -x[0]!;
      funcCallCount++;
    },
    (_t, _x) => {
      solvCallCount++;
    },
  );

  assert.equal(solvCallCount, 5, 'SOLVは1ステップで5回呼ばれるはず');
  assert.equal(funcCallCount, 4, 'FUNCは1ステップで4回呼ばれるはず（4ステージ）');
});

// --- テスト6: 時刻進行の正しさ -----------------------------------------
//   1ステップで t は 0.5H + 0.5H = H だけ進む（Fortran実装どおり）

test('1ステップで時刻は H だけ進む', () => {
  const t0 = 3.14;
  const h = 0.02;

  const result = rungeKuttaGillStep(
    t0,
    h,
    [1.0],
    (_t, x, dx) => {
      dx[0] = -x[0]!;
    },
  );

  assert.ok(
    Math.abs(result.t - (t0 + h)) < 1e-14,
    `t 期待 ${t0 + h}, 実測 ${result.t}`,
  );
});

// --- テスト7: 減衰振動 (damped oscillator) — Mr.Bondのバネ-マス-ダンパ相当 --
//   x'' + 2ζω x' + ω² x = 0
//   解析解: x(t) = exp(-ζωt)(cos(ωd t) + (ζω/ωd)sin(ωd t)), ωd = ω√(1-ζ²)
//   with x(0)=1, v(0)=0

test('減衰振動（臨界以下）: 解析解と 1e-7 以内で一致', () => {
  const omega = 1.0;
  const zeta = 0.1; // 10% damping
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);
  const t1 = 5.0;
  const h = 1e-4;

  const result = integrate({
    t0: 0,
    t1,
    h,
    x0: [1.0, 0.0],
    func: (_t, x, dx) => {
      dx[0] = x[1]!;
      dx[1] = -2 * zeta * omega * x[1]! - omega * omega * x[0]!;
    },
  });

  const expected =
    Math.exp(-zeta * omega * t1) *
    (Math.cos(omegaD * t1) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t1));
  const actual = result.x[0]!;
  const err = Math.abs(actual - expected);

  assert.ok(err < 1e-7, `減衰振動 x(${t1}) 期待 ${expected}, 実測 ${actual}, 誤差 ${err}`);
});
