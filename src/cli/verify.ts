#!/usr/bin/env tsx
/**
 * CLI: Mr.Bond の temp.c + temp.PAR を与えると、オリジナル C 実装と
 * TypeScript 実装を両方走らせて、出力が一致するか検証する。
 *
 * 使い方:
 *   tsx src/cli/verify.ts <temp.PAR> <temp.c> [--runge ../MRBOND/Runge.c]
 *
 * 動作:
 *   1. MRBOND/Runge.c を拾う（既定パス or --runge で指定）。windows.h は削除して
 *      一時ディレクトリにコピー。
 *   2. `cc -std=c89 -w` で runge.c + temp.c をコンパイル。
 *   3. 生成されたバイナリを実行して temp.csv を得る（参照出力）。
 *   4. TypeScript 版を走らせて別の CSV を得る。
 *   5. 両者を正規化（CRLF→LF）して行ごと差分を報告。
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePar } from '../parser/parFile.ts';
import { buildFuncAndDout } from '../transpiler/transpileTempC.ts';
import { runSimulation } from '../runtime/runSimulation.ts';

const DEFAULT_RUNGE_C = resolve(
  '/Users/kmh_pr03/Library/CloudStorage/GoogleDrive-morooka@oobe-io.com/マイドライブ/oobe/1. Dev/九州工業大学/MRBOND/Runge.c',
);

interface CliArgs {
  parPath: string;
  cPath: string;
  rungePath: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let rungePath = DEFAULT_RUNGE_C;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--runge') {
      const next = argv[i + 1];
      if (!next) throw new Error('--runge requires a path');
      rungePath = next;
      i++;
    } else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    printUsage();
    process.exit(1);
  }
  return { parPath: positional[0]!, cPath: positional[1]!, rungePath };
}

function printUsage(): void {
  console.error(
    [
      'Usage: tsx src/cli/verify.ts <temp.PAR> <temp.c> [--runge path/to/Runge.c]',
      '',
      'Runs both the original C simulator and the TypeScript port,',
      'and verifies their outputs match byte-for-byte.',
    ].join('\n'),
  );
}

async function runCmd(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = cwd ? spawn(cmd, args, { cwd }) : spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    proc.on('error', (err) => rejectPromise(err));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.error('=== Mr.Bond verification pipeline ===');
  console.error(`  PAR:   ${args.parPath}`);
  console.error(`  C:     ${args.cPath}`);
  console.error(`  Runge: ${args.rungePath}`);

  // ------ 1. 参照 C バイナリのビルド ------
  const workDir = join(tmpdir(), `mrbond_verify_${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const rungeSrc = (await readFile(args.rungePath, 'utf8'))
      .replace('#include<windows.h>', '/* windows.h removed for non-Windows build */');
    await writeFile(join(workDir, 'runge.c'), rungeSrc, 'utf8');

    const userC = await readFile(args.cPath, 'utf8');
    await writeFile(join(workDir, 'temp.c'), userC, 'utf8');

    const parSrc = await readFile(args.parPath, 'utf8');
    await writeFile(join(workDir, 'temp.PAR'), parSrc, 'utf8');

    console.error('\n[1/3] Compiling original C...');
    const compileT0 = performance.now();
    const compileResult = await runCmd(
      'cc',
      ['-std=c89', '-w', '-o', 'mrbond_sim', 'runge.c', 'temp.c', '-lm'],
      workDir,
    );
    if (compileResult.code !== 0) {
      console.error(`      compile failed: ${compileResult.stderr}`);
      process.exit(1);
    }
    console.error(`      OK (${(performance.now() - compileT0).toFixed(0)}ms)`);

    console.error('[2/3] Running original C simulator...');
    const cRunT0 = performance.now();
    const cRun = await runCmd('./mrbond_sim', [], workDir);
    if (cRun.code !== 0) {
      console.error(`      C run failed: ${cRun.stderr}`);
      process.exit(1);
    }
    const refCsv = (await readFile(join(workDir, 'temp.csv'), 'utf8')).replace(/\r\n/g, '\n');
    console.error(`      OK (${(performance.now() - cRunT0).toFixed(0)}ms), ${refCsv.split('\n').length - 1} rows`);

    console.error('[3/3] Running TypeScript simulator...');
    const tsT0 = performance.now();
    const par = parsePar(parSrc);
    const { func, dout } = buildFuncAndDout(userC, par.pa);
    const tsResult = runSimulation({ par, func, dout });
    console.error(
      `      OK (${(performance.now() - tsT0).toFixed(0)}ms), ${tsResult.rowCount} rows`,
    );

    // ------ 4. 比較 ------
    console.error('\n=== Comparison ===');
    const refLines = refCsv.trimEnd().split('\n');
    const tsLines = tsResult.csv.trimEnd().split('\n');

    if (refLines.length !== tsLines.length) {
      console.error(`  ✘ Line count mismatch: ref=${refLines.length}, ts=${tsLines.length}`);
      process.exit(1);
    }

    let exactMatches = 0;
    const diffs: { line: number; ref: string; ts: string }[] = [];
    for (let i = 0; i < refLines.length; i++) {
      if (refLines[i] === tsLines[i]) exactMatches++;
      else if (diffs.length < 5) {
        diffs.push({ line: i, ref: refLines[i]!, ts: tsLines[i]! });
      }
    }

    const rate = ((exactMatches / refLines.length) * 100).toFixed(3);
    if (exactMatches === refLines.length) {
      console.error(`  ✓ ALL ${refLines.length} lines match byte-for-byte (${rate}%)`);
    } else {
      console.error(`  ✘ Matched ${exactMatches}/${refLines.length} (${rate}%)`);
      console.error('    First differences:');
      for (const d of diffs) {
        console.error(`      line ${d.line}:`);
        console.error(`        ref: ${d.ref}`);
        console.error(`        ts : ${d.ts}`);
      }
      process.exit(2);
    }
  } finally {
    // クリーンアップ
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
