/**
 * 最終検証: TypeScript版の出力 vs Mr.Bond オリジナルC版の出力
 *
 * リファレンスCSVは：
 *   - MRBOND/Runge.c + Downloads/mrbond_20260421/temp.c を macOS 上で
 *     `cc -std=c89` でコンパイルして生成
 *   - Mr.Bond（Windows）の実出力 `CSV_files/test1.csv` と改行コードを除いて
 *     完全バイト一致することを検証済み
 *
 * このテストがパスすれば「**我々の TypeScript 版は Mr.Bond と数値的に同一**
 * である」ことを証明したことになる。
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
const REF_CSV_PATH = join(__dirname, 'fixtures', 'springMassDamper.expected.csv');

test('TS版CSVがMr.Bondリファレンスと全行で数値的に一致する（1e-10 精度）', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  const refSrc = await readFile(REF_CSV_PATH, 'utf8');
  const refLines = refSrc.trimEnd().split(/\r?\n/);
  const tsLines = result.csv.trimEnd().split('\n');

  assert.equal(
    tsLines.length,
    refLines.length,
    `行数一致: TS=${tsLines.length}, Ref=${refLines.length}`,
  );

  // ヘッダ行は書式一致
  assert.equal(tsLines[0], refLines[0], `ヘッダ: TS="${tsLines[0]}", Ref="${refLines[0]}"`);

  let maxAbsError = 0;
  let maxRelError = 0;
  let worstLine = 0;

  for (let i = 1; i < refLines.length; i++) {
    const tsParts = tsLines[i]!.split(',').map((s) => Number.parseFloat(s.trim()));
    const refParts = refLines[i]!.split(',').map((s) => Number.parseFloat(s.trim()));
    assert.equal(
      tsParts.length,
      refParts.length,
      `列数不一致 line ${i}: TS=${tsLines[i]}, Ref=${refLines[i]}`,
    );

    for (let j = 0; j < refParts.length; j++) {
      const absErr = Math.abs(tsParts[j]! - refParts[j]!);
      const refMag = Math.max(Math.abs(refParts[j]!), 1e-12);
      const relErr = absErr / refMag;
      if (absErr > maxAbsError) {
        maxAbsError = absErr;
        worstLine = i;
      }
      if (relErr > maxRelError) maxRelError = relErr;
    }
  }

  assert.ok(
    maxAbsError < 1e-10,
    `最大絶対誤差 ${maxAbsError} (許容 1e-10)、最悪行 ${worstLine}: "${tsLines[worstLine]}" vs "${refLines[worstLine]}"`,
  );
  assert.ok(maxRelError < 1e-9, `最大相対誤差 ${maxRelError} (許容 1e-9)`);
});

test('TS版CSVがMr.Bondリファレンスと(改行除き)バイト一致を目指す（情報テスト）', async () => {
  const parSrc = await readFile(PAR_PATH, 'utf8');
  const par = parsePar(parSrc);

  const result = runSimulation({
    par,
    func: buildMrBondFunc(par.pa),
    dout: buildMrBondDout(),
  });

  const refSrc = (await readFile(REF_CSV_PATH, 'utf8')).replace(/\r\n/g, '\n');
  const tsOutput = result.csv;

  // 差異がある行を全部数える（まずは情報として）
  const refLines = refSrc.trimEnd().split('\n');
  const tsLines = tsOutput.trimEnd().split('\n');
  let exactMatches = 0;
  let mismatches: { line: number; ref: string; ts: string }[] = [];
  for (let i = 0; i < Math.min(refLines.length, tsLines.length); i++) {
    if (refLines[i] === tsLines[i]) {
      exactMatches++;
    } else if (mismatches.length < 3) {
      mismatches.push({ line: i, ref: refLines[i]!, ts: tsLines[i]! });
    }
  }

  console.log(`   バイト完全一致: ${exactMatches} / ${refLines.length} 行`);
  if (mismatches.length > 0) {
    console.log(`   差異例（先頭3件）:`);
    for (const m of mismatches) {
      console.log(`     line ${m.line}:`);
      console.log(`       Ref: ${m.ref}`);
      console.log(`       TS : ${m.ts}`);
    }
  }

  // このテストは情報目的で、完全一致は努力目標。最低限「50% 以上一致」なら合格。
  assert.ok(
    exactMatches / refLines.length > 0.5,
    `バイト一致率 ${((exactMatches / refLines.length) * 100).toFixed(1)}% は 50% を超えるべき`,
  );
});
