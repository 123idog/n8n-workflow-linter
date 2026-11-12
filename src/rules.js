'use strict';

/**
 * Each rule: { id, severity, title, why, check(ctx) -> Array<{node?, message}> }
 * ctx = { workflow, nodes, byName, connections, incoming, outgoing }
 */

const SECRET_KEY = /(api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|private[_-]?key)/i;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI-style / generic "sk-" keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, // literal bearer tokens
];

const EXPR_REF = [/\$\(\s*(['"`])((?:(?!\1).)+)\1\s*\)/g, /\$node\[\s*(['"`])((?:(?!\1).)+)\1\s*\]/g];

function isExpression(v) {
  return typeof v === 'string' && v.startsWith('=');
}

function isTrigger(node) {
  const t = String(node.type || '');
  return /trigger$/i.test(t) || /\.webhook$/i.test(t) || /\.formTrigger$/i.test(t) || /\.start$/.test(t);
}

function isSticky(node) {
  return /stickyNote$/i.test(String(node.type || ''));
}

/** Walk every primitive in an object, calling fn(value, key, path). */
function walk(obj, fn, path = []) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, fn, path.concat(i)));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) walk(v, fn, path.concat(k));
  } else {
    fn(obj, path[path.length - 1], path);
  }
}

const rules = [
  {
    id: 'N001',
    severity: 'error',
    title: 'Literal value starts with "="',
    why:
      'n8n treats any parameter starting with "=" as an expression. A literal like "=done" (typically from ' +
      'toggling expression mode, or from generated JSON) switches the field into expression mode by accident, ' +
      'and has silently broken filter conditions in production. Remove the "=" or write a real {{ }} expression.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        walk(node.parameters, (v, key, path) => {
          if (!isExpression(v)) return;
          if (v.includes('{{')) return; // a real expression
          if (v.length < 2) return;
          const field = path.join('.');
          out.push({ node: node.name, message: `${field} = "${v}" looks like a literal with a stray "=" (no {{ }} inside).` });
        });
      }
      return out;
    },
  },
  {
    id: 'N002',
    severity: 'warning',
    title: 'External call without retry',
    why:
      'HTTP requests and credentialed API nodes fail transiently (timeouts, 429, 5xx). Without "Retry On Fail", ' +
      'one blip drops the item for good, and nobody notices.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        if (isTrigger(node) || isSticky(node) || node.disabled) continue;
        const t = String(node.type || '');
        if (t.startsWith('@n8n/n8n-nodes-langchain.')) continue; // sub-nodes; retries belong on the agent/chain
        const external = /\.httpRequest$/i.test(t) || (node.credentials && Object.keys(node.credentials).length > 0);
        if (external && !node.retryOnFail) {
          out.push({ node: node.name, message: 'calls an external service but "Retry On Fail" is off.' });
        }
      }
      return out;
    },
  },
  {
    id: 'N003',
    severity: 'warning',
    title: 'No error workflow',
    why:
      'Without an error workflow, a failed production execution is only visible if someone opens the executions list. ' +
      'Set one so failures alert a human.',
    check(ctx) {
      const hasTrigger = ctx.nodes.some((n) => isTrigger(n) && !/manualTrigger$|errorTrigger$|executeWorkflowTrigger$/i.test(n.type));
      const s = ctx.workflow.settings || {};
      if (hasTrigger && !s.errorWorkflow) {
        return [{ message: 'settings.errorWorkflow is not set; production failures will be silent.' }];
      }
      return [];
    },
  },
  {
    id: 'N004',
    severity: 'error',
    title: 'Data Table read capped silently',
    why:
      'A Data Table "get" without "Return All" returns a default page (50 rows) and no warning. ' +
      'Dedup checks, lookups and reports built on it are silently wrong once the table grows.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        if (!/\.dataTable$/i.test(String(node.type || ''))) continue;
        const p = node.parameters || {};
        const op = p.operation || 'get';
        if (op === 'get' && p.returnAll !== true && p.limit === undefined) {
          out.push({ node: node.name, message: 'Data Table "get" without returnAll or an explicit limit: capped at the default page size.' });
        }
      }
      return out;
    },
  },
  {
    id: 'N005',
    severity: 'error',
    title: 'Expression references a node that does not exist',
    why:
      'After a rename or a copy between workflows, $(\'Old Name\') points to nothing. The expression fails at runtime, ' +
      'often only on the branch you did not test.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        const seen = new Set();
        walk(node.parameters, (v) => {
          if (typeof v !== 'string') return;
          for (const re of EXPR_REF) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(v))) {
              const ref = m[2];
              if (!ctx.byName.has(ref) && !seen.has(ref)) {
                seen.add(ref);
                out.push({ node: node.name, message: `references node "${ref}", which is not in this workflow.` });
              }
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: 'N006',
    severity: 'error',
    title: 'Connection to a missing node',
    why: 'The connections map points to a node name that no longer exists. Data sent there is lost.',
    check(ctx) {
      const out = [];
      for (const [src, types] of Object.entries(ctx.connections)) {
        if (!ctx.byName.has(src)) out.push({ message: `connections has a source "${src}" that is not a node.` });
        for (const outputs of Object.values(types || {})) {
          for (const targets of outputs || []) {
            for (const c of targets || []) {
              if (c && !ctx.byName.has(c.node)) out.push({ node: src, message: `connects to "${c.node}", which is not a node.` });
            }
          }
        }
      }
      return out;
    },
  },
  {
    id: 'N007',
    severity: 'warning',
    title: 'Node never runs',
    why:
      'A non-trigger node with no incoming connection (and that does not feed an AI agent as a sub-node) can never execute. ' +
      'It is usually a leftover from an edit, and some deploy tools refuse workflows that contain one.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        if (isTrigger(node) || isSticky(node) || node.disabled) continue;
        const hasIncomingMain = (ctx.incoming.get(node.name) || []).some((c) => c.type === 'main');
        const feedsSubNode = (ctx.outgoing.get(node.name) || []).some((c) => c.type !== 'main');
        if (!hasIncomingMain && !feedsSubNode) {
          out.push({ node: node.name, message: 'has no incoming connection and is not a trigger.' });
        }
      }
      return out;
    },
  },
  {
    id: 'N008',
    severity: 'error',
    title: 'Hard-coded secret',
    why:
      'API keys and tokens typed into parameters end up in exports, backups, Git and screenshots. ' +
      'Use credentials (or environment variables) instead.',
    check(ctx) {
      const out = [];
      for (const node of ctx.nodes) {
        const flagged = new Set();
        // 1) known token shapes anywhere
        walk(node.parameters, (v, key, path) => {
          if (typeof v !== 'string') return;
          if (SECRET_VALUE.some((re) => re.test(v))) flagged.add(path.join('.'));
        });
        // 2) name/value pairs (headers, query params, body params) whose name looks secret
        walk(node.parameters, (v, key, path) => {
          if (key !== 'name' || typeof v !== 'string' || !SECRET_KEY.test(v)) return;
          let parent = node.parameters;
          for (const p of path.slice(0, -1)) parent = parent[p];
          const val = parent && parent.value;
          if (typeof val === 'string' && !isExpression(val) && val.length >= 12) {
            flagged.add(path.slice(0, -1).concat('value').join('.'));
          }
        });
        // 3) parameter keys that look secret with a literal value
        walk(node.parameters, (v, key, path) => {
          if (typeof key !== 'string' || !SECRET_KEY.test(key)) return;
          if (typeof v === 'string' && !isExpression(v) && v.length >= 12) flagged.add(path.join('.'));
        });
        for (const f of flagged) out.push({ node: node.name, message: `${f} contains what looks like a literal secret.` });
      }
      return out;
    },
  },
  {
    id: 'N009',
    severity: 'warning',
    title: 'Schedule without an explicit timezone',
    why:
      'Schedule triggers use the instance default timezone unless the workflow sets one. ' +
      'Move the server or change the default, and "every day at 09:00" quietly moves too.',
    check(ctx) {
      const schedules = ctx.nodes.filter((n) => /\.(scheduleTrigger|cron)$/i.test(String(n.type || '')) && !n.disabled);
      const s = ctx.workflow.settings || {};
      if (schedules.length && !s.timezone) {
        return schedules.map((n) => ({ node: n.name, message: 'workflow settings.timezone is not set.' }));
      }
      return [];
    },
  },
  {
    id: 'N010',
    severity: 'info',
    title: 'Disabled node left in the workflow',
    why: 'Disabled nodes are fine while debugging, but in production they hide intent: is this off on purpose, or forgotten?',
    check(ctx) {
      return ctx.nodes
        .filter((n) => n.disabled && !isSticky(n))
        .map((n) => ({ node: n.name, message: 'is disabled.' }));
    },
  },
];

module.exports = { rules, isTrigger };
