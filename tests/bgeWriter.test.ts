/**
 * BGE ライタ（web/editor/io/bgeWriter.ts）の動作検証。
 *
 * 合格基準:
 *   1. 空のドキュメントを書き出してバイト列が生成される
 *   2. バネ-マス-ダンパ相当の小さな doc を書き出し、BgeReader で atom 列として
 *      歩き切れる（== ファイル末尾まで到達できる）
 *   3. ヘッダに書いた要素数とボンド数が reader から取れる
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BgeReader } from '../src/parser/bgeReader.ts';
import { writeBge } from '../web/editor/io/bgeWriter.ts';
import type { BondGraphDoc } from '../web/editor/shared/model.ts';

// ---- 1. 空ドキュメント ----

test('writeBge: 空ドキュメントを書き出せる', () => {
  const doc: BondGraphDoc = {
    elements: [],
    bonds: [],
    simulation: { t0: 0, t1: 10, dt: 1e-5, numOutputSteps: 1000 },
    outputs: [],
  };
  const bytes = writeBge(doc);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0, 'BGE output must be non-empty');

  // reader で先頭アトム2つ（要素数, ボンド数）を読めば 0, 0 になるはず
  const r = new BgeReader(bytes);
  const nElem = r.readAtom();
  const nBond = r.readAtom();
  assert.equal(nElem.value, 0);
  assert.equal(nBond.value, 0);
});

// ---- 2. バネ-マス-ダンパ相当の小さな doc ----

/**
 * 実物の BGS に対応するドキュメント（SE1, II1, CI1, RE1, SF1 + 1-junction 2つ + 0-junction 2つ）。
 * トポロジは簡略化して「5要素 + 2ジャンクション + 7ボンド」にする。
 * ラウンドトリップできることのみ検証（物理的正しさは別途 autoDerive テストで確認済み）。
 */
function springMassDamperLikeDoc(): BondGraphDoc {
  return {
    elements: [
      {
        id: 'el_1',
        kind: 'Se',
        label: 'SE1',
        position: { x: 100, y: 100 },
        parameters: [{ name: 'EIN', value: 10.0, unit: 'N' }],
        equation: 'E=EIN;',
      },
      {
        id: 'el_2',
        kind: 'OneJunction',
        label: 'OJ1',
        position: { x: 200, y: 100 },
        parameters: [],
      },
      {
        id: 'el_3',
        kind: 'I',
        label: 'I1',
        position: { x: 300, y: 100 },
        parameters: [{ name: 'M', value: 10.0, unit: 'kg' }],
        equation: 'L=Z/M;',
      },
      {
        id: 'el_4',
        kind: 'ZeroJunction',
        label: 'ZJ1',
        position: { x: 400, y: 100 },
        parameters: [],
      },
      {
        id: 'el_5',
        kind: 'C',
        label: 'C1',
        position: { x: 500, y: 100 },
        parameters: [{ name: 'PK', value: 100.0, unit: 'N/m' }],
        equation: 'C=PK*Z;',
      },
      {
        id: 'el_6',
        kind: 'R',
        label: 'R1',
        position: { x: 500, y: 200 },
        parameters: [{ name: 'PCF', value: 10.0, unit: 'Ns/m' }],
        equation: 'R=PCF*Z;',
      },
      {
        id: 'el_7',
        kind: 'Sf',
        label: 'SF1',
        position: { x: 600, y: 100 },
        parameters: [{ name: 'PF', value: 0.0, unit: 'm/s' }],
        equation: 'F=PF;',
      },
    ],
    bonds: [
      { id: 'bond_1', fromElementId: 'el_1', toElementId: 'el_2' },
      { id: 'bond_2', fromElementId: 'el_2', toElementId: 'el_3', causality: 'effortIn' },
      { id: 'bond_3', fromElementId: 'el_2', toElementId: 'el_4' },
      { id: 'bond_4', fromElementId: 'el_4', toElementId: 'el_5', causality: 'effortIn' },
      { id: 'bond_5', fromElementId: 'el_4', toElementId: 'el_6' },
      { id: 'bond_6', fromElementId: 'el_4', toElementId: 'el_7' },
      { id: 'bond_7', fromElementId: 'el_2', toElementId: 'el_7' },
    ],
    simulation: { t0: 0, t1: 10, dt: 1e-5, numOutputSteps: 1000 },
    outputs: [{ bondId: 'bond_2', variableName: 'Displacement', label: 'Displacement' }],
  };
}

test('writeBge: バネ-マス-ダンパ相当の doc を書き出せる', () => {
  const doc = springMassDamperLikeDoc();
  const bytes = writeBge(doc);
  assert.ok(bytes.length > 100, 'BGE should have a reasonable size');
});

test('writeBge: ヘッダから要素数/ボンド数が取れる', () => {
  const doc = springMassDamperLikeDoc();
  const bytes = writeBge(doc);

  const r = new BgeReader(bytes);
  const nElem = r.readAtom();
  const nBond = r.readAtom();
  assert.equal(nElem.value, doc.elements.length);
  assert.equal(nBond.value, doc.bonds.length);
});

