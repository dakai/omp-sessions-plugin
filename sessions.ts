/**
 * omp-sessions: sweep + jump across all omp/pi sessions on this host.
 *
 * Two jobs:
 *  1. `/sessions-sweep` — audit every session title against the
 *     `MMDD｜<type>｜<topic>` rule, draft proposals, remember what was
 *     already scanned, and batch-apply renames only after confirmation.
 *  2. `/sessions` — one cross-project picker to jump to any session
 *     without restarting omp from another directory.
 *
 * Mechanics only; the naming judgment stays with the agent:
 * sweep drafts proposals -> agent refines topics from conversation
 * content -> agent shows the | Old | New | table and waits for the user
 * -> `/sessions-sweep --apply` (or `/sessions-rename`) writes titles.
 *
 * Title writes never touch anything else: one appended `session_info`
 * entry per renamed file (the tree model treats it as a new leaf, so a
 * live session just forks harmlessly) + a best-effort upsert into
 * history.db `session_titles`. Project, content, order, pins untouched.
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const TYPES = ["Feature", "Design", "Fix", "Optimize", "Release", "Explore", "Docs", "Research"] as const;
// Fullwidth ｜ U+FF5C, verbatim from the naming rule.
const RULE = /^(\d{4})｜(Feature|Design|Fix|Optimize|Release|Explore|Docs|Research)｜(.+)$/;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}
function scanStatePath(): string {
  return join(agentDir(), "sessions-sweep.json");
}

interface SessionRow {
  path: string;
  project: string;
  id: string;
  cwd: string;
  created: string;
  mtimeMs: number;
  activityMs: number;
  name: string | undefined;
  display: string;
  firstUser: string;
  messageCount: number;
  lastId: string;
  ids: Set<string>;
}

interface Pending {
  id: string;
  path: string;
  project: string;
  oldTitle: string;
  newTitle: string;
}
interface State {
  version: 1;
  scanned: Record<string, number>;
  pending: Pending[];
}

function isState(v: unknown): v is State {
  if (!v || typeof v !== "object") return false;
  if (!("version" in v && "scanned" in v && "pending" in v)) return false;
  const s = v as { version: unknown; scanned: unknown; pending: unknown };
  return s.version === 1 && typeof s.scanned === "object" && Array.isArray(s.pending);
}

async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(scanStatePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isState(parsed)) return parsed;
  } catch {}
  return { version: 1, scanned: {}, pending: [] };
}

function field(obj: object, key: string): unknown {
  return key in obj ? (obj as Record<string, unknown>)[key] : undefined;
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = field(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (typeof c === "string") out += c;
    else if (c && typeof c === "object" && "text" in c && typeof c.text === "string") out += c.text;
  }
  return out;
}

/** One streaming pass per file: header, effective title, first user text. */
async function readSession(path: string, mtimeMs: number, project: string): Promise<SessionRow | null> {
  let id = "";
  let cwd = "";
  let created = "";
  let headerTitle = "";
  let name: string | undefined;
  let titleSource = "";
  let firstUser = "";
  let messageCount = 0;
  let lastActivity = 0;
  let lastId = "";
  const ids = new Set<string>();
  try {
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let headerSeen = false;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || typeof e !== "object") continue;
      // Line 0 is a {"type":"title"} cache sidecar — skip to the session header.
      if (!headerSeen) {
        if (field(e, "type") !== "session") continue;
        headerSeen = true;
        const eid = field(e, "id");
        const ecwd = field(e, "cwd");
        const ets = field(e, "timestamp");
        const etitle = field(e, "title");
        const esource = field(e, "titleSource");
        id = typeof eid === "string" ? eid : "";
        cwd = typeof ecwd === "string" ? ecwd : "";
        created = typeof ets === "string" ? ets : "";
        headerTitle = typeof etitle === "string" ? etitle : "";
        titleSource = typeof esource === "string" ? esource : "";
        continue;
      }
      const eid = field(e, "id");
      if (typeof eid === "string") {
        lastId = eid;
        ids.add(eid);
      }
      const ename = field(e, "name");
      if (field(e, "type") === "session_info" && typeof ename === "string") {
        name = ename.trim() || undefined;
      } else if (field(e, "type") === "message") {
        messageCount++;
        const msg = field(e, "message");
        const ets = field(e, "timestamp");
        if (typeof ets === "string") {
          const t = Date.parse(ets);
          if (!Number.isNaN(t) && t > lastActivity) lastActivity = t;
        }
        if (!firstUser && msg && typeof msg === "object" && field(msg, "role") === "user")
          firstUser = messageText(msg).replace(/\s+/g, " ").trim();
      }
    }
  } catch {
    return null;
  }
  if (!id) return null;
  // Effective title = explicit rename wins; else auto header title; else first user line.
  const trimmedHeader = headerTitle.trim();
  const effective = name ?? (trimmedHeader ? trimmedHeader : undefined);
  const display = effective ?? (firstUser ? firstUser.slice(0, 60) : "(untitled)");
  const createdMs = Date.parse(created);
  // Recency from content, never filesystem mtime: a rename append bumps mtime to now.
  // mtimeMs stays on the row for one purpose only: the apply-loop live-file guard.
  const activityMs = lastActivity || (Number.isNaN(createdMs) ? mtimeMs : createdMs);
  return { path, project, id, cwd, created, mtimeMs, activityMs, name: effective, display, titleSource, firstUser, messageCount, lastId, ids };
}

