/**
 * バネ-マス-ダンパモデルのエンドツーエンド検証。
 *
 * ソルバ（rungeKuttaGillStep）とモデル（springMassDamper）を組み合わせて
 * 数値積分した結果が、古典制御理論の解析解と一致することを確認する。
 *
 * これがパスすれば「ソルバ × モデル」の結合が正しいことを独立に証明できたことになり、
 * BGEパーサ実装に安心して移れる。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { integrate } from '../src/solver/rungeKuttaGill.ts';
import {
  ORIGINAL_BGE_PARAMS,
  buildFunc,
  analyticalResponse,
} from '../src/models/springMassDamper.ts';

test('バネ-マス-ダンパ: 減衰振動の軌跡が解析解と 1e-6 以内で一致する', () => {
  const params = ORIGINAL_BGE_PARAMS;
  const h = 1e-5;
  const t1 = 5.0;

  let maxPositionError = 0;
  let maxVelocityError = 0;
  let sampledPoints = 0;

  integrate({
    t0: 0,
    t1,
    h,
    x0: [0, 0],
    func: buildFunc(params),
    onStep: (t, x) => {
      // 負荷軽減のため、100ステップに1回だけ解析解と比較
      if (sampledPoints++ % 100 !== 0) return;
      const analytical = analyticalResponse(t, params);
      const numPosition = x[0]!;
      const numVelocity = x[1]! / params.M;
      const errP = Math.abs(numPosition - analytical.position);
      const errV = Math.abs(numVelocity - analytical.velocity);
      if (errP > maxPositionError) maxPositionError = errP;
      if (errV > maxVelocityError) maxVelocityError = errV;
    },
  });

  assert.ok(
    maxPositionError < 1e-6,
    `最大位置誤差 ${maxPositionError} (許容 1e-6)`,
  );
  assert.ok(
    maxVelocityError < 1e-6,
    `最大速度誤差 ${maxVelocityError} (許容 1e-6)`,
  );
});

test('バネ-マス-ダンパ: 最終値が定常解 x_ss = F/k = 0.1 に収束する', () => {
  const params = ORIGINAL_BGE_PARAMS;
  const h = 1e-4;
  const t1 = 30.0; // 十分長い時間、減衰しきるまで

  const result = integrate({
    t0: 0,
    t1,
    h,
    x0: [0, 0],
    func: buildFunc(params),
  });

  const xss = params.EIN / params.PK; // 0.1
  const finalPosition = result.x[0]!;
  const finalVelocity = result.x[1]! / params.M;

  assert.ok(
    Math.abs(finalPosition - xss) < 1e-6,
    `定常変位 期待 ${xss}, 実測 ${finalPosition}`,
  );
  assert.ok(
    Math.abs(finalVelocity) < 1e-6,
    `定常速度 期待 0, 実測 ${finalVelocity}`,
  );
});

test('バネ-マス-ダンパ: 減衰パラメータの物理整合性（ωn、ζ の値）', () => {
  const { M, PK, PCF } = ORIGINAL_BGE_PARAMS;
  const wn = Math.sqrt(PK / M);
  const zeta = PCF / (2 * Math.sqrt(PK * M));

  // M=10, PK=100 → wn = √10 ≈ 3.162 rad/s
  // PCF=10, PK·M=1000 → ζ = 10/(2·√1000) = 10/63.25 ≈ 0.158（軽い不足減衰）
  assert.ok(Math.abs(wn - Math.sqrt(10)) < 1e-12);
  assert.ok(zeta > 0 && zeta < 1, `ζ=${zeta} は 0 < ζ < 1 の不足減衰域にあるべき`);
  assert.ok(Math.abs(zeta - 10 / (2 * Math.sqrt(1000))) < 1e-12);
});
