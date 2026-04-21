/**
 * 実ファイル（Mr.Bond が実際に出力した .PAR）のパース検証。
 *
 * ソース: 2026-04-21 に Windows Server 上で Mr.Bond を動かし、
 * バネ-マス-ダンパ.BGE の「計算開始」直後に生成された temp.PAR を吸い出した。
 * コンパイル失敗で消える直前に退避。
 *
 * 目的:
 *   合成サンプルでは捉えきれない書式のゆれ（末尾コメント、3桁指数、
 *   PAレコードの名前フィールド等）をカバーする統合テスト。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePar } from '../src/parser/parFile.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'springMassDamper.PAR');

test('実 .PAR: バネ-マス-ダンパのシミュレーション設定を読み取れる', async () => {
  const src = await readFile(FIXTURE_PATH, 'utf8');
  const par = parsePar(src);

  assert.equal(par.NS, 2, '状態変数数 NS=2');
  assert.equal(par.ING, 1, '追加積分変数 IN=1');
  assert.equal(par.ND, 0, '制約数 ND=0');
  assert.equal(par.NOT, 1000, '出力タイムステップ数 NOT=1000');
  assert.equal(par.NOUT, 1, '出力変数数 OP=1');

  assert.equal(par.T0, 0, '開始時刻');
  assert.equal(par.T1, 10, '終了時刻');
  assert.equal(par.TI, 1e-5, '時間刻み');
});

test('実 .PAR: PA 配列が正しく読み取れる（3桁指数 e+001 含む）', async () => {
  const src = await readFile(FIXTURE_PATH, 'utf8');
  const par = parsePar(src);

  assert.equal(par.pa.get(1), 10, 'PA[1] = EIN = 10');
  assert.equal(par.pa.get(2), 10, 'PA[2] = M = 10');
  assert.equal(par.pa.get(3), 100, 'PA[3] = PK = 100');
  assert.equal(par.pa.get(4), 10, 'PA[4] = PCF = 10');
  assert.equal(par.pa.get(5), 0, 'PA[5] = PF = 0');
});

test('実 .PAR: PA の名前フィールドを保持する', async () => {
  const src = await readFile(FIXTURE_PATH, 'utf8');
  const par = parsePar(src);

  assert.equal(par.paNames.get(1), 'EIN');
  assert.equal(par.paNames.get(2), 'M');
  assert.equal(par.paNames.get(3), 'PK');
  assert.equal(par.paNames.get(4), 'PCF');
  assert.equal(par.paNames.get(5), 'PF');
});

test('実 .PAR: LA（出力ラベル）を読み取れる', async () => {
  const src = await readFile(FIXTURE_PATH, 'utf8');
  const par = parsePar(src);

  // "LA  1  DP2            DP2" → index=1, name="DP2 DP2" (実質 "DP2" 2回のパディング)
  assert.ok(par.labels.get(1)!.includes('DP2'), `ラベル1は DP2 を含むべき: ${par.labels.get(1)}`);
});