async function scanAll(): Promise<SessionRow[]> {
  const root = join(agentDir(), "sessions");
  const rows: SessionRow[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(root);
  } catch {
    return rows;
  }
  for (const proj of projects) {
    const dir = join(root, proj);
    let files: string[];
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    } catch {
      continue;
    }
    for (const f of files) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(f)).mtimeMs;
      } catch {
        continue;
      }
      const row = await readSession(f, mtimeMs, proj);
      if (row) rows.push(row);
    }
  }
  // Content-derived recency: filesystem mtime lies after a rename append.
  rows.sort((a, b) => b.activityMs - a.activityMs);
  return rows;
}

// --- naming draft (heuristic; the agent refines the topic) ------------------

const HINTS: [RegExp, (typeof TYPES)[number]][] = [
  [/\b(fix|bug|error|fail|broken|crash|not working|repair|patch)\b/i, "Fix"],
  [/\b(add|implement|create|build|new feature|support for)\b/i, "Feature"],
  [/\b(design|layout|theme|style|ui|ux|mockup|redesign)\b/i, "Design"],
  [/\b(optim|perf|slow|speed|faster|cache|latency)\b/i, "Optimize"],
  [/\b(release|publish|deploy|ship|version bump)\b/i, "Release"],
  [/\b(doc|readme|changelog|comment|guide)\b/i, "Docs"],
  [/\b(research|investigat|survey|landscape|how does|what is|compar)/i, "Research"],
];
function draftName(row: SessionRow): string | null {
  if (!row.firstUser && row.messageCount === 0) return null; // empty: keep original
  let type: (typeof TYPES)[number] = "Explore";
  for (const [re, t] of HINTS)
    if (re.test(row.firstUser)) {
      type = t;
      break;
    }
  let s = row.firstUser.replace(/^\/\S+\s*/, "").replace(/\s+/g, " ").trim();
  // Don't repeat the project name in the topic.
  const baseWords: Record<string, true> = {};
  for (const w of basename(row.cwd).toLowerCase().replace(/[-_.]/g, " ").split(" "))
    if (w.length > 2) baseWords[w] = true;
  s = s
    .split(" ")
    .filter((w) => !baseWords[w.toLowerCase().replace(/[^a-z0-9]/g, "")])
    .join(" ");
  s = s.replace(/[?!.…,]+$/g, "").trim();
  if (!s) return null;
  const topic = s.split(" ").slice(0, 6).join(" ");
  const short = topic.length > 42 ? topic.slice(0, 42).trim() : topic;
  const d = new Date(row.created);
  const stamp = Number.isNaN(d.getTime())
    ? "0000"
    : String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  return `${stamp}｜${type}｜${short}`;
}

// --- rename (title only) ----------------------------------------------------

/** Append one session_info leaf; returns false only when the file can't be touched. */
async function renameFile(row: SessionRow, newTitle: string): Promise<boolean> {
  let entryId = randomUUID().slice(0, 8);
  for (let i = 0; i < 100 && row.ids.has(entryId); i++) entryId = randomUUID().slice(0, 8);
  const entry = {
    type: "session_info",
    id: entryId,
    parentId: row.lastId || null,
    timestamp: new Date().toISOString(),
    name: newTitle,
  };
  try {
    await fs.appendFile(row.path, JSON.stringify(entry) + "\n");
  } catch {
    return false;
  }
  // Best-effort mirror for the history.db title cache; the jsonl stays authoritative.
  try {
    await fs.stat(join(agentDir(), "history.db"));
    spawnSync("sqlite3", [join(agentDir(), "history.db"), `INSERT INTO session_titles(session_id,title,updated_at) VALUES('${row.id.replace(/'/g, "''")}','${newTitle.replace(/'/g, "''")}',${Math.floor(Date.now() / 1000)}) ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at;`], { stdio: "ignore" });
  } catch {}
  return true;
}

