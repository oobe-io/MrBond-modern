/**
 * 最終統合テスト: temp.c を自動変換 → シミュレーション → リファレンスCSVと完全一致。
 *
 * これがパスすれば:
 *   BGE → (Mr.Bond GUI) → temp.c + temp.PAR →
 *     (自動変換) → シミュレーション → Mr.Bond互換CSV
 * の完全自動パイプラインが立った証明になる。
 * 任意の Mr.Bond モデルを手動移植ゼロで扱える。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePar } from '../src/parser/parFile.ts';
import { runSimulation } from '../src/runtime/runSimulation.ts';
import { buildFuncAndDout } from '../src/transpiler/transpileTempC.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAR_PATH = join(__dirname, 'fixtures', 'springMassDamper.PAR');
const C_PATH = join(__dirname, 'fixtures', 'springMassDamper.model.c');
const REF_CSV_PATH = join(__dirname, 'fixtures', 'springMassDamper.expected.csv');

test('Transpiler E2E: 自動変換パイプラインが Mr.Bond の CSV とバイト完全一致', async () => {
  const [cSrc, parSrc, refSrc] = await Promise.all([
    readFile(C_PATH, 'utf8'),
    readFile(PAR_PATH, 'utf8'),
    readFile(REF_CSV_PATH, 'utf8'),
  ]);

  const par = parsePar(parSrc);
  const { func, dout } = buildFuncAndDout(cSrc, par.pa);
  const result = runSimulation({ par, func, dout });

  const ref = refSrc.replace(/\r\n/g, '\n');
  const expectedLines = ref.trimEnd().split('\n');
  const actualLines = result.csv.trimEnd().split('\n');

  assert.equal(
    actualLines.length,
    expectedLines.length,
    `行数: 期待 ${expectedLines.length}, 実測 ${actualLines.length}`,
  );

  let diffCount = 0;
  const diffs: { line: number; expected: string; actual: string }[] = [];
  for (let i = 0; i < expectedLines.length; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      diffCount++;
      if (diffs.length < 3) {
        diffs.push({ line: i, expected: expectedLines[i]!, actual: actualLines[i]! });
      }
    }
  }

  if (diffCount > 0) {
    const msg = diffs
      .map((d) => `  line ${d.line}:\n    exp: ${d.expected}\n    got: ${d.actual}`)
      .join('\n');
    assert.fail(`${diffCount}/${expectedLines.length} 行で差異:\n${msg}`);
  }
  console.log(`   自動変換経由で ${expectedLines.length}/${expectedLines.length} 行バイト一致`);
});

test('Transpiler: 要素関数が正しく分離されている', async () => {
  const cSrc = await readFile(C_PATH, 'utf8');
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  // buildFuncAndDout が例外出さずに動くこと
  const { func, dout } = buildFuncAndDout(cSrc, par.pa);
  assert.equal(typeof func, 'function');
  assert.equal(typeof dout, 'function');

  // 初期状態で func 呼び出しが正しく動くか
  const x = [0, 0, 0];
  const dx = [0, 0, 0];
  func(0, x, dx);
  // バネ-マス-ダンパ: X=[0,0,0] で DX[0] = EIN = 10, DX[1] = 0, DX[2] = 0
  assert.ok(Math.abs(dx[0]! - 10) < 1e-12, `DX[0] 期待 10, 実測 ${dx[0]}`);
  assert.ok(Math.abs(dx[1]!) < 1e-12, `DX[1] 期待 0, 実測 ${dx[1]}`);
  assert.ok(Math.abs(dx[2]!) < 1e-12, `DX[2] 期待 0, 実測 ${dx[2]}`);
});
