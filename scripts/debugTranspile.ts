import { readFile } from 'node:fs/promises';
import { debugTranspile } from '../src/transpiler/transpileTempC.ts';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: tsx scripts/debugTranspile.ts <temp.c>');
  const src = await readFile(path, 'utf8');
  const result = debugTranspile(src);
  console.log('=== FUNC ===');
  console.log(result.funcSource);
  console.log('\n=== DOUT ===');
  console.log(result.doutSource);
}
main().catch((e) => { console.error(e); process.exit(1); });
