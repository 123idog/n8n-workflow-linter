'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { lint, summarize, rules } = require('../src/index.js');

const bad = require('../examples/bad-workflow.json');
const good = require('../examples/good-workflow.json');

const ids = (findings) => [...new Set(findings.map((f) => f.rule))].sort();
const byRule = (findings, id) => findings.filter((f) => f.rule === id);

function wf(nodes, connections = {}, settings = { timezone: 'UTC', errorWorkflow: 'x' }) {
  return { nodes, connections, settings };
}
const trigger = { name: 'Start', type: 'n8n-nodes-base.webhook', parameters: {} };
const link = (a, b, type = 'main') => ({ [a]: { [type]: [[{ node: b, type, index: 0 }]] } });

test('the clean example has no findings', () => {
  assert.deepEqual(lint(good), []);
});

test('the broken example triggers every rule', () => {
  assert.deepEqual(ids(lint(bad)), rules.map((r) => r.id).sort());
});

test('findings are sorted errors first', () => {
  const sev = lint(bad).map((f) => f.severity);
  const order = { error: 0, warning: 1, info: 2 };
  assert.deepEqual(sev, [...sev].sort((a, b) => order[a] - order[b]));
});

test('N001: "=ready" is flagged, "={{ $json.x }}" and "ready" are not', () => {
  const f = byRule(lint(bad), 'N001');
  assert.equal(f.length, 1);
  assert.equal(f[0].node, 'Only Ready');
  assert.match(f[0].message, /=ready/);
});

test('N002: HTTP without retry is flagged; LLM sub-nodes are not', () => {
  const nodes = [
    trigger,
    { name: 'Call', type: 'n8n-nodes-base.httpRequest', parameters: {} },
    { name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', parameters: {}, credentials: { a: {} } },
  ];
  const f = byRule(lint(wf(nodes, link('Start', 'Call'))), 'N002');
  assert.deepEqual(f.map((x) => x.node), ['Call']);
});

test('N003: missing error workflow only matters when there is a real trigger', () => {
  assert.equal(byRule(lint(wf([trigger], {}, { timezone: 'UTC' })), 'N003').length, 1);
  const manual = { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
  assert.equal(byRule(lint(wf([manual], {}, {})), 'N003').length, 0);
});

test('N004: Data Table get needs returnAll or an explicit limit', () => {
  const dt = (p) => ({ name: 'DT', type: 'n8n-nodes-base.dataTable', parameters: p });
  const run = (p) => byRule(lint(wf([trigger, dt(p)], link('Start', 'DT'))), 'N004').length;
  assert.equal(run({ operation: 'get' }), 1);
  assert.equal(run({}), 1); // get is the default operation
  assert.equal(run({ operation: 'get', returnAll: true }), 0);
  assert.equal(run({ operation: 'get', limit: 500 }), 0);
  assert.equal(run({ operation: 'insert' }), 0);
});

test('N005: expression references to missing nodes, both syntaxes', () => {
  const n = {
    name: 'Set',
    type: 'n8n-nodes-base.set',
    parameters: { a: "={{ $('Ghost').item.json.x }}", b: '={{ $node["Phantom"].json.y }}', c: "={{ $('Start').item.json }}" },
  };
  const f = byRule(lint(wf([trigger, n], link('Start', 'Set'))), 'N005');
  assert.deepEqual(f.map((x) => x.message.match(/"(.+?)"/)[1]).sort(), ['Ghost', 'Phantom']);
});

test('N006: connection to a missing node', () => {
  const f = byRule(lint(bad), 'N006');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /Write Back/);
});

test('N007: unreachable node; AI sub-nodes and disabled nodes are fine', () => {
  const f = byRule(lint(bad), 'N007');
  assert.deepEqual(f.map((x) => x.node), ['Old Slack Ping']);
  assert.equal(byRule(lint(good), 'N007').length, 0); // Chat Model feeds the agent via ai_languageModel
});

test('N008: literal secrets in headers, keys and known token shapes', () => {
  const n = (parameters) => ({ name: 'Call', type: 'n8n-nodes-base.httpRequest', retryOnFail: true, parameters });
  const run = (p) => byRule(lint(wf([trigger, n(p)], link('Start', 'Call'))), 'N008').length;
  assert.equal(run({ headerParameters: { parameters: [{ name: 'x-api-key', value: 'abcdef1234567890' }] } }), 1);
  assert.equal(run({ headerParameters: { parameters: [{ name: 'x-api-key', value: '={{ $env.API_KEY }}' }] } }), 0);
  assert.equal(run({ apiKey: 'live_1234567890abcdef' }), 1);
  assert.equal(run({ url: 'https://x.example.com/?key=AIzaDEMO0000000000000000000000000000' }), 1);
  assert.equal(run({ text: 'sk-DEMO00000000000000000000000' }), 1);
  assert.equal(run({ url: 'https://example.com', tokenizer: 'cl100k' }), 0); // short literal, not a secret
});

test('N009: schedule without timezone', () => {
  assert.equal(byRule(lint(bad), 'N009').length, 1);
  assert.equal(byRule(lint(good), 'N009').length, 0);
});

test('N010: disabled nodes are info only', () => {
  const f = byRule(lint(bad), 'N010');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
});

test('ignore option skips rules', () => {
  const f = lint(bad, { ignore: ['n002', 'N010'] });
  assert.ok(!f.some((x) => x.rule === 'N002' || x.rule === 'N010'));
});

test('accepts an API response wrapper and rejects non-workflows', () => {
  assert.deepEqual(lint({ data: good }), []);
  assert.throws(() => lint({ foo: 1 }), /missing "nodes"/);
  assert.throws(() => lint(null), /must be an object/);
});

test('summarize counts by severity', () => {
  const s = summarize(lint(bad));
  assert.ok(s.error >= 4 && s.warning >= 3 && s.info === 1);
});

test('CLI exit codes: 1 on errors, 0 when clean', () => {
  const bin = path.join(__dirname, '..', 'bin', 'n8n-lint.js');
  const ex = (f) => path.join(__dirname, '..', 'examples', f);
  assert.match(execFileSync(process.execPath, [bin, ex('good-workflow.json')]).toString(), /no issues/);
  let code = 0;
  try {
    execFileSync(process.execPath, [bin, ex('bad-workflow.json')], { stdio: 'pipe' });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
  const json = JSON.parse(execFileSync(process.execPath, [bin, '--json', '--ignore', 'N001,N004,N005,N006,N008', ex('bad-workflow.json')]).toString());
  assert.equal(json[0].summary.error, 0);
});
