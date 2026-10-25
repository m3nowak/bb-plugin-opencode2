# OpenCode v2 API notes

What the bridge relies on in OpenCode v2, verified against OpenCode 2.0.27 with
live probes and recorded turns. Official docs: <https://opencode.ai/v2/docs/api>.
`tests/opencode-v2-contract.test.ts` pins the request and event shapes below.

Talking to a live service: `opencode2 service status` prints the URL, basic
auth is `opencode:<password>` from `~/.config/opencode/service.json`, and every
location-scoped route needs `?location[directory]=<cwd>`.

## Routes the plugin uses

- `POST /api/session` takes `{id?, parentID?, title?, agent?, model?, location?, metadata?, permissions?}`.
- `PATCH /api/session/:id` takes `{title?, metadata?, permissions?}`.
  `permissions` replaces the session ruleset.
- `DELETE /api/session/:id`.
- `GET /api/session/:id` returns `Session.Info`, including `outcome`
  (succeeded/failed/interrupted), `time.idle`, `tokens`, `cost`, and `model`.
- `GET /api/session/active` returns `{data: {<sessionID>: ...}}`.
  Use it for reconciliation.
- `POST /api/session/:id/prompt` takes `{id?, text, files?[{uri,name?}],
skills?[{id, mention}], metadata?, delivery?: "steer"|..., resume?}`.
  Unknown keys are stripped, and a valid prompt starts a model call.
- `POST /api/session/:id/fork` takes `{before?: messageID}`.
- `POST /api/session/:id/compact` takes `{id?, delivery?}`.
- `POST /api/session/:id/interrupt` (query `resume?`) returns `{interrupted}`.
- `POST /api/session/:id/revert/stage` takes `{messageID, files?}`.
  `POST .../revert/commit`. `DELETE .../revert` clears it.
- `POST /api/session/:id/agent` takes `{agent}`. `POST /api/session/:id/model` takes `{model:{providerID,id,variant?}}`.
- `PUT /api/session/:id/environment` takes `{variables: Record<string,string>}`.
- `PUT|DELETE /api/experimental/session/:id/instructions/entries/:key`, with `{value}` for PUT.
- `GET /api/session/:id/message?limit&order=asc|cursor=` returns `{data, cursor:{previous,next}}`.
  `next` is always present, so stop on an empty page. Message `type` is
  `user`, `assistant`, `idle` (with `outcome`), `compaction`, and others.
- `GET /api/session/:id/form`. `POST .../form/:formId/reply` takes `{answer: {<fieldKey>: string|number|boolean|string[]}}`.
  `DELETE .../form/:formId`.
- `POST /api/session/:id/permission/:requestID/reply` takes `{decision, message?}`.
- `GET /api/session/:id/diff?from=<userMsgId>&to=&context=` returns per-file
  `{file, patch, additions, deletions, status}`. It returned `[]` in tests,
  so verify when it populates.
- `PUT|DELETE /api/experimental/mcp/:server?location[directory]=`, with `{config}` for PUT.
- `GET /api/model?location[directory]=` returns
  `{providerID, id, name, variants[{id}], limit:{context,output},
capabilities:{input[]}, enabled, cost[], status}`.
  `GET /api/model/default` returns the same shape.
  Variant ids seen: none, minimal, low, medium, high, xhigh, max, thinking.
- `GET /api/agent?location[directory]=` lists agents: build (default), plan,
  general, explore, sophos, plus hidden compaction/title/summary agents.
- `GET /api/skill?location[directory]=` returns `[{id, name, description, ...}]`.
- `GET /api/integration` returns `connections[]`, where a status can be
  `needs_auth`.
- `GET /api/shell/:id/output?location[directory]=&cursor=<byte>&limit=` returns `{output, cursor, size, truncated}`.
- `GET /api/event` is SSE (`data: {type, data}`). It is volatile and does not
  replay. `GET /api/experimental/session/:id/log` has sequence IDs and may
  allow replay.