function show(ctx: ExtensionCommandContext, key: string, lines: string[]): void {
  // Widget keeps long tables visible above the editor; notify carries the summary.
  // Widget only in TUI: headless callers rely on the full printed list (no cap).
  try {
    const tui = ctx.hasUI && ctx.mode === "tui";
    ctx.ui.setWidget(key, tui ? lines.slice(0, 90) : lines, { placement: "aboveEditor" });
  } catch {}
}

// --- commands ---------------------------------------------------------------

export default function sessionsPlugin(pi: ExtensionAPI) {
  pi.registerCommand("sessions-sweep", {
    description: "Audit all session titles vs MMDD｜<type>｜<topic>, draft renames, or --apply after confirmation",
    handler: async (args, ctx) => {
      const rest = (args || "").trim();
      const st = await loadState();

      if (rest === "--apply") {
        if (st.pending.length === 0) {
          ctx.ui.notify("sessions-sweep: nothing pending.", "info");
          return;
        }
        const rows = await scanAll();
        const live: Record<string, SessionRow> = {};
        for (const r of rows) live[r.id] = r;
        const done: string[] = [];
        const failed: Record<string, true> = {};
        const skipped: string[] = [];
        const currentId = ctx.sessionManager.getSessionId();
        for (const p of st.pending) {
          const row = live[p.id];
          if (!row) {
            skipped.push(`${p.id.slice(0, 8)} (gone)`);
            continue;
          }
          if ((row.name ?? "") === p.newTitle) {
            done.push(`${p.id.slice(0, 8)} (already renamed)`);
            continue;
          }
          if (row.id === currentId) {
            // Current session: rename through the live manager, not the file.
            try {
              pi.setSessionName(p.newTitle);
              done.push(`${p.id.slice(0, 8)} → ${p.newTitle}`);
            } catch {
              failed[p.id] = true;
            }
            continue;
          }
          // Skip files touched in the last minute — likely live elsewhere.
          if (Date.now() - row.mtimeMs < 60_000) {
            skipped.push(`${p.id.slice(0, 8)} (live, retry later)`);
            continue;
          }
          if (await renameFile(row, p.newTitle)) done.push(`${p.id.slice(0, 8)} → ${p.newTitle}`);
          else failed[p.id] = true;
        }
        st.pending = st.pending.filter((p) => failed[p.id] || skipped.some((s) => s.startsWith(p.id.slice(0, 8))));
        for (const r of rows) st.scanned[r.path] = `${r.activityMs}:${r.messageCount}:${r.lastId}`;
        await fs.writeFile(scanStatePath(), JSON.stringify(st, null, 2));
        show(ctx, "sessions-sweep", ["sessions-sweep --apply", ...done.map((d) => `  ✓ ${d}`), ...skipped.map((s) => `  … ${s}`), ...Object.keys(failed).map((f) => `  ✗ ${f.slice(0, 8)}`)]);
        ctx.ui.notify(`Renamed ${done.length}, skipped ${skipped.length}, failed ${Object.keys(failed).length}.`, done.length ? "info" : "warning");
        return;
      }

      const rows = await scanAll();
      let fresh = 0;
      for (const r of rows) {
        // Marker is content-derived (activity + entry count), never mtime:
        // a rename append bumps mtime to now and must invalidate the marker.
        const mark = `${r.activityMs}:${r.messageCount}:${r.lastId}`;
        if (rest !== "--rescan" && st.scanned[r.path] === mark) continue;
        fresh++;
        st.scanned[r.path] = mark;
        if (r.name && RULE.test(r.name)) continue;
        // No title and no user text: nothing to derive a topic from, keep the original.
        if (!r.name && !r.firstUser) continue;
        if (st.pending.some((p) => p.id === r.id)) continue;
        const draft = draftName(r);
        st.pending.push({
          id: r.id,
          path: r.path,
          project: r.project,
          oldTitle: r.display,
          // Empty draft = topic undeterminable: keep original per rule.
          newTitle: draft ?? r.name ?? r.display,
        });
      }
      // Drop pending whose file is gone or already compliant.
      const live: Record<string, SessionRow> = {};
      for (const r of rows) live[r.id] = r;
      st.pending = st.pending.filter((p) => {
        const r = live[p.id];
        return r && (r.name || r.firstUser) && (r.name ?? "") !== p.newTitle && (!r.name || !RULE.test(r.name));
      });
      await fs.writeFile(scanStatePath(), JSON.stringify(st, null, 2));

      show(ctx, "sessions-sweep", [
        `sessions-sweep: ${rows.length} sessions, ${fresh} newly scanned, ${st.pending.length} need naming`,
        ``,
        `| Old name | New name |`,
        `|---|---|`,
        ...st.pending.map((p) => `| ${p.oldTitle} | ${p.newTitle} |`),
        ``,
        `Detail (hash · path · project):`,
        ...st.pending.map((p) => `  ${p.id.slice(0, 8)} · ${p.path} · ${p.project.replace(/^-+/, "").replace(/-+/g, "/")}`),
        ``,
        `Next: refine topics from conversation content, edit ${scanStatePath()} if needed, confirm with the user, then /sessions-sweep --apply.`,
      ]);
      ctx.ui.notify(`Swept ${rows.length} sessions (${fresh} new). ${st.pending.length} violate the naming rule — see table above.`, "info");
    },
  });

  pi.registerCommand("sessions-rename", {
    description: "Rename one session title: /sessions-rename <id-prefix> <MMDD｜<type>｜<topic>>",
    handler: async (args, ctx) => {
      const m = (args || "").trim().match(/^(\S+)\s+(.+)$/);
      if (!m) {
        ctx.ui.notify("Usage: /sessions-rename <id-prefix> <MMDD｜<type>｜<topic>>", "warning");
        return;
      }
      const title = m[2].trim();
      if (!RULE.test(title)) {
        ctx.ui.notify(`Not the rule format. Types: ${TYPES.join(" ")}.`, "warning");
        return;
      }
      const rows = await scanAll();
      const hits = rows.filter((r) => r.id.startsWith(m[1]));
      if (hits.length === 0) {
        ctx.ui.notify(`No session id starts with ${m[1]}.`, "warning");
        return;
      }
      if (hits.length > 1) {
        ctx.ui.notify(`Ambiguous: ${hits.map((h) => h.id.slice(0, 8)).join(", ")}`, "warning");
        return;
      }
      const row = hits[0];
      if (row.id === ctx.sessionManager.getSessionId()) {
        pi.setSessionName(title);
      } else if (!(await renameFile(row, title))) {
        ctx.ui.notify("Rename failed (file not writable).", "error");
        return;
      }
      const st = await loadState();
      st.pending = st.pending.filter((p) => p.id !== row.id);
      st.scanned[row.path] = `${row.activityMs}:${row.messageCount}:${row.lastId}`;
      await fs.writeFile(scanStatePath(), JSON.stringify(st, null, 2));
      ctx.ui.notify(`Renamed ${row.id.slice(0, 8)} → ${title}`, "info");
    },
  });

  pi.registerCommand("sessions", {
    description: "Cross-project session list: pick one to jump to, no cd needed",
    handler: async (args, ctx) => {
      const rows = await scanAll();
      if (rows.length === 0) {
        ctx.ui.notify("No sessions on this host.", "warning");
        return;
      }
      const q = (args || "").trim().toLowerCase();
      const pool = q ? rows.filter((r) => `${r.display} ${r.firstUser} ${r.project} ${r.id}`.toLowerCase().includes(q)) : rows;
      // scanAll is activity-desc: latest real conversation at top. No cap — every session is reachable.
      // No ordinal prefixes: a leading "1. " hijacks date search ("1011" matches "1. …" first).
      const options = pool.map((r) => {
        const d = new Date(r.activityMs);
        const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        return `${stamp}｜${r.display} [${r.project.replace(/^-+/, "").replace(/-+/g, "/")}] ${r.id.slice(0, 8)}`;
      });
      show(ctx, "sessions", [
        `sessions: ${pool.length} shown (${rows.length} total), latest first. Type to filter, Enter jumps — or resume directly:`,
        ...pool.map((r, i) => `  ${options[i]} ${r.path}`),
      ]);
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("Pick a path from the list above and run: omp -r <path>", "info");
        return;
      }
      const choice = await ctx.ui.select("Jump to session (type to filter)", options);
      if (!choice) return;
      const target = pool[options.indexOf(choice)];
      if (!target) {
        ctx.ui.notify("sessions: choice did not match any row — report this.", "error");
        return;
      }
      try {
        await ctx.switchSession(target.path);
      } catch (err) {
        // MissingSessionCwd: target dir is gone — retry inside the current cwd.
        try {
          await ctx.switchSession(target.path, {
            withSession: async () => {},
          });
        } catch (err2) {
          ctx.ui.notify(`sessions: switch failed: ${err2 instanceof Error ? err2.message : String(err2)}`, "error");
          return;
        }
      }
      ctx.ui.notify(`sessions: jumped to ${target.display} [${target.id.slice(0, 8)}]`, "info");
    },
  });
}
