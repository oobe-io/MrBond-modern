#!/usr/bin/env tsx
/**
 * BGEファイルをアトム列としてダンプする開発用ユーティリティ。
 *
 * 使用例:
 *   tsx scripts/dumpAtoms.ts <path-to-bge-file> [startIdx] [count]
 *
 * 出力: 1行1アトム、インデックス + バイト位置 + 型コード + 値。
 * 値が「直近の文字列長らしい」場合（発見的判定）は、可能性として
 * 次の N バイトも文字列プレビューとして表示する。
 */

import { readFile } from 'node:fs/promises';
import { BgeReader } from '../src/parser/bgeReader.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    console.error('Usage: tsx scripts/dumpAtoms.ts <file.BGE> [startIdx] [count]');
    process.exit(1);
  }
  const filePath = argv[0]!;
  const startIdx = argv[1] ? Number.parseInt(argv[1], 10) : 0;
  const count = argv[2] ? Number.parseInt(argv[2], 10) : 300;

  const buf = await readFile(filePath);
  const reader = new BgeReader(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));

  let i = 0;
  while (!reader.atEnd() && i < startIdx + count) {
    const snapshot = reader.position;
    try {
      const atom = reader.readAtom();
      if (i >= startIdx) {
        const line = `[${String(i).padStart(4)}] @${String(atom.startPos).padStart(5)}  code=${atom.code}  value=${atom.value}`;
        process.stdout.write(line);

        // 発見的: value が妥当な文字列長 (1..200) の場合、仮に文字列として
        // 読んでプレビューだけ表示（カーソルは必ず復元する）
        if (atom.value > 0 && atom.value <= 200 && !reader.atEnd()) {
          const savedPos = reader.position;
          try {
            const preview = reader.readStringBytes(atom.value);
            const escaped = preview.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
            process.stdout.write(`   [str?${atom.value}] "${escaped}"`);
          } catch {
            // プレビュー失敗は無視
          } finally {
            reader.seek(savedPos);
          }
        }
        process.stdout.write('\n');
      }
      i++;
    } catch (err) {
      console.error(`\nError at atom ${i}, byte ${snapshot}: ${(err as Error).message}`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