## Optional Go subscription usage

The current published V2 OpenAPI adds `GET /api/experimental/usage/limits`.
This is optional; it is not part of the 2.0.27 baseline verified above.
The result is `{ location, data }`, with `data: null` when no Console workspace
is connected. Otherwise `data.workspace.id` identifies the quota account and
`data.go`, when present, has `rolling`, `weekly`, and `monthly` meters. Each
meter has `percent`, `limited`, and `resetsAt` in epoch milliseconds.
The plugin maps the percentage directly and converts reset times to ISO.
The response also includes Console budgets, which are not prepaid balance and
are deliberately not reported as Go allowance. The endpoint has no prepaid
balance field and does not identify whether the plan is Go or Go Plus.

Only an explicit `reportGoUsage: true` enables collection. Older servers and
collection failures become usage statuses; they never fail a conversation.

## Permission rules

Rules are `[{action, resource, effect: allow|deny|ask}]`. The agent ruleset
is evaluated first and then the session ruleset. The last match wins
(verified: a session rule of `*`→ask made `shell` ask under `build`).

Known actions: `*`, shell, read, edit (covers write/patch), grep, glob,
webfetch, websearch, question, subagent, external_directory, browser. Bare
reject behavior was verified: OpenCode then aborts the step and interrupts
execution with reason `shutdown`. Reject with `message` is untested; it should
feed back to the model.

`permission.asked` data looks like:
`{id:"per_…", sessionID, action:"shell", resources:["echo hello"], save:["echo *"], source:{type:"tool", messageID, id:<toolCallId>}}`.

## Events (recorded shapes)

- `session.inbox.enqueued` / `session.inbox.delivered {inboxID}`. The inboxID
  equals the prompt message ID. Use it to confirm steers.
- `session.execution.started|succeeded|failed{error}|interrupted{reason: user|shutdown|superseded|inactivity}`.
- `session.step.started {agent, model, assistantMessageID}`.
- `session.step.ended {finish, cost, tokens:{input,output,reasoning,cache:{read,write}}}`.
- `session.step.failed {error, tokens?}`.
- `session.usage.updated {cost, tokens}` carries cumulative session totals.
  Use it for `usage.total`.
- `session.retry.scheduled {assistantMessageID, attempt, at, error}`.
- `session.text|reasoning.started|delta|ended {assistantMessageID, ordinal, delta|text}`.
- `session.tool.input.started {id, name}`, `.input.ended {text}`,
  `session.tool.called {id, input}`, `session.tool.progress {id, metadata}`,
  `session.tool.success {id, content[], metadata}`, and
  `session.tool.failed {id, error:{type,message}}`.
- Tool names and inputs in v2:
  - `shell {command, timeout?}`
  - `read {path}`
  - `edit {path, oldString, newString}`
  - `write {path, content}`
  - `question {questions[{question, header, options[{label, description}]}]}`
  - `subagent {agent, description, prompt}`
  - There is no todo tool in v2.
- Shell flow: `session.tool.progress {metadata:{shellID}}`, then
  `shell.created {info:{id, command, cwd, file}}`, then `shell.exited {id, exit}`.
  Success metadata is `{status, exit}`, and the content has the output plus
  `"Exited with code N"`.
- Edit success metadata looks like:
  `{files:[{file, patch:<unified diff>, status:"modified"|"added"|"deleted", additions, deletions}]}`.
  Write metadata has no diff.
- Subagent flow: `session.tool.progress {metadata:{sessionID:<child>, status:"running"}}`.
  The result content looks like
  `<subagent sessionID=… state="completed">…</subagent>`. Child-session
  events carry the child's `sessionID`.
- `form.created {form:{id, sessionID, title, metadata:{kind:"question", tool:{messageID,id}}, fields:[{key:"q0", title, description, type:"string", options[{value,label,description}], custom:true}]}}`.
- `session.compaction.started{reason:auto|manual}`, `.delta`, and `.ended`
  (handled already).
