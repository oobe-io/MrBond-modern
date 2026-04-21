/**
 * BGS（Mr.Bond のボンドグラフ中間表現）パーサの検証。
 *
 * fixture: tests/fixtures/springMassDamper.BGS
 * このファイルは Windows 上で Mr.Bond が実際に生成したもの。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBgs } from '../src/parser/bgsFile.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BGS_PATH = join(__dirname, 'fixtures', 'springMassDamper.BGS');

test('BGS: トポロジが正しく読み取れる（要素数 9、ボンド数 9）', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  // 要素数 9 (SE1, OJ, II1, ZJ, ZJ, CI1, RE1, OJ, SF1)
  assert.equal(bgs.elements.length, 9, `要素数: ${bgs.elements.length}`);

  // 種別分類
  const byKind = new Map<string, number>();
  for (const el of bgs.elements) {
    byKind.set(el.kind, (byKind.get(el.kind) ?? 0) + 1);
  }
  assert.equal(byKind.get('Se'), 1, 'SE (Source of Effort) 1 個');
  assert.equal(byKind.get('Sf'), 1, 'SF (Source of Flow) 1 個');
  assert.equal(byKind.get('I'), 1, 'I (慣性) 1 個');
  assert.equal(byKind.get('C'), 1, 'C (容量) 1 個');
  assert.equal(byKind.get('R'), 1, 'R (抵抗) 1 個');
  assert.equal(byKind.get('OneJunction'), 2, '1-junction 2 個');
  assert.equal(byKind.get('ZeroJunction'), 2, '0-junction 2 個');
});

test('BGS: 各要素のボンド接続', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  const findByName = (name: string) => bgs.elements.find((e) => e.name === name);

  const se1 = findByName('SE1');
  assert.ok(se1);
  assert.deepEqual(se1!.bonds, [1], 'SE1 は bond 1 に接続');

  const ii1 = findByName('II1');
  assert.ok(ii1);
  assert.deepEqual(ii1!.bonds, [2], 'II1 は bond 2 に接続');

  const ci1 = findByName('CI1');
  assert.ok(ci1);
  assert.deepEqual(ci1!.bonds, [5], 'CI1 は bond 5');

  const re1 = findByName('RE1');
  assert.ok(re1);
  assert.deepEqual(re1!.bonds, [6], 'RE1 は bond 6');

  const sf1 = findByName('SF1');
  assert.ok(sf1);
  assert.deepEqual(sf1!.bonds, [9], 'SF1 は bond 9');
});

test('BGS: ジャンクションの接続（符号付きボンド番号）', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  // 1-junction (OJ): 右（SE1側）の 1-junction は bond 3, 2, -1, 4 に接続
  const oneJunctions = bgs.elements.filter((e) => e.kind === 'OneJunction');
  assert.equal(oneJunctions.length, 2);
  // 最初の 1-junction が OJ 3 2 -1 4
  assert.deepEqual(oneJunctions[0]!.bonds, [3, 2, -1, 4]);
  // 2つ目の 1-junction (SF1側)
  assert.deepEqual(oneJunctions[1]!.bonds, [9, -8, -7]);
});

test('BGS: パラメータと式（EIN=10, M=10, PK=100, PCF=10, PF=0）', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  const se1 = bgs.elements.find((e) => e.name === 'SE1')!;
  assert.equal(se1.parameters[0]?.name, 'EIN');
  assert.equal(se1.parameters[0]?.value, 10);
  assert.ok(se1.equations.includes('E=EIN;'));

  const ii1 = bgs.elements.find((e) => e.name === 'II1')!;
  assert.equal(ii1.parameters[0]?.name, 'M');
  assert.equal(ii1.parameters[0]?.value, 10);
  assert.ok(ii1.equations.includes('L=Z/M;'));

  const ci1 = bgs.elements.find((e) => e.name === 'CI1')!;
  assert.equal(ci1.parameters[0]?.name, 'PK');
  assert.equal(ci1.parameters[0]?.value, 100);
  assert.ok(ci1.equations.includes('C=PK*Z;'));

  const re1 = bgs.elements.find((e) => e.name === 'RE1')!;
  assert.equal(re1.parameters[0]?.name, 'PCF');
  assert.equal(re1.parameters[0]?.value, 10);

  const sf1 = bgs.elements.find((e) => e.name === 'SF1')!;
  assert.equal(sf1.parameters[0]?.name, 'PF');
  assert.equal(sf1.parameters[0]?.value, 0);
});

test('BGS: 出力変数', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  assert.equal(bgs.outputs.length, 1);
  assert.equal(bgs.outputs[0]?.variable, 'DP2');
});

test('BGS: シミュレーション設定', async () => {
  const src = await readFile(BGS_PATH, 'utf8');
  const bgs = parseBgs(src);

  assert.equal(bgs.simulation.T0, 0);
  assert.equal(bgs.simulation.T1, 10);
  assert.equal(bgs.simulation.dt, 1e-5);
  assert.equal(bgs.simulation.numOutputSteps, 1000);
});

test('BGS: エラーケース（不正な要素タイプ）', () => {
  const bad = ['BOND SYMBOL EXPR', 'XX1  1', '/', 'BC: X X', '/', 'XX1', 'PA: x 0.0', 'E=0;', 'EOD', '/', '0 1 0.01 10'].join('\n');
  assert.throws(() => parseBgs(bad), /unknown element prefix/);
});
