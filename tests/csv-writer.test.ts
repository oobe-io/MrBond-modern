/**
 * CSV 出力フォーマッタの検証。
 *
 * Mr.Bond の実CSV出力（MRBOND/CSV_files/test1.csv）の先頭数行を
 * 参照として、同じ入力に対してバイト一致するかを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExponential,
  formatHeader,
  formatRow,
  formatCsv,
} from '../src/output/csvWriter.ts';

test('指数表記: C の %e と完全一致する（6桁精度、2桁以上ゼロ埋め指数）', () => {
  assert.equal(formatExponential(1e-2), '1.000000e-02');
  assert.equal(formatExponential(1), '1.000000e+00');
  assert.equal(formatExponential(-1), '-1.000000e+00');
  assert.equal(formatExponential(4.98296e-5), '4.982960e-05');
  assert.equal(formatExponential(1.23e10), '1.230000e+10');
  assert.equal(formatExponential(0), '0.000000e+00');
});

test('ヘッダ: Mr.Bondの "TIME         , DP2" 形式と一致する', () => {
  const header = formatHeader(['DP2']);
  // 実ファイル test1.csv の1行目
  assert.equal(header, 'TIME         , DP2');
});

test('ヘッダ: 複数ラベル', () => {
  const header = formatHeader(['A', 'B', 'C']);
  // 最後のラベルだけ先頭スペース付き、他はカンマ直結
  assert.equal(header, 'TIME         ,A,B, C');
});

test('ヘッダ: ラベル0個のとき', () => {
  const header = formatHeader([]);
  assert.equal(header, 'TIME         ,');
});

test('データ行: Mr.Bondの "0.000000e+00, 0.000000e+00" 形式と一致する', () => {
  // test1.csv 2行目
  const row = formatRow(0, [0]);
  assert.equal(row, '0.000000e+00, 0.000000e+00');
});

test('データ行: "1.000000e-02, 4.982960e-05"', () => {
  // test1.csv 3行目
  const row = formatRow(1e-2, [4.98296e-5]);
  assert.equal(row, '1.000000e-02, 4.982960e-05');
});

test('データ行: 負値のときは先頭スペースなし', () => {
  const row = formatRow(0.5, [-1.23e-4, 2.5e3]);
  assert.equal(row, '5.000000e-01,-1.230000e-04, 2.500000e+03');
});

test('データ行: 全て負値', () => {
  const row = formatRow(1, [-1, -2, -3]);
  assert.equal(row, '1.000000e+00,-1.000000e+00,-2.000000e+00,-3.000000e+00');
});

test('完全CSV: ヘッダ + 複数行', () => {
  const csv = formatCsv(
    ['DP2'],
    [
      { time: 0, values: [0] },
      { time: 1e-2, values: [4.98296e-5] },
      { time: 1.999e-2, values: [1.984093e-4] },
    ],
  );
  const expected =
    'TIME         , DP2\n' +
    '0.000000e+00, 0.000000e+00\n' +
    '1.000000e-02, 4.982960e-05\n' +
    '1.999000e-02, 1.984093e-04\n';
  assert.equal(csv, expected);
});

test('Mr.Bondの test1.csv 冒頭5行と完全一致する', async () => {
  // 実ファイルの最初の5行を入力値から再構築できるか検証
  const testCases = [
    { time: 0, value: 0 },
    { time: 1e-2, value: 4.98296e-5 },
    { time: 1.999e-2, value: 1.984093e-4 },
    { time: 2.998e-2, value: 4.446102e-4 },
  ];

  const rows = testCases.map(({ time, value }) => ({
    time,
    values: [value],
  }));
  const csv = formatCsv(['DP2'], rows);

  const expected =
    'TIME         , DP2\n' +
    '0.000000e+00, 0.000000e+00\n' +
    '1.000000e-02, 4.982960e-05\n' +
    '1.999000e-02, 1.984093e-04\n' +
    '2.998000e-02, 4.446102e-04\n';
  assert.equal(csv, expected);
});
