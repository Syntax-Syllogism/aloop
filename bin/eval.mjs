#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainEntrypoint } from '../src/entrypoint.mjs';
import { formatEvalSummaryTable, formatEvalTable, runEval, summarizeEval } from '../src/eval.mjs';

export function usage() {
  return [
    'Usage: aloop-eval <spec.mjs> [options]',
    '',
    'Runs the task corpus and model/config matrix exported by <spec.mjs>',
    '(a default export, or named `corpus` and `matrix` exports) through the',
    'loop and reports completion, escaped defects, convergence, cost, and time.',
    '',
    'Options:',
    '      --json    Emit machine-readable JSON instead of tables',
  ].join('\n');
}

export async function runEvalCli(argv, { cwd = process.cwd(), output = console } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help || !positionals.length) {
    output.log(usage());
    return null;
  }
  const [specPath] = positionals;
  const spec = await import(pathToFileURL(resolve(cwd, specPath)).href);
  const { corpus, matrix } = spec.default ?? spec;
  if (!Array.isArray(corpus) || !Array.isArray(matrix)) {
    throw new Error(`${specPath} must export a task \`corpus\` array and a config \`matrix\` array.`);
  }
  const results = await runEval({ corpus, matrix });
  const summaries = summarizeEval(results);
  if (values.json) {
    output.log(JSON.stringify({ results, summaries }, null, 2));
  } else {
    output.log(formatEvalTable(results));
    output.log('');
    output.log(formatEvalSummaryTable(summaries));
  }
  return { results, summaries };
}

if (isMainEntrypoint(import.meta.url)) {
  try {
    await runEvalCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
