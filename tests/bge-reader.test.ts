/**
 * BgeReader（低レベルBGEファイル読み取り）の動作検証。
 *
 * 重要発見: 型コード 2/3/4/5 は整数の幅分類にすぎず、文字列かどうかは
 * 文法位置に依存する。このテストは「アトム読み」と「明示的な文字列バイト読み」が
 * 正しく連携することを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BgeReader, BgeParseError } from '../src/parser/bgeReader.ts';

const enc = new TextEncoder();

test('アトム読み: 各種型コードを正しく識別する', () => {
  const r = new BgeReader(enc.encode('2 9 4 714 5 10000 3 -1'));
  const a1 = r.readAtom();
  assert.deepEqual({ code: a1.code, value: a1.value }, { code: 2, value: 9 });
  const a2 = r.readAtom();
  assert.deepEqual({ code: a2.code, value: a2.value }, { code: 4, value: 714 });
  const a3 = r.readAtom();
  assert.deepEqual({ code: a3.code, value: a3.value }, { code: 5, value: 10000 });
  const a4 = r.readAtom();
  assert.deepEqual({ code: a4.code, value: a4.value }, { code: 3, value: -1 });
  assert.ok(r.atEnd());
});

test('文字列読み: 長さアトム + 指定バイト数の流れ', () => {
  //   "2 3 EIN" = 長さ3、内容 "EIN"
  //   その後続けて "2 4 10.0" = 長さ4、内容 "10.0"
  const r = new BgeReader(enc.encode('2 3 EIN2 4 10.0'));
  const s1 = r.readLengthPrefixedString();
  assert.equal(s1, 'EIN');
  const s2 = r.readLengthPrefixedString();
  assert.equal(s2, '10.0');
});

test('文字列: 長さ6の "E=EIN;" を読む', () => {
  const r = new BgeReader(enc.encode('2 6 E=EIN;'));
  const s = r.readLengthPrefixedString();
  assert.equal(s, 'E=EIN;');
});

test('peekAtom は位置を進めない', () => {
  const r = new BgeReader(enc.encode('2 9 2 5'));
  const p = r.peekAtom();
  assert.equal(p.value, 9);
  const a = r.readAtom();
  assert.equal(a.value, 9);
  const p2 = r.peekAtom();
  assert.equal(p2.value, 5);
});

test('未接続を表す整数 -1 を読む', () => {
  const r = new BgeReader(enc.encode('3 -1 2 0'));
  assert.equal(r.readAtom().value, -1);
  assert.equal(r.readAtom().value, 0);
});

test('readIntOfCode: コード検証', () => {
  const r = new BgeReader(enc.encode('2 9'));
  assert.equal(r.readIntOfCode(2), 9);

  const r2 = new BgeReader(enc.encode('4 714'));
  assert.throws(() => r2.readIntOfCode(2), BgeParseError);
});

test('Shift-JIS 文字列（日本語）をデコードできる', () => {
  // "かな" のSJIS バイト列: 0x82, 0xa9, 0x82, 0xc8 = 4 bytes
  const header = enc.encode('2 4 ');
  const sjisKana = new Uint8Array([0x82, 0xa9, 0x82, 0xc8]);
  const combined = new Uint8Array(header.length + sjisKana.length);
  combined.set(header, 0);
  combined.set(sjisKana, header.length);

  const r = new BgeReader(combined);
  const s = r.readLengthPrefixedString();
  assert.equal(s, 'かな');
});

test('空文字列 (length=0) も扱える', () => {
  const r = new BgeReader(enc.encode('2 0 2 5'));
  const s = r.readLengthPrefixedString();
  assert.equal(s, '');
  const a = r.readAtom();
  assert.equal(a.value, 5);
});

test('不正な型コードで BgeParseError', () => {
  const r = new BgeReader(enc.encode('9 1'));
  assert.throws(() => r.readAtom(), BgeParseError);
});

test('バッファ末尾を越える文字列長でエラー', () => {
  const r = new BgeReader(enc.encode('2 100 abc'));
  assert.throws(() => r.readLengthPrefixedString(), BgeParseError);
});
