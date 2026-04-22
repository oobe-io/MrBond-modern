#!/usr/bin/env tsx
/**
 * CLI: Mr.Bond の temp.c + temp.PAR を食わせて CSV を出力する。
 *
 * 使い方:
 *   tsx src/cli/runSim.ts <temp.PAR> <temp.c> [--out result.csv]
 *
 * 出力先を指定しなければ標準出力へ。
 * Mr.Bond のオリジナル実装とバイト互換の CSV を生成する。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parsePar } from '../parser/parFile.ts';
import { buildFuncAndDout } from '../transpiler/transpileTempC.ts';
import { runSimulation } from '../runtime/runSimulation.ts';

interface CliArgs {
  parPath: string;
  cPath: string;
  outPath?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out' || a === '-o') {
      const next = argv[i + 1];
      if (!next) throw new Error('--out requires a file path');
      outPath = next;
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
  return outPath
    ? { parPath: positional[0]!, cPath: positional[1]!, outPath }
    : { parPath: positional[0]!, cPath: positional[1]! };
}

function printUsage(): void {
  console.error(
    [
      'Usage: tsx src/cli/runSim.ts <temp.PAR> <temp.c> [--out result.csv]',
      '',
      'Runs a Mr.Bond simulation from the intermediate files (.PAR + .c)',
      'produced by Mr.Bond GUI, and prints a CSV that matches Mr.Bond\'s',
      'original output byte-for-byte.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [parSrc, cSrc] = await Promise.all([
    readFile(args.parPath, 'utf8'),
    readFile(args.cPath, 'utf8'),
  ]);

  const par = parsePar(parSrc);
  const { func, dout, fu } = buildFuncAndDout(cSrc, par.pa);

  const t0 = performance.now();
  const result = runSimulation({ par, func, dout, fu });
  const elapsedMs = performance.now() - t0;

  if (args.outPath) {
    await writeFile(args.outPath, result.csv, 'utf8');
    console.error(
      `Wrote ${result.rowCount} rows to ${args.outPath} in ${elapsedMs.toFixed(0)}ms`,
    );
  } else {
    process.stdout.write(result.csv);
    console.error(`[${result.rowCount} rows, ${elapsedMs.toFixed(0)}ms]`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
