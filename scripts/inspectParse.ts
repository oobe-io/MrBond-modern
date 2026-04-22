import { readFile } from 'node:fs/promises';
import { tokenizeC } from '../src/transpiler/cTokenizer.ts';
import { parseC } from '../src/transpiler/cParser.ts';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: tsx scripts/inspectParse.ts <temp.c>');
  const src = await readFile(path, 'utf8');
  const tokens = tokenizeC(src);
  const program = parseC(tokens);
  const globals: string[] = [];
  const funcs: string[] = [];
  for (const decl of program.decls) {
    if (decl.kind === 'varDecl') globals.push(`${decl.cType} ${decl.name}${decl.isArray ? '[]' : ''}`);
    else if (decl.kind === 'funcDef') funcs.push(decl.name);
  }
  console.log('Globals (' + globals.length + '):', globals);
  console.log('Funcs (' + funcs.length + '):', funcs.slice(0, 15), funcs.length > 15 ? '...' : '');
}
main().catch((e) => { console.error(e); process.exit(1); });
