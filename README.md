# omp-sessions

Sweep + jump across all omp/pi sessions on this host.

## Commands

- `/sessions-sweep` — audit every session title against
  `MMDD｜<type>｜<topic>` (types: Feature Design Fix Optimize Release
  Explore Docs Research). Read-only: stream-reads each file, never
  writes. Emits the `| Old name | New name |` table plus hash · path ·
  project detail. Remembers scanned files in
  `~/.omp/agent/sessions-sweep.json` (marker is content-derived:
  `activityMs:messageCount:lastId`, so a later rename honestly
  re-marks the file); `--rescan` forces full.
- `/sessions-sweep --apply` — batch-apply pending renames **after user
  confirmation**. Skips live files; renames the current session through
  the live manager.
- `/sessions-rename <id-prefix> <MMDD｜<type>｜<topic>>` — rename one.
- `/sessions [query]` — cross-project list ordered by last real
  conversation activity (content timestamps, never filesystem mtime —
  mtime lies after any rename append). No limit: every session on the
  host is reachable (the picker caps nothing; the widget truncates to
  90 rows only in TUI, headless prints all). No ordinal numbers (ordinals
  hijack date search: typing `1011` matched `1. …`). Each row leads
  with `MMDD HH:MM｜`. TUI shows a type-to-filter picker that jumps
  via `switchSession`; headless prints paths for `omp -r <path>`.

## Title writes are title-only

One appended `session_info` entry per renamed file + a best-effort
upsert into `history.db/session_titles`. Project, content, order, pins
untouched.

## `sess`: standalone picker (use this, not `/sessions`)

The in-omp `/sessions` picker can't complete the jump — Enter in the
extension selector does nothing observable. Standalone instead:

```
sess [initial-query]   # fzf list (latest first) + right-side review pane
                       # Enter: cd to the session dir, omp --resume <path>
sess -c <pattern>      # search session CONTENT, then jump
```

`sess -c` matches the conversation text — user and assistant messages, not
tool output — and lists only sessions with a hit, each row showing the hit
count and the first matching snippet. Title matches still count, so `-c
docker` also finds a session named after it. Regex by default
(case-insensitive); an invalid regex is treated as a literal. The pattern
reaches the preview pane through `SESSPICK_GREP`, so snippets render there
instead of the last turns. Cost is one extra pass over the same scan `sess`
already does (~2 s for 434 sessions / 560 MB here).

Parts: `sesspick` (python scanner → fzf, symlinked to `~/.local/bin`)
and `sess` (zsh function from `sess.zsh`, sourced via `~/.zshrc` —
a child process can't `cd` its parent, so the picker prints
`<cwd>\t<path>` and the function does `cd` + `exec omp --resume`).

## Install

```
omp plugin link ./omp-sessions-plugin
ln -sf $PWD/omp-sessions-plugin/sesspick ~/.local/bin/sesspick
# sess.zsh is sourced from ~/.zshrc; open a new shell for sess
```