test('writeBge: BgeReader で atom 列として最後まで歩ける', () => {
  const doc = springMassDamperLikeDoc();
  const bytes = writeBge(doc);

  const r = new BgeReader(bytes);
  // ヘッダ: 2 atoms + 9 ビュー atoms
  const nElem = r.readAtom().value;
  const nBond = r.readAtom().value;
  for (let i = 0; i < 9; i++) r.readAtom();

  // 要素ブロック: 各要素ごとに固定構造で読めるはず
  for (let i = 0; i < nElem; i++) {
    // type, subtype, grid_w, grid_h
    r.readAtom();
    r.readAtom();
    r.readAtom();
    r.readAtom();
    // bbox 4
    for (let j = 0; j < 4; j++) r.readAtom();
    // 8 ports × 4 = 32 atoms
    for (let j = 0; j < 32; j++) r.readAtom();
    // param_count
    const pc = r.readAtom().value;
    // name, value strings（params>=1 時のみ）
    if (pc >= 1) {
      r.readLengthPrefixedString();
      r.readLengthPrefixedString();
    }
    // 12 pad
    for (let j = 0; j < 12; j++) r.readAtom();
    // equation
    r.readLengthPrefixedString();
    // 10 tail pad
    for (let j = 0; j < 10; j++) r.readAtom();
  }

  // ボンドブロック: 各ボンド 4 + 8 + 4 + 2 = 18 atoms + initial_value string
  for (let i = 0; i < nBond; i++) {
    for (let j = 0; j < 4; j++) r.readAtom();
    for (let j = 0; j < 8; j++) r.readAtom();
    for (let j = 0; j < 4; j++) r.readAtom();
    for (let j = 0; j < 2; j++) r.readAtom();
    r.readLengthPrefixedString();
  }

  // シミュレーション設定
  r.readLengthPrefixedString(); // T0
  r.readLengthPrefixedString(); // T1
  r.readLengthPrefixedString(); // dt
  r.readAtom();                  // NOT

  // 出力変数
  const nOut = r.readAtom().value;
  for (let i = 0; i < nOut; i++) {
    r.readLengthPrefixedString(); // name
    r.readAtom();                  // 2 1
    r.readAtom();                  // bond index
  }

  // reader は末尾に達しているべき
  assert.ok(r.atEnd(), `reader should be at end, but cursor=${r.position}/${r.length}`);
});

test('writeBge: 書き出した BGE の先頭ヘッダが Shift-JIS デコードでも正しい ASCII', () => {
  const doc = springMassDamperLikeDoc();
  const bytes = writeBge(doc);
  // 先頭 40 バイトは全て ASCII（0-127）のはず
  for (let i = 0; i < Math.min(40, bytes.length); i++) {
    assert.ok((bytes[i] ?? 0) <= 0x7f, `byte at ${i} is non-ASCII: ${bytes[i]}`);
  }
});

test('writeBge: 出力変数レコードが reader から読み取れる', () => {
  const doc: BondGraphDoc = {
    elements: [
      { id: 'el_1', kind: 'Se', position: { x: 10, y: 10 }, parameters: [] },
      { id: 'el_2', kind: 'I', position: { x: 20, y: 10 }, parameters: [] },
    ],
    bonds: [{ id: 'bond_1', fromElementId: 'el_1', toElementId: 'el_2' }],
    simulation: { t0: 0, t1: 1, dt: 0.001, numOutputSteps: 100 },
    outputs: [{ bondId: 'bond_1', variableName: 'Effort', label: 'Effort' }],
  };
  const bytes = writeBge(doc);
  const r = new BgeReader(bytes);

  // ヘッダ (2 + 9 atoms)
  assert.equal(r.readAtom().value, 2); // nElem
  assert.equal(r.readAtom().value, 1); // nBond
  for (let i = 0; i < 9; i++) r.readAtom();

  // 2 要素ぶんスキップ
  for (let e = 0; e < 2; e++) {
    for (let j = 0; j < 8; j++) r.readAtom(); // type,subtype,grid,bbox
    for (let j = 0; j < 32; j++) r.readAtom(); // ports
    const pc = r.readAtom().value;
    if (pc >= 1) {
      r.readLengthPrefixedString();
      r.readLengthPrefixedString();
    }
    for (let j = 0; j < 12; j++) r.readAtom();
    r.readLengthPrefixedString();
    for (let j = 0; j < 10; j++) r.readAtom();
  }

  // 1 ボンドぶんスキップ
  for (let j = 0; j < 4; j++) r.readAtom();
  for (let j = 0; j < 8; j++) r.readAtom();
  for (let j = 0; j < 4; j++) r.readAtom();
  for (let j = 0; j < 2; j++) r.readAtom();
  r.readLengthPrefixedString();

  // シミュレーション
  const t0 = r.readLengthPrefixedString();
  const t1 = r.readLengthPrefixedString();
  const dt = r.readLengthPrefixedString();
  r.readAtom();

  assert.match(t0, /^0\.00000E\+00$/);
  assert.match(t1, /^1\.00000E\+00$/);
  assert.match(dt, /^1\.00000E-03$/);

  // 出力変数
  const nOut = r.readAtom().value;
  assert.equal(nOut, 1);
  const label = r.readLengthPrefixedString();
  assert.equal(label, 'Effort');
});
