/**
 * エンドツーエンド検証: 実 .PAR + 移植 temp.c モデル → ソルバ → CSV出力。
 *
 * これがパスすれば「Mr.Bond互換の入力で、Mr.Bond互換のCSV出力が得られる」
 * ことを示す。Mr.Bondの実CSVとの数値比較は別途（実行環境修復後）。
 *
 * 物理的正しさの検証ポイント:
 *   - x_ss = F/k = 0.1 に収束
 *   - 固有周波数 ωn = √(k/m) = √10 ≈ 3.162 rad/s
 *   - 減衰比 ζ = c/(2√(km)) ≈ 0.158 → 減衰振動
 *   - NOT=1000 サンプル + 初期値で 1001 行
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePar } from '../src/parser/parFile.ts';
import { runSimulation } from '../src/runtime/runSimulation.ts';
import { buildMrBondFunc, buildMrBondDout } from '../src/models/springMassDamperMrBond.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAR_PATH = join(__dirname, 'fixtures', 'springMassDamper.PAR');

test('E2E: バネ-マス-ダンパの実.PAR + temp.c移植モデルで完走する', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  // Mr.Bond互換: (T1-T0)/h の切り捨てで総ステップ数が 999999（1000000 ではない）
  // 最終時刻 = 999999 * h = 9.99999（9.99001 がサンプリング最終、だがシミュレーション自体はさらに進む）
  assert.ok(
    Math.abs(result.finalTime - 9.99999) < 1e-9,
    `Mr.Bond互換の終了時刻 9.99999 に一致するべき: ${result.finalTime}`,
  );

  // 行数 = NOT + 1 (初期値含む)
  assert.equal(result.rowCount, par.NOT + 1, `行数 ${result.rowCount} は NOT+1 = ${par.NOT + 1}`);
});

test('E2E: 最終値が定常解 x_ss = 0.1 に収束する', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  // X[1] はバネ変位（C要素の状態）、定常で X[1] = x_ss = 0.1 に漸近する。
  // T1=10 は ~5 時定数分（時定数 = 1/(ζωn) ≈ 2s）なので残差は e^-5 ≈ 0.7% オーダ。
  const xSpringAtEnd = result.finalState[1]!;
  const xSs = par.pa.get(1)! / par.pa.get(3)!; // EIN / PK = 10/100 = 0.1

  assert.ok(
    Math.abs(xSpringAtEnd - xSs) < 1e-2,
    `バネ変位 X[1] ${xSpringAtEnd} → 定常解 ${xSs}（誤差 ${Math.abs(xSpringAtEnd - xSs)}）`,
  );
});

test('E2E: 出力CSV形式が正しい（ヘッダ "TIME, DP2"）', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  const lines = result.csv.split('\n');
  assert.equal(lines[0], 'TIME         , DP2', `ヘッダ行: ${lines[0]}`);

  // 初期行は T=0, OP[0] = X[2] = 0
  assert.equal(lines[1], '0.000000e+00, 0.000000e+00', `初期行: ${lines[1]}`);

  // Mr.Bond互換: サンプリング時刻は step 999*K (K=1..1000) なので最終サンプルは step 999000 = t=9.99001 (1e-5の誤差で9.99001000...)
  const lastDataLine = lines[par.NOT + 1]!;
  assert.ok(
    lastDataLine.startsWith('9.990010e+00,'),
    `Mr.Bond互換の最終サンプル時刻 9.99001 で始まるべき: "${lastDataLine}"`,
  );
});

test('E2E: 1秒付近で減衰振動のピークが見える（物理的挙動）', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  // NOTを増やして時系列を詳しく見る必要はないので、デフォルトで進めて中盤の値をチェック
  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  const lines = result.csv.split('\n').slice(1, par.NOT + 1);
  // 最初のピーク近辺（t ≈ 1.0、ωn=√10 なので半周期が π/√10 ≈ 0.993）
  const peakNearOne = lines[100]!; // index 100 (0.01秒ステップで t=1.0)
  const valueMatch = /,\s*(-?\d+\.\d+e[+-]\d+)$/.exec(peakNearOne);
  assert.ok(valueMatch, `t=1 付近の値を抽出: ${peakNearOne}`);
  const value = Number.parseFloat(valueMatch[1]!);

  // t=1付近では既に一度オーバーシュートして戻ってきてる頃合い
  // 理論: ピークは x_ss(1 + e^(-ζπ/√(1-ζ²))) ≈ 0.1 * (1 + 0.604) ≈ 0.16
  assert.ok(value > 0.1, `t=1 付近は定常値(0.1)より大きくなるはず: ${value}`);
  assert.ok(value < 0.3, `t=1 付近は過度なオーバーシュートしないはず: ${value}`);
});
