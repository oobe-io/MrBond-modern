#!/usr/bin/env tsx
/**
 * 全モデル一括検証スクリプト。
 *
 * 使い方:
 *   tsx scripts/verifyAll.ts <fixtures-root>
 *
 * 動作: <fixtures-root>/<model>/temp.c + temp.PAR ペアで
 *   verify CLI と同じ処理を実行し、結果を一覧表示する。
 *
 * fixtures-root 例:
 *   /tmp/mrbond_collected/fixtures
 */

import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePar } from '../src/parser/parFile.ts';
import { buildFuncAndDout } from '../src/transpiler/transpileTempC.ts';
import { runSimulation } from '../src/runtime/runSimulation.ts';

const RUNGE_C = resolve(
  '/Users/kmh_pr03/Library/CloudStorage/GoogleDrive-morooka@oobe-io.com/マイドライブ/oobe/1. Dev/九州工業大学/MRBOND/Runge.c',
);

interface Result {
  model: string;
  status: '✓' | '✘' | '⊘';
  message: string;
  matchRate?: string;
  cTime?: number;
  tsTime?: number;
}

async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // stdio を 'ignore' にして子プロセスの stdout を捨てる。
    // Mr.Bond の Runge.c は printf で大量にプログレス出力するため、
    // デフォルトの 'pipe' だとバッファが埋まり子プロセスがブロックする。
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stderr, timedOut });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

async function verifyOne(fixturesRoot: string, modelName: string, rungeSrc: string): Promise<Result> {
  const dir = join(fixturesRoot, modelName);
  const parPath = join(dir, 'temp.PAR');
  const cPath = join(dir, 'temp.c');

  // ファイル存在と中身チェック
  try {
    const parStat = await stat(parPath);
    const cStat = await stat(cPath);
    if (parStat.size === 0) return { model: modelName, status: '⊘', message: 'temp.PAR empty' };
    if (cStat.size === 0) return { model: modelName, status: '⊘', message: 'temp.c empty' };
  } catch {
    return { model: modelName, status: '⊘', message: 'files missing' };
  }

  const workDir = join(tmpdir(), `verify_${modelName.replace(/[^\w]/g, '_')}_${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  try {
    // C コードの準備と compile
    const cSrc = await readFile(cPath, 'utf8');
    const parSrc = await readFile(parPath, 'utf8');

    await writeFile(join(workDir, 'runge.c'), rungeSrc, 'utf8');
    await writeFile(join(workDir, 'temp.c'), cSrc, 'utf8');
    await writeFile(join(workDir, 'temp.PAR'), parSrc, 'utf8');

    const cStart = performance.now();
    const compile = await runCmd('cc', ['-std=c89', '-w', '-o', 'sim', 'runge.c', 'temp.c', '-lm'], workDir, 15000);
    if (compile.code !== 0) {
      return {
        model: modelName,
        status: '✘',
        message: `C compile failed: ${compile.stderr.split('\n')[0]?.slice(0, 120)}`,
      };
    }

    const cRun = await runCmd('./sim', [], workDir, 180000);
    const cTime = performance.now() - cStart;
    if (cRun.timedOut) {
      return { model: modelName, status: '✘', message: `C run timed out after 180s (likely infinite loop or stiff system)`, cTime };
    }
    if (cRun.code !== 0) {
      return { model: modelName, status: '✘', message: `C run failed (code=${cRun.code}): ${cRun.stderr.slice(0, 120)}`, cTime };
    }

    const refCsv = (await readFile(join(workDir, 'temp.csv'), 'utf8')).replace(/\r\n/g, '\n');

    // TS 実行（タイムアウト付き）
    const tsStart = performance.now();
    const par = parsePar(parSrc);
    const { func, dout } = buildFuncAndDout(cSrc, par.pa);
    const tsRunResult = await Promise.race([
      Promise.resolve().then(() => runSimulation({ par, func, dout })),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300000)),
    ]);
    if (tsRunResult === 'timeout') {
      return { model: modelName, status: '✘', message: 'TS run timed out after 300s', cTime };
    }
    const tsResult = tsRunResult;
    const tsTime = performance.now() - tsStart;

    // 比較
    const refLines = refCsv.trimEnd().split('\n');
    const tsLines = tsResult.csv.trimEnd().split('\n');
    if (refLines.length !== tsLines.length) {
      return {
        model: modelName,
        status: '✘',
        message: `line count mismatch: ref=${refLines.length}, ts=${tsLines.length}`,
        cTime,
        tsTime,
      };
    }

    let matches = 0;
    let firstDiffLine = -1;
    for (let i = 0; i < refLines.length; i++) {
      if (refLines[i] === tsLines[i]) matches++;
      else if (firstDiffLine === -1) firstDiffLine = i;
    }
    const rate = ((matches / refLines.length) * 100).toFixed(2);

    if (matches === refLines.length) {
      return {
        model: modelName,
        status: '✓',
        message: `${matches}/${refLines.length} byte-identical`,
        matchRate: rate,
        cTime,
        tsTime,
      };
    }
    return {
      model: modelName,
      status: '✘',
      message: `${matches}/${refLines.length} lines match (${rate}%), first diff line ${firstDiffLine}`,
      matchRate: rate,
      cTime,
      tsTime,
    };
  } catch (err) {
    return {
      model: modelName,
      status: '✘',
      message: `error: ${(err as Error).message.slice(0, 200)}`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturesRoot = process.argv[2];
  if (!fixturesRoot) {
    console.error('Usage: tsx scripts/verifyAll.ts <fixtures-root>');
    process.exit(1);
  }

  console.error(`Scanning ${fixturesRoot}…`);
  const dirs = (await readdir(fixturesRoot)).sort();
  console.error(`Found ${dirs.length} model directories\n`);

  // Runge.c を一度読み込んで共有（windows.h 削除版を各 verify で使う）
  const rungeSrc = (await readFile(RUNGE_C, 'utf8')).replace(
    '#include<windows.h>',
    '/* windows.h removed */',
  );

  const results: Result[] = [];
  for (const model of dirs) {
    process.stderr.write(`  ${model.padEnd(45)} ...`);
    const result = await verifyOne(fixturesRoot, model, rungeSrc);
    results.push(result);
    const timing = result.cTime && result.tsTime
      ? ` C=${result.cTime.toFixed(0)}ms TS=${result.tsTime.toFixed(0)}ms`
      : '';
    process.stderr.write(` ${result.status}  ${result.message}${timing}\n`);
  }

  // サマリー
  const pass = results.filter((r) => r.status === '✓').length;
  const fail = results.filter((r) => r.status === '✘').length;
  const skip = results.filter((r) => r.status === '⊘').length;

  console.error('\n=== Summary ===');
  console.error(`  ✓ pass: ${pass}`);
  console.error(`  ✘ fail: ${fail}`);
  console.error(`  ⊘ skip: ${skip} (files missing or empty)`);
  console.error(`  total:  ${results.length}`);

  if (fail > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
