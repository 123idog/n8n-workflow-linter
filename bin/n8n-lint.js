#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { lint, summarize, rules } = require('../src/index.js');

const HELP = `Usage: n8n-lint <workflow.json ...> [options]

Options:
  --json            print findings as JSON
  --ignore N002,N010   skip rules
  --explain         include why each rule matters
  --rules           list all rules and exit
  -h, --help        show this help

Exit code: 1 if any error-level finding, otherwise 0.`;

function parseArgs(argv) {
  const args = { files: [], json: false, explain: false, ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--explain') args.explain = true;
    else if (a === '--rules') args.rules = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--ignore') args.ignore = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a.startsWith('--ignore=')) args.ignore = a.slice(9).split(',').filter(Boolean);
    else args.files.push(a);
  }
  return args;
}

const ICON = { error: '✖', warning: '⚠', info: 'ℹ' };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP), 0;
  if (args.rules) {
    for (const r of rules) console.log(`${r.id}  ${r.severity.padEnd(7)}  ${r.title}\n        ${r.why}\n`);
    return 0;
  }
  if (!args.files.length) {
    console.error(HELP);
    return 2;
  }

  let errors = 0;
  const all = [];
  for (const file of args.files) {
    let wf;
    try {
      wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`${file}: cannot read JSON (${e.message})`);
      errors++;
      continue;
    }
    let findings;
    try {
      findings = lint(wf, { ignore: args.ignore });
    } catch (e) {
      console.error(`${file}: ${e.message}`);
      errors++;
      continue;
    }
    const s = summarize(findings);
    errors += s.error;
    if (args.json) {
      all.push({ file, summary: s, findings });
      continue;
    }
    const name = wf.name || (wf.data && wf.data.name) || path.basename(file);
    console.log(`\n${file}  (${name})`);
    if (!findings.length) console.log('  ✔ no issues');
    for (const f of findings) {
      const where = f.node ? `[${f.node}] ` : '';
      console.log(`  ${ICON[f.severity]} ${f.rule} ${where}${f.message}`);
      if (args.explain) console.log(`      ↳ ${f.why}`);
    }
    console.log(`  ${s.error} error(s), ${s.warning} warning(s), ${s.info} info`);
  }
  if (args.json) console.log(JSON.stringify(all, null, 2));
  return errors > 0 ? 1 : 0;
}

process.exitCode = main();
