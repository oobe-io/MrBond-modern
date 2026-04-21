/**
 * .PAR ファイルパーサの検証。
 *
 * 実ファイル（Mr.Bond が出力したもの）は未入手のため、ユニットテストは
 * Runge.f の PARM ルーチンが扱う全レコード形式を手動合成したもので検証する。
 * 実ファイル到着後は、追加の統合テストをここに足す想定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePar, ParParseError } from '../src/parser/parFile.ts';

test('最小限の .PAR: 状態数・時間設定・END', () => {
  const src = [
    'NS     2',
    'IN     2',
    'ND     0',
    'NO     1000',
    'OP     1',
    'PT  1  0.00000000D+00',
    'PT  2  1.00000000D+01',
    'PT  3  1.00000000D-05',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.equal(par.NS, 2);
  assert.equal(par.ING, 2);
  assert.equal(par.ND, 0);
  assert.equal(par.NOT, 1000);
  assert.equal(par.NOUT, 1);
  assert.equal(par.T0, 0);
  assert.equal(par.T1, 10);
  assert.equal(par.TI, 1e-5);
});

test('PA: モデルパラメータ配列の読み取り', () => {
  const src = [
    'PA    1  1.00000000D+01',
    'PA    2  1.00000000D+02',
    'PA    3  1.00000000D+01',
    'NS     2',
    'IN     2',
    'ND     0',
    'NO     1000',
    'OP     1',
    'PT  1  0.0',
    'PT  2  1.0',
    'PT  3  0.01',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.equal(par.pa.get(1), 10);
  assert.equal(par.pa.get(2), 100);
  assert.equal(par.pa.get(3), 10);
});

test('ST: 状態初期値（1始まりを0始まりに変換）', () => {
  const src = [
    'ST    1  5.00000000D-01',
    'ST    2  -2.00000000D+00',
    'NS     2',
    'IN     2',
    'ND     0',
    'NO     100',
    'OP     1',
    'PT  1  0.0',
    'PT  2  1.0',
    'PT  3  0.01',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.equal(par.stateInit.get(0), 0.5);
  assert.equal(par.stateInit.get(1), -2);
});

test('LA/SU: ラベルとシンボル', () => {
  const src = [
    'LA  1  Displacement',
    'LA  2  Velocity',
    'SU  1  X',
    'NS     2',
    'IN     2',
    'ND     0',
    'NO     100',
    'OP     2',
    'PT  1  0.0',
    'PT  2  1.0',
    'PT  3  0.01',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.equal(par.labels.get(1), 'Displacement');
  assert.equal(par.labels.get(2), 'Velocity');
  assert.equal(par.stateSymbols.get(1), 'X');
});

test('Fortran の D 指数表記 (D+01) を扱える', () => {
  const src = [
    'PA    1  1.23456789D+02',
    'PA    2  2.50000000D-03',
    'NS     1',
    'IN     1',
    'ND     0',
    'NO     10',
    'OP     1',
    'PT  1  0.0D+00',
    'PT  2  1.0D+00',
    'PT  3  1.0D-02',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.ok(Math.abs(par.pa.get(1)! - 123.456789) < 1e-12);
  assert.equal(par.pa.get(2), 2.5e-3);
});

test('END がないとエラー', () => {
  const src = ['NS     2', 'IN     2', 'ND     0', 'NO     10', 'OP     1'].join('\n');
  assert.throws(() => parsePar(src), /missing END/);
});

test('PT が欠けているとエラー', () => {
  const src = ['NS     2', 'IN     2', 'ND     0', 'NO     10', 'OP     1', 'PT  1  0.0', 'END'].join('\n');
  assert.throws(() => parsePar(src), /PT records incomplete/);
});

test('不明なレコードタイプでエラー', () => {
  const src = ['XY     1', 'NS     2', 'END'].join('\n');
  assert.throws(() => parsePar(src), ParParseError);
});

test('空行・コメント行はスキップされる', () => {
  const src = [
    '',
    'NS     2',
    '',
    'IN     2',
    'ND     0',
    'NO     10',
    'OP     1',
    'PT  1  0.0',
    'PT  2  1.0',
    'PT  3  0.01',
    'END',
  ].join('\n');

  const par = parsePar(src);
  assert.equal(par.NS, 2);
});
