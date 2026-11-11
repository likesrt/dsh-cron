# dsh-cron

[中文](README.md)

Scheduled tasks for DSH: run a command on time, or hand a prompt to the model for one turn, and push the result wherever you want it. One sidebar entry, the page embedded in the main area, task data kept per workspace. Once installed it takes over the built-in Automation tasks.

## Install

**Depends on [dsh-im](https://github.com/xmanrui/dsh-im).** IM delivery comes from it: WeChat, WeCom, Feishu, DingTalk, QQ, Telegram, WhatsApp, Slack, Discord and Matrix channels and targets are all dsh-im's. Without it, delivery keeps only silent, back where it started, and session log.

Install dsh-im first:

```bash
dsh plugin --profile web add @xmanrui/dsh-im        # use your profile name; this Web UI is web
```

Then configure a bot and save at least one delivery target under Settings → IM bots — this plugin's IM destination can only pick saved targets, never raw ids.

Then install this plugin:

```bash
dsh plugin --profile web add github:likesrt/dsh-cron        # repo https://github.com/likesrt/dsh-cron
```

`--profile` is required; pass your profile name (this Web UI is `web`).

Without a terminal: Plugins → Install plugin → paste `github:likesrt/dsh-cron` → Install.

The command only adds the package to the profile — then switch `dsh-cron` on in the plugin manager; installing from the plugin page does both steps. Refresh the browser and the sidebar shows Scheduled Tasks. Plain JavaScript, no build step.

- Update: `dsh plugin --profile web update dsh-cron`. Re-running the same `add` does not re-resolve a git spec — pnpm considers the lockfile current — while `update` refetches HEAD; restart the host or reload the plugin afterwards.
- Remove: `dsh plugin --profile web remove dsh-cron`.
- Needs access to github.com; behind a proxy, configure one for git first.
- Installation turns off the built-in Automation tasks. To run both, switch that option off in the plugin config.

## How it differs from the built-in Automation tasks

| | Built-in Automation tasks | dsh-cron |
|---|---|---|
| Nature | Sends one sentence into a session and lets the model run a turn | A job: runs a script, or hands a prompt to the model |
| Runs commands | — | Yes, executed directly without the model |
| Where results go | Into the session only | Silent / back where it started / an IM target / a session log |
| Whether to push | Delivered every round | Decided per round: empty script stdout stays silent, a `[silent]` reply stays silent |
| Where it runs | An existing session, created once then reused, or a new one every run | Same |
| Schedules | at / after / every / daily / weekly / cron / rrule | Once / monthly / weekly / daily / hourly / every N days·hours·minutes·seconds / cron (5 or 6 fields) |
| Agent, model, permission per task | Agent preset fixed when the session is created | Set per task, switched onto that session before the run |
| Retries / timeout | — | 0..5 backoff retries; a timeout kills the whole process group |
| Run limit | — | Yes, stops after N runs |
| Run history | Delivery records (30 days / 200 records by default) | Output and error of every run, jump back to that session; retention configurable |
| Deleting a task | Deletes the task | Takes the task and the sessions it created (sessions are archived) |
| Repeated failures | — | Incident records with acknowledgement |
| Run now | Yes | Yes |
| Data | Host-wide `$DSH_HOME/storages/schedule.json` | Per workspace `<workspace>/dsh-cron/` |
| Model tools | 4: list / view / create / edit | 12: plus run / runs / targets / notepad / incidents / health |
| Page | Built-in task page | Sidebar page with a right-side drawer editor and an incidents page |

## Two modes

| Mode | What it does | Whether it pushes |
|---|---|---|
| Agent (default) | Hands the prompt to the model for one turn | With a channel configured, a reply that is only `[silent]` skips this round |
| Script | Runs one command, no model involved | Pushes when stdout has content, stays silent when empty |

Agent is the default: a task still goes to the model when you only type a command line. Pick script mode explicitly — and when a script would clearly be the cheaper way, say so and let the user decide rather than switching modes on your own.

Both modes keep run records; `deliveryReason` says why a round pushed or stayed quiet.

## Scheduling

Everything is picked in the UI, no expressions to type: once / monthly / weekly / daily / hourly / every N days / every N hours / every N minutes / every N seconds / custom cron. Units belong to the controls, and the next run time is shown right below them.

- Monthly, weekly, daily, hourly and custom cron follow the calendar in the configured `timeZone`, with DST gaps and overlaps handled.
- `Every N …` means fixed spacing in absolute time (no `*/45` alternation between 45 and 15).
- The shortest interval is 5 seconds.
- Only one timer is armed: a single `setTimeout` to the earliest due task, recomputed after it fires. No enabled tasks, no timer, nothing spinning; a five-minute safety sweep absorbs system clock jumps.
- Once: pick a date and a time, the task stops itself after running; a time in the past is not caught up.

## Delivery

One destination per task, shared by success and failure:

| Destination | Where the result goes |
|---|---|
| Silent | History only, no message |
| Back where it started | Returns to wherever the task was created: a chat stays a chat, a Web session gets its log appended |
| IM | A saved target in dsh-im |
| Session log | Appended to a given session's log without waking the model |

**Leave delivery unset and it returns where it started.** A task created from WeCom or QQ does not need `botId` or `targetId`: it remembers the chat and sends there, even after `/new` switches sessions. One created from a Web session writes to that session's log.

Writing to a session log needs that session open; once it is closed the run records “那个会话没开着，写不进去” instead of pretending it succeeded. To keep a full trace, point the run location at that session instead.

### Naming a target from chat

`botId` is the bot, `targetId` is the alias saved under Settings → IM bots → Targets. From chat, the model can name just the target, or nothing at all:

```json
{ "kind": "im", "target": "yuyan" }              // target name or targetId
{ "kind": "im", "target": "单聊", "bot": "qq" }    // separate same-named targets by channel
{ "kind": "im" }                                  // with one saved target, nothing is needed
{ "kind": "origin" }                              // back where the task started
```

Resolution happens before every delivery, so changing target routing later needs no task edit; when nothing matches or several do, `deliveryReason` lists the candidates. Before creating a task the model calls `cron_targets` to see what exists instead of guessing.

## Run location and permissions

| Run location | Behaviour |
|---|---|
| New session, reused | Created on the first run, reused afterwards; the model context is cleared before every run (default) |
| New session every run | One session per run |
| Existing session | Run inside a chosen session of that workspace |

"Clear context" clears what the **model** sees: the session id, the transcript and the full log stay, but the next request carries none of the previous run. Turn the switch off in the editor (or pass `target.freshContext: false` to the tool) to let the model continue where it left off.

Script tasks have no session and no such setting.

Sessions a task created belong to the task: deleting it archives them, so they leave every list and can still be restored from the archive. A task pointed at an existing session never touches yours.

Permissions differ by mode: script tasks run with the permissions of the user running dsh (no sandbox, no approval); agent tasks use the session's permission preset (`read-only` / `workspace-write` / `danger-full-access` / `auto`, where `auto` suits a task nobody is watching at night).

Agent and model only appear in agent mode; the session is switched to them before the run, and leaving them unset follows the host default.

## Retries and timeouts

Each task can set its own retries (0..5, backing off 5s × the attempt number) and per-run timeout in seconds. Only the final outcome is delivered; the intermediate attempts are not sent. A timeout is not retried.

## Commands

`/clear` drops the current session's model context with the same logic the per-run clearing uses: session, transcript and log stay, only the model's view is emptied. It is the platform's positional surface replacement (the one `/compact` uses), so it survives a reload.

```
/clear
```

It refuses while the session is running; try again once it is idle.

## Panel

Click Scheduled Tasks in the sidebar; it opens inside the main area.

- Top: title, new task (the dropdown starts straight in script or agent mode), incidents.
- Tabs: enabled / paused / ended / all, with counts; a search box below.
- Each row: next run, task and schedule, workspace, last result, then run now, session, pause, edit, history, delete.
- Editing uses a right-side drawer split into content / execution / schedule / failure handling / result.
- Deleting asks for confirmation, showing the task's schedule and workspace; a task with its own session says the session is archived with it.
- Results appear as a floating notice.

## Tools

| Tool | Purpose |
|---|---|
| `cron_create` | Create a task: title, schedule, mode, script or prompt, workspace, agent, model, permission, run location, delivery, run limit, retries, timeout |
| `cron_list` | List all tasks including stopped ones, ordered by next run |
| `cron_view` | Full configuration and state of one task |
| `cron_edit` | Edit a task (same fields, plus enable / pause) |
| `cron_run` | Run once now without touching the schedule |
| `cron_remove` | Delete a task |
| `cron_runs` | Run history: status, duration, output, error |
| `cron_targets` | List the saved dsh-im delivery targets |
| `cron_notepad` | A task's cross-run notebook (key/value) |
| `cron_incidents` / `cron_ack` | Long-running failures: list and acknowledge |
| `cron_health` | Checks: missing script or prompt, broken schedule, half-specified delivery ids |

## Data

Every task belongs to a workspace and its data lives there:

```
<workspace>/dsh-cron/
  tasks.json        tasks
  runs.jsonl        run history (pruned past the retention window)
  incidents.json    failure records
  .tick.lock        cross-process tick lock
```

The workspace registry lives in `$DSH_HOME/dsh-cron/workspaces.json`; on start the service merges the tasks of every registered workspace.

## Configuration

Open `dsh-cron` on the Plugins page; the form below the body holds only what you decide: time zone, per-run timeout (seconds), concurrency limit, history retention (days / records), and whether to disable the built-in Automation tasks. All hot-reloadable; the next run records under the new retention rules.

```yaml
- id: dsh-cron
  config:
    timeZone: Asia/Shanghai
    timeLimitMs: 180000    # hard cap per run, kills the process group too
    maxConcurrent: 3
    historyDays: 30        # days a run record is kept
    historyRecords: 200    # records kept per task
    disableBuiltinSchedule: true
    devReload: true        # re-import the implementation when the plugin is remounted
```

“Disable the built-in Automation tasks” is not just a stored flag: saving calls `/dsh-cron/api/builtin`, and `pluginManager` writes the official rows into the profile patch and reloads, so the state survives a restart.

## Relation to the built-in Automation tasks

The bundled `cordis.patch.yml` turns off the built-in `schedule`, `tool-schedule` and `ui-schedule` rows so two schedulers never run at once. To keep the built-in one, switch the option off in the config instead of editing files. `tool-schedule` sits in another group and `pluginManager` does not list it, so the switch controls the official page and its scheduling service.

## Development

```
lib/
  index.js        plugin entry (apply + Config shell)
  app.js          assembly: service, tools, routes
  core/           pure logic: task model, schedule expressions, incidents
  runtime/        the work: scheduler loop, script execution, model dispatch, delivery
  data/           on disk: tasks per workspace, cross-process lock
  api/            outward: panel routes, model tools, built-in switch
client.js         the panel (single file, loaded directly by the module loader)
test/             node:test, no browser
```

- Editing `client.js`: refresh the page.
- Editing `lib/`: toggle `dsh-cron` off and on in the plugin manager; `devReload` re-imports the implementation. Only editing the `lib/index.js` shell needs a host restart.

```bash
node --test test/*.test.js        # everything
node test/smoke-server.mjs 13999  # a real service to poke over HTTP, temp workspace, no real data
```
