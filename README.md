# n8n-workflow-linter

[![CI](https://github.com/123idog/n8n-workflow-linter/actions/workflows/ci.yml/badge.svg)](https://github.com/123idog/n8n-workflow-linter/actions/workflows/ci.yml)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

**A linter for n8n workflows. It catches the bugs that don't throw errors.**

n8n workflows fail quietly: a filter that never matches, a lookup capped at 50 rows, a request that drops an item on the first timeout, an expression pointing to a node that was renamed. The executions are green and the data is wrong.

`n8n-lint` reads an exported workflow JSON and reports these problems **before** you deploy. It runs offline, needs no n8n instance, and has no dependencies.

```text
$ n8n-lint examples/bad-workflow.json

examples/bad-workflow.json  (Demo | Form >> CRM | broken on purpose)
  ✖ N001 [Only Ready] conditions.conditions.0.rightValue = "=ready" looks like a literal with a stray "=" (no {{ }} inside).
  ✖ N004 [Get Pending Rows] Data Table "get" without returnAll or an explicit limit: capped at the default page size.
  ✖ N005 [Create Lead] references node "Get Rows", which is not in this workflow.
  ✖ N006 [Create Lead] connects to "Write Back", which is not a node.
  ✖ N008 [Create Lead] headerParameters.parameters.0.value contains what looks like a literal secret.
  ⚠ N002 [Create Lead] calls an external service but "Retry On Fail" is off.
  ⚠ N002 [Old Slack Ping] calls an external service but "Retry On Fail" is off.
  ⚠ N003 settings.errorWorkflow is not set; production failures will be silent.
  ⚠ N007 [Old Slack Ping] has no incoming connection and is not a trigger.
  ⚠ N009 [Every Morning] workflow settings.timezone is not set.
  ℹ N010 [Debug Step] is disabled.
  5 error(s), 5 warning(s), 1 info
```

---

## Rules

| ID | Severity | Catches |
|---|---|---|
| N001 | error | A literal value starting with `=`, which n8n parses as an expression (e.g. `"=ready"` in a filter) |
| N002 | warning | HTTP Request or credentialed API node without **Retry On Fail** |
| N003 | warning | No error workflow, so production failures are silent |
| N004 | error | Data Table `get` without **Return All** or a limit, silently capped at the default page |
| N005 | error | `$('Node')` / `$node["Node"]` pointing to a node that doesn't exist (after a rename or copy) |
| N006 | error | Connection to a node that doesn't exist |
| N007 | warning | A node that can never run (no incoming connection, not a trigger, not an AI sub-node) |
| N008 | error | Hard-coded API keys, tokens or bearer headers in parameters |
| N009 | warning | Schedule trigger without an explicit workflow timezone |
| N010 | info | Disabled nodes left in the workflow |

`n8n-lint --rules` prints each rule with the reason it exists. Every rule comes from a failure I saw in production.

---

## Install and run

```bash
npm install -g github:123idog/n8n-workflow-linter

n8n-lint my-workflow.json                # human-readable
n8n-lint workflows/*.json --explain      # include why each rule matters
n8n-lint my-workflow.json --json         # machine-readable
n8n-lint my-workflow.json --ignore N002,N010
```

The exit code is `1` if there's any error-level finding, so the linter can gate a CI pipeline or a deploy script:

```bash
n8n-lint workflow.json && ./deploy.sh workflow.json
```

It accepts both a workflow export and an n8n API response (`{ "data": { ... } }`).

### As a library

```js
const { lint, summarize } = require('n8n-workflow-linter');

const findings = lint(workflowJson, { ignore: ['N010'] });
// [{ rule: 'N004', severity: 'error', node: 'Get Pending Rows', message: '...', why: '...' }]
```

---

## Use it in CI

Keep exported workflows in Git and lint them on every push:

```yaml
- run: npx github:123idog/n8n-workflow-linter workflows/*.json
```

---

## Tests

```bash
npm test
```

There are 17 tests covering every rule, including its false-positive cases (AI sub-nodes aren't "unreachable", `={{ $env.KEY }}` isn't a secret). The example workflows are invented.

---

## Roadmap

- Rule: AI Agent / LLM chain without a fallback model
- Rule: Code node that returns a different item count than it received without saying so
- Rule: webhook that responds before validating input
- Config file (`.n8nlintrc`) for per-project rule settings

---

## Author

**Ido Guy**, AI & Automation Engineer, running 100+ production n8n workflows. [LinkedIn](https://www.linkedin.com/in/ido-guy)

MIT License. Not affiliated with n8n GmbH.
