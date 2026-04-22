import { readFile } from 'node:fs/promises';
import { tokenizeC } from '../src/transpiler/cTokenizer.ts';
import { parseC, type FuncDef, type Stmt } from '../src/transpiler/cParser.ts';
// Import private transpile helper via a copy of the logic

// Reimplementation of the runtime generator to see exactly what JS is produced.
const RESERVED_NAMES = new Set([
  'FUNC', 'DOUT', 'FU', 'main', 'PARM', 'INIT', 'OFILE', 'CFILE', 'RUNGE', 'SOLV', 'PLO',
  'DSIGN', 'FEHL', 'ICHEK', 'INDEX',
]);

async function main() {
  const path = process.argv[2];
  const src = await readFile(path, 'utf8');
  const tokens = tokenizeC(src);
  const program = parseC(tokens);

  const funcs = new Map<string, FuncDef>();
  const globalVars: string[] = [];
  const INFRA_GLOBALS = new Set(['X', 'DX', 'OP', 'PA', 'T', 'H']);
  for (const decl of program.decls) {
    if (decl.kind === 'funcDef') funcs.set(decl.name, decl);
    else if (decl.kind === 'varDecl' && !decl.isArray) {
      if (!INFRA_GLOBALS.has(decl.name)) globalVars.push(decl.name);
    }
  }

  console.log('Parsed funcs:', Array.from(funcs.keys()));
  console.log('Parsed globals:', globalVars);

  // Use the real builder
  const { buildFuncAndDout } = await import('../src/transpiler/transpileTempC.ts');
  const pa = new Map([[1, 0.01745], [2, 3.14159], [3, 0.05273], [4, 32480], [5, 247.3], [6, 0.0309], [7, 5e-6], [8, 8.402e-4]]);
  const { func, dout } = buildFuncAndDout(src, pa);

  // Call func once to make sure it works, and observe the state
  const x = [0, 0, 0];
  const dx = [0, 0, 0];
  const xCopy = [...x];
  console.log('Before func: X =', x);
  func(0, xCopy, dx);  // no x_global passed
  console.log('After func (no xGlobal), probe xCopy =', xCopy);
  console.log('After func (no xGlobal), dx =', dx);
  console.log('After func (no xGlobal), original x =', x);

  console.log('\n--- now with xGlobal ---');
  const x2 = [0, 0, 0];
  const probe2 = [...x2];
  const dx2 = [0, 0, 0];
  func(0, probe2, dx2, x2);
  console.log('After func (with xGlobal), probe =', probe2);
  console.log('After func (with xGlobal), dx =', dx2);
  console.log('After func (with xGlobal), xGlobal =', x2);
}

main().catch((e) => { console.error(e); process.exit(1); });
