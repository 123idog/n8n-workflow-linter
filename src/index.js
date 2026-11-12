'use strict';

const { rules } = require('./rules');

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function buildContext(workflow) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow must be an object');
  // Accept both a bare workflow and an API response wrapper ({ data: {...} }).
  const wf = Array.isArray(workflow.nodes) ? workflow : workflow.data && Array.isArray(workflow.data.nodes) ? workflow.data : null;
  if (!wf) throw new TypeError('not an n8n workflow: missing "nodes" array');

  const nodes = wf.nodes;
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const connections = wf.connections || {};
  const incoming = new Map();
  const outgoing = new Map();

  for (const [src, types] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(types || {})) {
      (outputs || []).forEach((targets, outputIndex) => {
        for (const c of targets || []) {
          if (!c || !c.node) continue;
          if (!outgoing.has(src)) outgoing.set(src, []);
          outgoing.get(src).push({ node: c.node, type, outputIndex });
          if (!incoming.has(c.node)) incoming.set(c.node, []);
          incoming.get(c.node).push({ node: src, type, outputIndex });
        }
      });
    }
  }
  return { workflow: wf, nodes, byName, connections, incoming, outgoing };
}

/**
 * Lint an n8n workflow object.
 * @param {object} workflow  parsed workflow JSON (export file or API response)
 * @param {{ignore?: string[]}} [options]
 * @returns {Array<{rule:string, severity:'error'|'warning'|'info', title:string, node?:string, message:string, why:string}>}
 */
function lint(workflow, options = {}) {
  const ctx = buildContext(workflow);
  const ignore = new Set((options.ignore || []).map((s) => s.toUpperCase()));
  const findings = [];
  for (const rule of rules) {
    if (ignore.has(rule.id)) continue;
    for (const f of rule.check(ctx)) {
      findings.push({ rule: rule.id, severity: rule.severity, title: rule.title, node: f.node, message: f.message, why: rule.why });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));
  return findings;
}

function summarize(findings) {
  const s = { error: 0, warning: 0, info: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

module.exports = { lint, summarize, rules };
