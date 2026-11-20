import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, agents, terminals, machines, exec, readTextFile, watchFolder, theme, settings, shared, setShared, openOverlay, home, run, pickFolder, notify } from "herdr";
import { typeIcon, folderIcon } from "./filetypes.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Syntax colors for the diff: a small line-by-line highlighter shared by the usual languages
// (one keyword list, comment style by file type). A block comment opened on an earlier line
// isn't known, so its later lines stay plain.
const KEYWORDS = new Set(`abstract and as async await break case catch class const continue def default defer del do dynamic elif else enum
  except export extends false final finally fn for from func function get go if impl implements import in instanceof interface is lambda late
  let loop match mod mut namespace new nil none None not null of or override package pass private protected pub public raise readonly
  required return self Self set static struct super switch this throw throws trait true True False try type typeof undefined use val var
  void when where while with yield echo foreach elseif fi then esac done local select from where join order by group insert update delete`.split(/\s+/));
const HASH_COMMENT = new Set(["py", "sh", "bash", "zsh", "fish", "rb", "yml", "yaml", "toml", "conf", "ini", "dockerfile", "makefile", "r", "pl", "nix"]);
const MARKUP = new Set(["jsx", "tsx", "html", "htm", "vue", "svelte", "xml", "svg", "astro"]);
const PLAIN = new Set(["md", "mdx", "txt", "csv", "log", "lock"]);
const langOf = (path) => {
  const name = path.split("/").pop().toLowerCase(), ext = name.includes(".") ? name.split(".").pop() : name;
  return { plain: PLAIN.has(ext), hash: HASH_COMMENT.has(ext), markup: MARKUP.has(ext), sql: ext === "sql" };
};
function tokenize(text, lang) {
  if (lang.plain) return [{ text }];
  const out = [], push = (t, kind) => { if (t) out.push({ text: t, kind }); };
  let i = 0;
  const rest = () => text.slice(i);
  while (i < text.length) {
    const s = rest();
    let m;
    if ((lang.hash && (m = /^#.*/.exec(s))) || (!lang.hash && (m = /^\/\/.*/.exec(s))) || (m = /^\/\*.*?(\*\/|$)/.exec(s)) ||
        (lang.markup && (m = /^<!--.*?(-->|$)/.exec(s))) || (lang.sql && (m = /^--.*/.exec(s)))) push(m[0], "comment");
    else if ((m = /^"(?:[^"\\]|\\.)*"?/.exec(s)) || (m = /^'(?:[^'\\]|\\.)*'?/.exec(s)) || (m = /^`(?:[^`\\]|\\.)*`?/.exec(s))) push(m[0], "string");
    else if (lang.markup && (m = /^(<\/?)([A-Za-z][\w.:-]*)/.exec(s))) { push(m[1], "punct"); push(m[2], "tag"); }
    else if ((m = /^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/.exec(s))) push(m[0], "number");
    else if ((m = /^[A-Za-z_$@][\w$]*/.exec(s))) {
      const after = text.slice(i + m[0].length);
      const kind = KEYWORDS.has(m[0]) ? "keyword" : /^\s*\(/.test(after) ? "function" : lang.markup && /^=(?!=)/.test(after) ? "attr"
        : /^[A-Z]/.test(m[0]) ? "type" : null;
      push(m[0], kind);
    }
    else if ((m = /^\s+/.exec(s))) push(m[0], null);
    else if ((m = /^[()[\]{}]/.exec(s))) push(m[0], "bracket");
    else { m = /^[^\w\s"'`()[\]{}]+/.exec(s) ?? [s[0]]; push(m[0], "punct"); }
    i += m[0].length;
  }
  return out;
}
// Splits tokens where the changed-words mark starts and ends.
function markTokens(tokens, mark) {
  if (!mark || mark[1] <= mark[0]) return tokens;
  const out = [];
  let at = 0;
  for (const tk of tokens) {
    const end = at + tk.text.length, cuts = [at, ...[mark[0], mark[1]].filter((c) => c > at && c < end), end];
    for (let c = 0; c + 1 < cuts.length; c++) out.push({ ...tk, text: tk.text.slice(cuts[c] - at, cuts[c + 1] - at), hl: cuts[c] >= mark[0] && cuts[c] < mark[1] });
    at = end;
  }
  return out;
}

// Pairs each removed line with the added line in the same place of its change block and marks
// the part that differs, so a changed word stands out from the unchanged rest of the line.
function markWords(rows) {
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].kind === "-") j++;
    let k = j; while (k < rows.length && rows[k].kind === "+") k++;
    for (let n = 0; n < Math.min(j - i, k - j); n++) {
      const a = rows[i + n], b = rows[j + n], max = Math.min(a.text.length, b.text.length);
      let p = 0; while (p < max && a.text[p] === b.text[p]) p++;
      let s = 0; while (s < max - p && a.text[a.text.length - 1 - s] === b.text[b.text.length - 1 - s]) s++;
      // Out to whole words: "qty" → "quantity" marks both words, not "" and "uanti".
      const word = (c) => /[\p{L}\p{N}_]/u.test(c ?? "");
      while (p > 0 && word(a.text[p - 1])) p--;
      while (s > 0 && word(a.text[a.text.length - s]) && word(b.text[b.text.length - s])) s--;
      // Only when part of the line stayed: a line rewritten from scratch is all change anyway.
      if (p + s > 0) { a.mark = [p, a.text.length - s]; b.mark = [p, b.text.length - s]; }
    }
    i = Math.max(k, i + 1);
  }
  return rows;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return markWords(lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  }));
}

// Icons: Codicons (see CODICONS-LICENSE), tinted with the theme.
const ICONS = "mods/changes";
// File and folder icons: the Files panel's mi/*.svg (Material Icon Theme, see filetypes.js).
const FT = "mods/files";
const icon = (name, size = 14) => svg(`${ICONS}/scm-${name}.svg`).size(size).flex_none();
// git's letters as editors show them: U untracked, C conflict.
const LETTER_TINT = { U: "ansi2", A: "ansi2", M: "blocked", D: "ansi1", C: "ansi5" };
const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const LETTER = { A: "A", M: "M", D: "D", T: "M" };

// Splits `git status` into what's staged (index vs HEAD) and what isn't (work tree vs index,
// untracked, conflicts). A partly staged file is in both.
function parseStatus(stdout) {
  const staged = [], changes = [];
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (CONFLICT.has(x + y)) { changes.push({ path, status: "C" }); continue; }
    if (x === "?") { changes.push({ path, status: "U", fresh: true }); continue; }
    if (x !== " ") staged.push({ path, status: LETTER[x] ?? "M" });
    if (y !== " ") changes.push({ path, status: LETTER[y] ?? "M" });
  }
  return { staged, changes };
}

// Session mode. When an agent first shows up, the panel snapshots its repo's working tree
// (tracked and untracked files, minus .gitignore) as a git tree. The session's files are
// those that differ between that snapshot and the tree now, so whatever was already changed
// before the agent started stays out. Snapshots go through scratch indexes in the temp folder:
// the repo's own index, HEAD and branches are never touched; only blobs are added to .git/objects.
const SESSIONS = "changes.sessions";
const ENDED_KEEP = 3 * 24 * 3600 * 1000;
// A session as saved: session() adds its address on top.
const record = ({ address: _a, ...rest }) => rest;
// Every repo a session covers: the one its agent started in, then the others it worked in
// (`extra`: {root: {tree, head, paths, at}}), each with its own snapshot.
function sessionRoots(s) {
  const out = [];
  if (s?.root && s.tree) out.push({ root: s.root, tree: s.tree, head: s.head, paths: s.paths, primary: true });
  for (const [root, x] of Object.entries(s?.extra ?? {})) if (root !== s.root && x?.tree) out.push({ root, ...x, primary: false });
  return out;
}
// A session's snapshot of one of its repos, changed (after a commit, Start over).
function withRoot(s, root, change) {
  if (s.root === root) return { ...s, ...change };
  return { ...s, extra: { ...(s.extra ?? {}), [root]: { ...(s.extra?.[root] ?? {}), ...change } } };
}
const tilde = (path) => { const h = home(); return h && path.startsWith(h + "/") ? `~${path.slice(h.length)}` : path; };
// Which agent session runs in each Herdr terminal, for any agent CLI. A terminal's agent is
// the first program under its shell(s) (processes carry HC_TERMINAL_ID). Its session id:
// - Claude Code: ~/.claude/sessions/<pid>.json (checked against the start time: pids get reused);
// - else the uuid of a session file it (or a child) holds open: Codex's sessions/…/rollout-<id>,
//   Antigravity's presence/<id>.lock, Cursor's chats/…/<id>/store.db, and the like;
// - else the process itself ("proc:"): a new process is a new session. Codex in daemon mode
//   lands here, as its thread lives in the shared daemon.
// Prints {"t35": {"id": "claude:<id>", "pid": 49301}}.
const AGENT_SESSIONS = String.raw`
import glob, json, os, re
SHELLS = {"bash", "sh", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish"}
SESSION = re.compile(r"/(?:sessions?|session-state|chats?|conversations?|threads?|presence|brain)/(?:[^/]*/)*?[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
procs = {}
for p in os.listdir("/proc"):
    if not p.isdigit(): continue
    try:
        t = next((e[15:].decode() for e in open(f"/proc/{p}/environ", "rb").read().split(b"\0") if e.startswith(b"HC_TERMINAL_ID=")), None)
        if not t: continue
        s = open(f"/proc/{p}/stat").read()
        f = s.rsplit(")", 1)[1].split()
        procs[int(p)] = {"term": t, "ppid": int(f[1]), "start": f[19], "name": s[s.index("(") + 1:s.rindex(")")]}
    except Exception: pass
kids = {}
for pid, p in procs.items(): kids.setdefault(p["ppid"], []).append(pid)
def shell(pid): return procs[pid]["name"] in SHELLS
def tree(pid):
    yield pid
    for k in kids.get(pid, []): yield from tree(k)
def orphan(ppid):
    # Reparented to init or a systemd subreaper: its starter (an agent's helper launcher, e.g. an
    # MCP server's) exited. It still carries the terminal's id but isn't the terminal's program.
    if ppid <= 1: return True
    try: s = open(f"/proc/{ppid}/stat").read(); return s[s.index("(") + 1:s.rindex(")")] in ("systemd", "init")
    except Exception: return False
# The agent: a non-shell process whose ancestors in its terminal are all shells. One with a
# known session (below) beats one without; then the newest wins.
cands = {}
for pid, p in procs.items():
    if shell(pid): continue
    up = p["ppid"]
    while up in procs and procs[up]["term"] == p["term"] and shell(up): up = procs[up]["ppid"]
    if up in procs and procs[up]["term"] == p["term"]: continue
    if up not in procs and orphan(up): continue
    cands.setdefault(p["term"], []).append(pid)
claude = {}
def load(f):
    # Claude Code rewrites the file all the time (status, updatedAt): a read can catch it half written.
    for _ in range(3):
        try: return json.load(open(f))
        except ValueError: __import__("time").sleep(0.02)
    return json.load(open(f))
for f in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
    try:
        j = load(f); pid = int(j["pid"])
        if pid in procs and j.get("sessionId") and str(j.get("procStart") or procs[pid]["start"]) == procs[pid]["start"]: claude[pid] = j["sessionId"]
    except Exception: pass
agents = {t: max(pids, key=lambda q: (any(x in claude for x in tree(q)), int(procs[q]["start"]))) for t, pids in cands.items()}
# What each agent changed, in any repo: its transcript, read on from where the last run stopped
# (offsets cached in the temp folder). Claude Code: Edit/Write/MultiEdit/NotebookEdit file paths;
# Codex and the like: apply_patch's "*** Update File:" lines. Repos its commands name (paths
# under home in a Bash call) or run in (its child processes' folders) count as touched.
HOME = os.path.expanduser("~")
CACHE = "/tmp/herdr-changes-transcripts-%d.json" % os.getuid()
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
PATCH = re.compile(r"\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\\\n\"]+)")
HOMEPATH = re.compile(r"(?<![\w.~/-])(" + re.escape(HOME) + r"/[^\s'\"\x60;|&<>()$\\]+|~/[^\s'\"\x60;|&<>()$\\]+)")
try: cache = json.load(open(CACHE))
except Exception: cache = {}
seen, roots = set(), {}
def root_of(path):
    d = path if os.path.isdir(path) else os.path.dirname(path)
    walked = []
    while d and d != "/" and d != HOME:
        if d in roots: r = roots[d]; break
        walked.append(d)
        if os.path.exists(d + "/.git"): r = d; break
        d = os.path.dirname(d)
    else: r = None
    for w in walked: roots[w] = r
    return r
def when(j):
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(j.get("timestamp")).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception: return 0
def scan(path, cwd):
    seen.add(path)
    try: size = os.path.getsize(path)
    except Exception: return None
    c = cache.get(path)
    if not c or c["off"] > size: c = {"off": 0, "edits": {}, "touch": {}, "cwd": cwd}
    if size > c["off"]:
        with open(path, "rb") as f: f.seek(c["off"]); data = f.read(64 << 20)
        end = data.rfind(b"\n") + 1
        for raw in data[:end].split(b"\n"):
            if not raw or not (b'"tool_use"' in raw or b"File: " in raw or b"_call" in raw or b"session_meta" in raw or b"turn_context" in raw): continue
            line = raw.decode("utf-8", "replace")
            try: j = json.loads(line)
            except Exception: continue
            ts = when(j)
            p = j.get("payload") if isinstance(j.get("payload"), dict) else {}
            if j.get("type") in ("session_meta", "turn_context") and p.get("cwd"): c["cwd"] = p["cwd"]
            here = j.get("cwd") or c["cwd"]
            content = (j.get("message") or {}).get("content") if isinstance(j.get("message"), dict) else None
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict) or b.get("type") != "tool_use": continue
                inp = b.get("input") or {}
                if b.get("name") in EDIT_TOOLS:
                    f = inp.get("file_path") or inp.get("notebook_path")
                    if f: f = os.path.join(here, f); c["edits"][f] = max(ts, c["edits"].get(f, 0))
                elif b.get("name") == "Bash":
                    for m in HOMEPATH.findall(str(inp.get("command", ""))): c["touch"][os.path.expanduser(m)] = ts
            if not content:
                for m in PATCH.findall(line):
                    f = os.path.join(here, m.strip()); c["edits"][f] = max(ts, c["edits"].get(f, 0))
                if "_call" in line:
                    for m in HOMEPATH.findall(line): c["touch"][os.path.expanduser(m)] = ts
        c["off"] += end
    cache[path] = c
    return c
now = int(__import__("time").time() * 1000)
def work(pid, sid, files):
    try: cwd = os.readlink(f"/proc/{pid}/cwd")
    except Exception: cwd = HOME
    edits, touch = {}, {}
    for path in files:
        c = scan(path, cwd)
        if not c: continue
        for f, ts in c["edits"].items():
            r = root_of(f)
            if r: edits.setdefault(r, {})[os.path.relpath(f, r)] = max(ts, edits.get(r, {}).get(os.path.relpath(f, r), 0))
        for f, ts in c["touch"].items():
            r = root_of(f)
            if r: touch[r] = max(ts, touch.get(r, 0))
    for q in tree(pid):
        if q == pid: continue
        try:
            r = root_of(os.readlink(f"/proc/{q}/cwd"))
            if r: touch[r] = now
        except Exception: pass
    return edits, touch
out = {}
for t, pid in agents.items():
    sid, files = None, []
    for q in tree(pid):
        if q in claude:
            sid = "claude:" + claude[q]
            files = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{claude[q]}.jsonl")) + glob.glob(os.path.expanduser(f"~/.claude/projects/*/{claude[q]}/**/*.jsonl"), recursive=True)
            break
    if not sid:
        for q in tree(pid):
            try:
                for fd in os.listdir(f"/proc/{q}/fd"):
                    link = os.readlink(f"/proc/{q}/fd/{fd}")
                    m = SESSION.search(link)
                    if m:
                        sid = procs[pid]["name"] + ":" + m.group(1)
                        if link.endswith(".jsonl"): files = [link]
                        break
            except Exception: pass
            if sid: break
    edits, touch = work(pid, sid, files)
    out[t] = {"id": sid or "proc:%s:%d:%s" % (procs[pid]["name"], pid, procs[pid]["start"]), "pid": pid, "edits": edits, "touch": touch}
try:
    tmp = CACHE + ".%d" % os.getpid()
    json.dump({k: v for k, v in cache.items() if k in seen}, open(tmp, "w")); os.replace(tmp, CACHE)
except Exception: pass
print(json.dumps(out))
`;
const hash = (s) => { let h = 5381; for (const c of s) h = (h * 33 + c.codePointAt(0)) >>> 0; return h.toString(36); };

// Tree view: folders first, then files, each by name. A folder holding only one folder shows as
// one row ("src/app").
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/"); parts.pop();
    let node = root, path = "";
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      if (!node.dirs.has(name)) node.dirs.set(name, { name, path, dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    node.files.push(f);
  }
  return root;
}
function allPaths(node) {
  const paths = node.files.map((f) => f.path);
  for (const d of node.dirs.values()) paths.push(...allPaths(d));
  return paths;
}
function treeRows(node, collapsed, group, depth = 0, out = []) {
  for (let d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    let name = d.name;
    while (!d.files.length && d.dirs.size === 1) { d = d.dirs.values().next().value; name += `/${d.name}`; }
    out.push({ dir: d.path, name, depth, paths: allPaths(d) });
    if (!collapsed.has(`${group}:${d.path}`)) treeRows(d, collapsed, group, depth + 1, out);
  }
  for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ file: f, depth });
  return out;
}

// Generate: Claude Code in print mode (claude-auto first, a wrapper some setups put in front of
// it) reads a diff on stdin, cut at 60 KB, and answers with one subject line in the style of the
// repo's recent commits. It describes what Commit would commit: the staged changes, or when
// nothing is staged yet, the session's changes (Session) or everything (All).
const GENERATE = `
ai=$(command -v claude-auto || command -v claude) || { echo "Claude Code (claude) is not installed here" >&2; exit 127; }
root=$1; kind=$2; base=$3; now=$4
g() { git -C "$root" --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false "$@"; }
prompt="Write a git commit message for the changes on stdin. Answer with one line under 72 characters and nothing else: no quotes, no code fences, no explanation. Match the style of these recent commit subjects:
$(g log -15 --format=%s 2>/dev/null)"
{
  case $kind in
    cached) g diff --cached --no-color --no-ext-diff --stat; g diff --cached --no-color --no-ext-diff ;;
    range) g diff --no-color --no-ext-diff --stat "$base" "$now"; g diff --no-color --no-ext-diff "$base" "$now" ;;
    *)
      if g rev-parse -q --verify HEAD >/dev/null; then g diff --no-color --no-ext-diff --stat HEAD; g diff --no-color --no-ext-diff HEAD
      else g diff --no-color --no-ext-diff --cached; g diff --no-color --no-ext-diff; fi
      g ls-files --others --exclude-standard | sed 's/^/untracked file: /' ;;
  esac
} | head -c 60000 | "$ai" -p --model haiku --no-session-persistence --tools "" --setting-sources "" --output-format text "$prompt"
`;

function parseNumstat(stdout, stats = {}) {
  for (const entry of stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return stats;
}

// The compare view's palette (mods/diff-view keeps the same one): GitHub's dark syntax colors on
// solid green and red rows, changed words a step brighter than their row.
const VIVID = {
  syntax: { keyword: "#ff7b72", control: "#ff7b72", literal: "#79c0ff", function: "#d2a8ff", type: "#ffa657", tag: "#7ee787",
    string: "#a5d6ff", number: "#79c0ff", attr: "#79c0ff", bracket: "#e6edf3", comment: "#8b949e", punct: "#e6edf3" },
  text: "#e6edf3", add: "#0f3d1c", del: "#4d1418", addWord: "#1f6f3a", delWord: "#8e2a31",
  addSign: "#3fb950", delSign: "#f85149", number: "#6e7681", changedNumber: "#c9d1d9", guide: "#ffffff14",
};
const CONTROL = new Set(`if else for while do switch case default break continue return throw try catch finally await yield new delete
  in of instanceof typeof match loop when elif except raise pass with then fi esac done`.split(/\s+/));
const LITERAL = new Set("true false null undefined this self Self super None True False nil none".split(" "));

// The ⋯ menu (mods/git-menu) asks, then hands the work here as { owner, seq, kind, ... }:
// a popup's own tasks end when it closes.
const GITOP = "changes.gitop";
// Network git never waits for a password nobody can type.
const QUIET = ["GIT_TERMINAL_PROMPT=0", "GIT_MERGE_AUTOEDIT=no", "GIT_EDITOR=true"];
const STATUS_ORDER = { C: 0, U: 1, A: 2, M: 3, D: 4 };
// The diff follows the font_size setting; it was laid out for 12.5px text: 22px rows, 7.6px characters.
const diffSize = () => settings().font_size ?? 12.5;
const rowHeight = (size) => Math.ceil(size * 1.76), charWidth = (size) => size * 0.608;
const SORTS = {
  name: (a, b) => a.path.split("/").pop().localeCompare(b.path.split("/").pop()) || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
  status: (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.path.localeCompare(b.path),
};
// What git said last, for a short note: its last few lines.
const tail = (text, n = 3) => text.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(" · ");

// A failed git run as an Error: a short message for the panel's note (git's error:/fatal:/
// CONFLICT lines when it printed any, else its last lines) and everything it printed, stdout
// and stderr, for the error dialog. Pull and merge print CONFLICT on stdout and only
// "From <remote>" on stderr, so neither stream alone says what went wrong.
function gitError(r, command, fallback) {
  const detail = [r.stdout, r.stderr].map((s) => (s ?? "").trim()).filter(Boolean).join("\n");
  const key = detail.split("\n").map((l) => l.trim()).filter((l) => /^(error|fatal|CONFLICT|! \[)/.test(l));
  const e = new Error((key.length ? key.slice(0, 3).join(" · ") : tail(detail, 4)) || fallback || `${command} failed (exit ${r.code})`);
  e.detail = detail || `${command} exited with code ${r.code} and printed nothing.`;
  e.command = command;
  return e;
}

// A successful run in one line: its last line (git ends with the useful one: "Already up to
// date.", "main -> main", "Everything up-to-date").
const summary = (out) => tail(out ?? "", 1) || "done";

// What to do next, in plain words, for the git errors people meet most.
function gitHint(text) {
  const s = text ?? "";
  if (/\[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because the (remote|tip)/.test(s))
    return "The remote has commits you don't have yet. Pull first (⋯ › Pull, Push › Pull, or Pull (Rebase)), fix any conflicts, then Push again. Use Push (Force with Lease) only if you mean to throw the remote's commits away.";
  if (/\[rejected\].*\(stale info\)|stale info/.test(s))
    return "Someone pushed since your last fetch, so the force push was refused. Fetch, look at what they pushed, then decide.";
  if (/CONFLICT|Automatic merge failed|fix conflicts|Resolve all conflicts manually|could not apply/.test(s))
    return "There are merge conflicts. Open the files marked C in Changes, keep the parts you want and remove the <<<<<<< ======= >>>>>>> markers, stage them with +, then Commit. To back out instead: Commit › Abort Rebase (for a rebase) or run git merge --abort (for a merge).";
  if (/divergent branches|Need to specify how to reconcile/.test(s))
    return "Your branch and the remote both have new commits. Use Pull, Push › Pull (Rebase) to put yours on top, or set git config pull.rebase false to merge.";
  if (/would be overwritten by (merge|checkout)|Please commit your changes or stash them/.test(s))
    return "You have uncommitted changes in files this would overwrite. Commit them, or Stash them (⋯ › Stash), then try again.";
  if (/You have unstaged changes|cannot (pull|rebase) with rebase: You have unstaged changes/.test(s))
    return "Rebase needs a clean working tree. Commit or Stash your changes first.";
  if (/has no upstream branch|no tracking information/.test(s))
    return "This branch isn't linked to a remote branch yet. Use Branch › Publish Branch…, or Pull, Push › Push to…";
  if (/rebase in progress|You are currently rebasing|middle of a (rebase|merge)|MERGE_HEAD exists|unfinished merge/.test(s))
    return "A merge or rebase is still in progress. Finish it (resolve, stage, commit) or abort it (Commit › Abort Rebase, or git merge --abort).";
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|403|Invalid username or password/.test(s))
    return "Git couldn't log in to the remote. Check your SSH key (ssh -T git@github.com) or credential helper / token, e.g. gh auth login, then try again.";
  if (/Could not resolve host|Connection timed out|Connection refused|unable to access/.test(s))
    return "The remote couldn't be reached. Check your network or VPN, and the remote URL (Remote menu).";
  if (/does not appear to be a git repository|No configured push destination|No such remote/.test(s))
    return "There's no usable remote. Add one with Remote › Add Remote…";
  if (/not fully merged/.test(s))
    return "That branch has commits that aren't merged anywhere. Use Delete Branch (Force) if you really want them gone.";
  if (/already exists/.test(s)) return "Something with that name already exists. Pick another name.";
  return null;
}

const GROUP_TITLE = { staged: "Staged Changes", outside: "Staged outside this session", changes: "Changes", committed: "Committed by this session" };

export default class Changes extends View {
  init(_props, cx) {
    this.groups = []; this.rows = []; this.longest = 0; this.message = ""; this.handle = cx.focus_handle();
    this.pending = new Set(); this.queue = {}; this.collapsed = new Set(); this.folded = new Set(); this.foldedRepos = new Set();
    this.repos = []; this.active = null; this.watched = new Set(); this.watchGen = 0;
    try { this.mode = localStorage.getItem("mode") === "all" ? "all" : "session"; } catch { this.mode = "session"; }
    try { this.tree = localStorage.getItem("view") !== "list"; } catch { this.tree = true; }
    // The diff under the list can be put away: files then open in the side-by-side compare.
    try { this.preview = localStorage.getItem("preview") !== "off"; } catch { this.preview = true; }
    // The file list's height when dragged (the line above the diff); null: as tall as its rows.
    try { const h = Number(localStorage.getItem("listHeight")); this.listH = h > 0 ? h : null; } catch { this.listH = null; }
    this.panelH = 800; this.listMeasured = 200; this.genSeq = 0; this.msgW = 0;
    // The ⋯ menu's work for this copy only, and none left over from before it started.
    this.uid = `${Date.now()}-${Math.random()}`; this.opSeq = shared(GITOP)?.seq ?? null; this.doneSeq = 0;
    try { this.sort = SORTS[localStorage.getItem("sort")] ? localStorage.getItem("sort") : "path"; } catch { this.sort = "path"; }
    this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // Search: text in every file of the working tree (see search()).
    this.searching = false; this.query = ""; this.found = null; this.foundFolded = new Set(); this.findSeq = 0; this.findRun = 0;
    try { this.findCase = localStorage.getItem("findCase") === "1"; this.findRegex = localStorage.getItem("findRegex") === "1"; }
    catch { this.findCase = false; this.findRegex = false; }
    this.find = InputState.new({ placeholder: "Search in all files" });
    // Runs a moment after typing stops, not on every key.
    this.find.on("change", (_e, cx) => {
      const q = this.find.value();
      if (q === this.query) return;
      this.query = q;
      const seq = ++this.findSeq;
      cx.timer.after(250, (cx) => { if (seq === this.findSeq) this.search(cx); });
    });
    this.find.on("submit", (_e, cx) => this.search(cx));
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.timer.every(3000, (cx) => this.attribute(cx));
  }

  // A group of the repo Commit acts on, by kind ("staged", "outside", "changes", "committed").
  group(kind, repo = this.repo()) { return repo?.groups.find((g) => g.kind === kind)?.items ?? []; }
  // A row's key: `<group id>|<path>`; the group id is `<repo root>#<kind>`.
  item(key) {
    const g = this.groups.find((x) => key.startsWith(`${x.id}|`)), path = g ? key.slice(g.id.length + 1) : key.slice(key.indexOf("|") + 1);
    return { group: g?.kind ?? null, path, repo: g?.repo ?? null, item: g?.items.find((f) => f.path === path) };
  }

  // The agent whose changes Session mode shows: the focused terminal's. A plain terminal has
  // none of its own and doesn't borrow a neighbour's; only when no terminal has the focus
  // (a mod pane) does the tab's most recent agent stand in. `focused().agent` is the app-wide
  // "current agent" (the last one picked in the agents list or with agent.next), wherever it
  // is: it counts only when it's in this tab, or a plain shell in another space shows its repos.
  session() {
    const f = focused(), saved = shared(SESSIONS) ?? {};
    const inTab = agents().filter((a) => a.tab === f?.tab);
    const tab = f?.terminal ? [] : inTab.sort((a, b) => b.seq - a.seq).map((a) => a.address);
    const agent = !f?.terminal && inTab.some((a) => a.address === f?.agent) ? f.agent : null;
    for (const address of [f?.terminal, agent, ...tab]) if (address && saved[address]) return { address, ...saved[address] };
    return null;
  }

  key() {
    const s = this.mode === "session" ? this.session() : null;
    return JSON.stringify({ ...location(), mode: this.mode, session: s?.address ?? null, base: s?.tree ?? null });
  }

  saveSession(address, value) {
    const now = Date.now(), next = {};
    for (const [a, s] of Object.entries(shared(SESSIONS) ?? {})) if (s.live || now - (s.ended ?? s.at) < ENDED_KEEP) next[a] = s;
    if (value) next[address] = value; else delete next[address];
    setShared(SESSIONS, next);
  }

  // One snapshot at a time per repo: they share the scratch index (kept so later ones are quick).
  snapshot(root, on) {
    const k = `${on ?? ""}:${root}`;
    const job = (this.queue[k] ?? Promise.resolve()).catch(() => {}).then(async () => {
      const index = `/tmp/herdr-changes-${hash(k)}.index`;
      const git = (args, timeout) => exec("env", [`GIT_INDEX_FILE=${index}`, "git", ...READ, ...args], { cwd: root, on, timeout });
      if ((await exec("test", ["-e", index], { on })).code !== 0) {
        // Start from the repo's index: its file stats spare hashing every unchanged file.
        const own = await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: root, on });
        if (own.code === 0) await exec("cp", [own.stdout.trim(), index], { on });
      }
      const add = await git(["add", "-A"], 120000);
      if (add.code !== 0) throw new Error(add.stderr.trim());
      const tree = await git(["write-tree"]);
      if (tree.code !== 0) throw new Error(tree.stderr.trim());
      return tree.stdout.trim();
    });
    this.queue[k] = job;
    return job;
  }

  // After a commit: the session's snapshot with the committed files set to how they were
  // committed, so they leave its list while its other files stay.
  async advance(root, on, base, paths) {
    const index = `/tmp/herdr-changes-${hash(`${on ?? ""}:${root}`)}-base.index`;
    const git = (args) => exec("env", [`GIT_INDEX_FILE=${index}`, "git", ...READ, "--literal-pathspecs", ...args], { cwd: root, on, timeout: 120000 });
    let r;
    for (const args of [["read-tree", base], ["reset", "-q", "HEAD", "--", ...paths], ["write-tree"]]) {
      r = await git(args);
      if (r.code !== 0) throw new Error(r.stderr.trim());
    }
    return r.stdout.trim();
  }

  baseline(agent, cx, agentSession = null, agentPid = null) {
    const pane = panes().find((p) => p.pane === agent.pane);
    if (!pane?.cwd) return;
    const on = spaces().find((s) => s.id === agent.space)?.machine ?? null, address = agent.address;
    this.pending.add(address);
    cx.spawn(async (cx) => {
      let value;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd, on });
        const root = top.code === 0 ? top.stdout.trim() : null;
        const tree = root ? await this.snapshot(root, on) : null;
        const head = root ? await exec("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: root, on }) : null;
        value = { root, on, tree, head: head?.code === 0 ? head.stdout.trim() : null, paths: [], live: true, at: Date.now(), ...(agentSession ? { agentSession, agentPid } : {}) };
      } catch (e) { value = { root: null, on, tree: null, live: true, at: Date.now(), error: String(e), ...(agentSession ? { agentSession, agentPid } : {}) }; }
      finally { this.pending.delete(address); }
      this.saveSession(address, value);
      cx.notify();
    });
  }

  // Each agent's own session id, per terminal address ({} until first read; see AGENT_SESSIONS).
  loadAgentSessions(cx) {
    if (this.idsLoading) return;
    const ons = [...new Set(agents().map((a) => spaces().find((s) => s.id === a.space)?.machine ?? null))];
    this.idsLoading = true;
    cx.spawn(async () => {
      const ids = {};
      try {
        for (const on of ons) {
          let map = {};
          try { const r = await exec("python3", ["-c", AGENT_SESSIONS], { on, timeout: 10000 }); if (r.code === 0) map = JSON.parse(r.stdout || "{}"); } catch {}
          for (const [t, id] of Object.entries(map)) ids[on ? `${on}/${t}` : t] = id;
        }
        this.ids = ids;
      } finally { this.idsLoading = false; }
    });
  }

  // A Changes session lives as long as the agent's own session, for every agent CLI (see
  // AGENT_SESSIONS): the same session resumed (after a logout, an app restart, `--resume`,
  // even in another terminal) keeps it, and so does /clear in the same process; a fresh start
  // of the agent starts over.
  // Agents with no session file to read count their process as the session.
  // Ended sessions are kept a few days to review, and to pick up again if resumed.
  trackSessions(cx) {
    this.loadAgentSessions(cx);
    if (!this.ids || this.tracking) return;
    const live = agents(), saved = shared(SESSIONS) ?? {}, ids = this.ids, now = Date.now(), ops = [];
    for (const a of live) {
      if (this.pending.has(a.address)) continue;
      const s = saved[a.address], { id, pid } = ids[a.address] ?? {};
      if (id) {
        // Only its process this time, though the same process had a real session id: its
        // session file was being rewritten as it was read. Still the same session.
        if (id.startsWith("proc:") && s?.live && s.agentSession && !s.agentSession.startsWith("proc:") && s.agentPid === pid) continue;
        if (s?.agentSession === id) { if (!s.live) ops.push(["revive", a.address]); else if (!Array.isArray(s.paths)) ops.push(["fresh", a, id, null, pid]); continue; }
        // Recorded before its id was known (no id yet, or only its process while the agent
        // hadn't written its session file): it's this session.
        const provisional = !s?.agentSession || (s.agentSession.startsWith("proc:") && !id.startsWith("proc:") && s.agentPid === pid);
        if (s?.live && provisional && Array.isArray(s.paths)) { ops.push(["adopt", a.address, id, null, pid]); continue; }
        const from = id.startsWith("proc:") ? null
          : Object.keys(saved).find((k) => k !== a.address && saved[k].agentSession === id && sessionRoots(saved[k]).length && !(saved[k].live && ids[k]?.id === id));
        if (from) { ops.push(["claim", a, id, from]); continue; }
        // A new session id in the same process: /clear (or /compact, a new chat in the same
        // window). Still the same run of the agent, so the Changes session carries on under it.
        // Only a new process (quitting and starting the agent again) starts over.
        if (s?.live && Array.isArray(s.paths) && s.agentPid === pid && !id.startsWith("proc:")) { ops.push(["adopt", a.address, id, null, pid]); continue; }
        ops.push(["fresh", a, id, null, pid]);
        continue;
      }
      // A live session saved before files were credited per agent (no paths) starts over once.
      if (!s?.live || !Array.isArray(s.paths)) ops.push(["fresh", a, null]);
    }
    // While the app is still connecting (just started, after a login) the lists are empty or
    // partial, so an agent counts as gone only once it has been missing for a while.
    const ready = terminals().length > 0 && machines().every((m) => m.layout !== "loading");
    this.missing ??= {};
    for (const [k, s] of Object.entries(saved)) {
      if (!s.live || live.some((x) => x.address === k)) { delete this.missing[k]; continue; }
      if (!ready) continue;
      this.missing[k] ??= now;
      if (now - this.missing[k] >= 15000) { ops.push(["end", k]); delete this.missing[k]; }
    }
    if (!ops.length) return;
    this.tracking = true;
    for (const op of ops) if (op[0] === "fresh" || op[0] === "claim") this.pending.add(op[1].address);
    cx.spawn(async (cx) => {
      const next = { ...(shared(SESSIONS) ?? {}) }, fresh = [];
      // The session a terminal had before a new one replaced it: kept (ended) under its id.
      const archive = (k) => {
        const s = next[k];
        delete next[k];
        if (s?.agentSession && sessionRoots(s).length) next[`${k}~${s.agentSession}`] = { ...s, live: false, ended: s.ended ?? Date.now() };
      };
      for (const [kind, x, id, from, pid] of ops) {
        if (kind === "end") { if (next[x]?.live) next[x] = { ...next[x], live: false, ended: Date.now() }; }
        else if (kind === "revive") { if (next[x]) { const { ended: _e, ...rest } = next[x]; next[x] = { ...rest, live: true }; } }
        else if (kind === "adopt") { if (next[x]) next[x] = { ...next[x], agentSession: id, agentPid: pid }; }
        else if (kind === "claim" && next[from]) {
          const { ended: _e, ...rest } = next[from];
          archive(x.address); delete next[from];
          next[x.address] = { ...rest, live: true, paths: rest.paths ?? [] };
          this.pending.delete(x.address);
        } else { archive(x.address); fresh.push([x, id, pid]); }
      }
      setShared(SESSIONS, next);
      this.tracking = false;
      for (const [a, id, pid] of fresh) { this.pending.delete(a.address); this.baseline(a, cx, id, pid); }
      // With nothing awaited this ran inside render, where notify throws; setShared redraws anyway.
      try { cx.notify(); } catch {}
    });
  }

  // Which files each agent changed. Every few seconds, each repo with a tracked agent is
  // snapshotted; the files that changed since the last look go to the agents in it that were
  // working or blocked (now or at the last look). With none working they go to the repo's only
  // agent if it has just one, else to nobody: another agent's work, or your own edits, don't
  // show up in a session that didn't make them.
  //
  // A session isn't tied to one repo: an agent started in the frontend that edits the backend
  // too (or one started in a plain folder) gets a snapshot of each other repo the first time
  // its transcript shows an edit there (`extra`, per repo). Files its transcript says it edited
  // are its own wherever they are. In those other repos, files that change while it works go
  // to it only if it ran a command there at that time, so your own edits there stay out.
  attribute(cx) {
    // Also from here, not only render: a hidden panel keeps its timers but isn't drawn.
    this.trackSessions(cx);
    if (this.attributing) return;
    const saved = shared(SESSIONS) ?? {}, repos = new Map(), ids = this.ids ?? {}, credit = {}, discover = [];
    const give = (address, root, paths) => {
      const k = `${address}\n${root}`;
      credit[k] ??= new Set();
      for (const p of paths) credit[k].add(p);
    };
    for (const a of agents()) {
      const s = saved[a.address];
      if (!s?.live || !Array.isArray(s.paths)) continue;
      const busy = a.status === "working" || a.status === "blocked", mine = sessionRoots(s);
      for (const r of mine) {
        const k = `${s.on ?? ""}:${r.root}`;
        if (!repos.has(k)) repos.set(k, { root: r.root, on: s.on, agents: [] });
        repos.get(k).agents.push({ address: a.address, busy, primary: r.primary, touch: ids[a.address]?.touch?.[r.root] ?? 0 });
      }
      const { edits = {}, touch = {} } = ids[a.address] ?? {}, since = s.at ?? 0;
      for (const root of new Set([...Object.keys(edits), ...Object.keys(touch)])) {
        const paths = Object.entries(edits[root] ?? {}).filter(([, ts]) => ts >= since).map(([p]) => p);
        if (mine.some((r) => r.root === root)) { if (paths.length) give(a.address, root, paths); continue; }
        const k = `${a.address}\n${root}`;
        // A repo it only named in a command is tracked from then on, once it edits a file there
        // or works there (a command running in it).
        if ((paths.length || (touch[root] ?? 0) >= since && busy) && !this.discovering?.has(k)) discover.push({ address: a.address, root, on: s.on, paths });
      }
    }
    this.last ??= {};
    for (const k of Object.keys(this.last)) if (!repos.has(k)) delete this.last[k];
    if (!repos.size && !discover.length && !Object.keys(credit).length) return;
    this.attributing = true;
    this.discovering ??= new Set();
    for (const d of discover) this.discovering.add(`${d.address}\n${d.root}`);
    cx.spawn(async (cx) => {
      const added = {};
      try {
        // A new repo for a session: snapshot it now, with the files already edited there set
        // back to HEAD so their edits show (the snapshot comes a moment after the edit).
        for (const d of discover) {
          try {
            let tree = await this.snapshot(d.root, d.on);
            if (d.paths.length) tree = await this.advance(d.root, d.on, tree, d.paths).catch(() => tree);
            const head = await exec("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: d.root, on: d.on });
            added[`${d.address}\n${d.root}`] = { tree, head: head.code === 0 ? head.stdout.trim() : null, paths: d.paths, at: Date.now() };
          } catch {}
        }
        for (const [k, repo] of repos) {
          const prev = this.last[k];
          const now = await this.snapshot(repo.root, repo.on).catch(() => null);
          if (!now) continue;
          const busy = new Set(repo.agents.filter((a) => a.busy).map((a) => a.address));
          this.last[k] = { tree: now, busy, at: Date.now() };
          if (!prev || prev.tree === now) continue;
          const r = await exec("git", [...READ, "diff", "--name-only", "-z", "--no-renames", prev.tree, now], { cwd: repo.root, on: repo.on });
          const paths = r.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
          if (!paths.length) continue;
          // Its own repo: anything while it works. Another repo: only while it ran a command there.
          const working = (a) => (busy.has(a.address) || prev.busy.has(a.address)) && (a.primary || a.touch >= prev.at - 3000);
          let to = repo.agents.filter(working).map((a) => a.address);
          const own = repo.agents.filter((a) => a.primary);
          if (!to.length && repo.agents.length === 1 && own.length === 1) to = [own[0].address];
          for (const a of to) give(a, repo.root, paths);
        }
        if (Object.keys(credit).length || Object.keys(added).length) {
          const next = { ...(shared(SESSIONS) ?? {}) };
          let changed = false;
          for (const [k, x] of Object.entries(added)) {
            const [a, root] = k.split("\n"), s = next[a];
            if (!s?.live || sessionRoots(s).some((r) => r.root === root)) continue;
            next[a] = { ...s, extra: { ...(s.extra ?? {}), [root]: x } };
            changed = true;
          }
          for (const [k, paths] of Object.entries(credit)) {
            const [a, root] = k.split("\n"), s = next[a];
            if (!s?.live || !Array.isArray(s.paths)) continue;
            const primary = s.root === root && s.tree, x = primary ? s : s.extra?.[root];
            if (!x) continue;
            const had = new Set(x.paths ?? []), size = had.size;
            for (const p of paths) had.add(p);
            if (had.size === size) continue;
            next[a] = primary ? { ...s, paths: [...had] } : { ...s, extra: { ...s.extra, [root]: { ...x, paths: [...had] } } };
            changed = true;
          }
          if (changed) setShared(SESSIONS, next); else { for (const k of Object.keys(credit)) delete credit[k]; }
        }
      } finally {
        this.attributing = false;
        for (const d of discover) this.discovering.delete(`${d.address}\n${d.root}`);
      }
      if (Object.keys(credit).length || Object.keys(added).length) { this.refresh(cx); cx.notify(); }
    });
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    try { localStorage.setItem("mode", mode); } catch {}
    this.refresh(cx);
    cx.notify();
  }

  toggleTree(cx) {
    this.tree = !this.tree;
    try { localStorage.setItem("view", this.tree ? "tree" : "list"); } catch {}
    cx.notify();
  }

  toggle(set, key, cx) {
    if (set.has(key)) set.delete(key); else set.add(key);
    cx.notify();
  }

  // Starts the focused session over from the working tree as it is now.
  restart(cx) {
    const s = this.session();
    if (!s || !sessionRoots(s).length || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        // Its other repos are dropped: edits from now on bring them back.
        let value = { ...record(s), paths: [], extra: {}, at: Date.now(), error: undefined };
        if (s.root && s.tree) {
          const tree = await this.snapshot(s.root, s.on);
          const head = await exec("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: s.root, on: s.on });
          value = { ...value, tree, head: head.code === 0 ? head.stdout.trim() : null };
        }
        this.saveSession(s.address, value);
      }
      catch (e) { this.note = `Could not snapshot: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
  }

  // Every repo shown is watched (here only; remote ones refresh on the timer).
  watch(roots, on, cx) {
    if (on) return;
    const gen = this.watchGen;
    for (const root of roots) {
      if (this.watched.has(root)) continue;
      this.watched.add(root);
      cx.spawn(async (cx) => {
        try {
          while (this.watchGen === gen) {
            await watchFolder(root);
            if (this.watchGen === gen) this.refresh(cx);
          }
        } catch { if (this.watchGen === gen) this.watched.delete(root); }
      });
    }
  }

  // The repo Commit, Generate, search and the graph act on: the one picked (a click on its
  // header, a file, or staging in it), else the first.
  repo() { return this.repos.find((r) => r.root === this.active) ?? this.repos[0] ?? null; }
  get root() { return this.repo()?.root ?? null; }
  get hasHead() { return this.repo()?.hasHead ?? false; }
  setActive(root, cx) { if (this.active !== root) { this.active = root; cx?.notify(); } }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = this.key();
    if (context !== this.context) {
      this.context = context; this.repos = []; this.groups = []; this.open = null; this.watched = new Set(); this.watchGen = (this.watchGen ?? 0) + 1;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.closed = false; this.limited = false; this.confirming = null;
    }
    const session = this.session();
    if (!cwd && !session) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = cwd ? await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }) : null;
        if (this.key() !== context) return;
        const here = top?.code === 0 ? top.stdout.trim() : null, mine = session ? sessionRoots(session) : [];
        let list = [], error = null;
        if (this.mode === "session") {
          if (!session) error = "No agent session in this tab";
          else if (session.error) error = `Session snapshot failed: ${session.error}`;
          else if (!mine.length) error = "This session hasn't changed a git repository yet";
          else list = mine;
        } else {
          // All: every change in this folder's repo, and in the other repos this tab's agent works in.
          list = [...new Set([here, ...mine.map((r) => r.root)].filter(Boolean))].map((root) => ({ root }));
          if (!list.length) error = "Not a git repository";
        }
        // The repo of the focused folder first, then the rest by name.
        list.sort((a, b) => (b.root === here) - (a.root === here) || (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.root.split("/").pop().localeCompare(b.root.split("/").pop()));
        let repos = [];
        for (const r of list) {
          try { repos.push(await this.scan(r.root, session?.on ?? on, this.mode === "session" ? r : null, session)); }
          catch (e) {
            // A repo folder that's gone (a removed worktree, a deleted scratch repo) just drops out.
            if ((await exec("test", ["-d", r.root], { on: session?.on ?? on }).catch(() => ({ code: 0 }))).code !== 0) continue;
            repos.push({ root: r.root, on: session?.on ?? on, name: r.root.split("/").pop(), groups: [], error: String(e?.message ?? e) }); }
          if (this.key() !== context) return;
        }
        // Session: a repo where this session did nothing (no change, nothing staged or committed
        // by it) is left out; what's staged there by someone else isn't this session's work.
        // With none left, the first stays, so the panel keeps its repo and says nothing changed.
        const scanned = repos;
        if (this.mode === "session") {
          const worked = repos.filter((r) => r.error || r.groups.some((g) => g.kind !== "outside" && g.items.length));
          repos = worked.length ? worked : repos.slice(0, 1);
        }
        this.repos = repos; this.groups = repos.flatMap((r) => r.groups); this.error = error;
        this.limited = repos.some((r) => r.limited);
        if (this.active && !repos.some((r) => r.root === this.active)) this.active = null;
        // With nothing picked, Commit goes where something is staged.
        if (!this.active) this.active = (repos.find((r) => r.groups.some((g) => (g.kind === "staged" || g.kind === "outside") && g.items.length)) ?? repos[0])?.root ?? null;
        // Hidden repos are still watched, so one shows up as soon as the session changes it.
        this.watch(scanned.map((r) => r.root), session?.on ?? on, cx);
        if (this.open && !this.item(this.open).item) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        const first = this.groups.find((g) => g.items.length);
        if (!this.open && !this.closed && first && this.preview) this.open = `${first.id}|${first.items[0].path}`;
        if (!first) this.setLines([]);
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // One repo's groups. s: the session's snapshot of it (Session mode), else everything.
  async scan(root, on, s, session) {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const hasHead = (await git(["rev-parse", "-q", "--verify", "HEAD"])).code === 0;
        let { staged, changes } = parseStatus(status.stdout), outside = [], committed = [], trees = null;
        if (s) {
          {
            const now = await this.snapshot(root, on);
            const names = await git(["diff", "--name-status", "-z", "--no-renames", s.tree, now]);
            const nums = await git(["diff", "--numstat", "-z", "--no-renames", s.tree, now]);
            for (const r of [names, nums]) if (r.code !== 0) throw new Error(r.stderr);
            const stats = parseNumstat(nums.stdout), mine = new Map(), parts = names.stdout.split("\0");
            // Only the files this agent touched (see attribute); sessions saved before that was
            // tracked have no list and keep every change since their snapshot.
            const touched = Array.isArray(s.paths) ? new Set(s.paths) : null;
            for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] && parts[i + 1] && (!touched || touched.has(parts[i + 1]))) mine.set(parts[i + 1], LETTER[parts[i][0]] ?? "M");
            const listed = new Set([...staged, ...changes].map((f) => f.path));
            // Committed: a session file git no longer lists that a commit since the snapshot changed.
            // One that is clean only because it was reverted (to HEAD, past an edit that predates
            // the session) wasn't committed by anyone.
            let since = null;
            if (s.head && hasHead) {
              const r = await git(["diff", "--name-only", "-z", "--no-renames", s.head, "HEAD"]);
              if (r.code === 0) since = new Set(r.stdout.split("\0").filter(Boolean));
            }
            for (const path of [...mine.keys()]) if (!listed.has(path) && since && !since.has(path)) mine.delete(path);
            // Staged files that aren't the session's would go into the commit too: shown apart.
            outside = staged.filter((f) => !mine.has(f.path));
            staged = staged.filter((f) => mine.has(f.path));
            changes = changes.filter((f) => mine.has(f.path));
            committed = [...mine].filter(([path]) => !listed.has(path)).map(([path, status]) => ({ path, status }));
            for (const f of [...staged, ...changes, ...committed]) Object.assign(f, stats[f.path] ?? { add: 0, del: 0 });
            trees = { base: s.tree, now };
          }
        } else {
          const cached = await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), work = await git(["diff", "--numstat", "-z", "--no-renames"]);
          const cs = parseNumstat(cached.stdout), ws = parseNumstat(work.stdout);
          for (const f of staged) Object.assign(f, cs[f.path] ?? { add: 0, del: 0 });
          for (const f of changes) Object.assign(f, ws[f.path] ?? { add: 0, del: 0 });
        }
        // A staged file whose working copy is back to HEAD was reverted after staging: the
        // commit would still put the staged version back in. Marked, and Commit refuses it.
        if (hasHead && (staged.length || outside.length)) {
          const r = await git(["diff", "--name-only", "-z", "--no-renames", "HEAD"]);
          if (r.code === 0) {
            const differs = new Set(r.stdout.split("\0").filter(Boolean));
            for (const f of [...staged, ...outside]) f.reverted = !differs.has(f.path);
          }
        }
        const cap = (items) => items.slice(0, 1000);
        const limited = [staged, outside, changes, committed].some((items) => items.length > 1000);
        const repo = { root, on, hasHead, trees, limited, session: s ? session : null, primary: Boolean(s?.primary), name: root.split("/").pop() };
        // A group's id carries its repo: the same file can be listed in two repos' groups.
        repo.groups = [["staged", staged], ["outside", outside], ["changes", changes], ["committed", committed]]
          .filter(([kind, items]) => items.length || kind === "changes").map(([kind, items]) => ({ id: `${root}#${kind}`, kind, repo, items: cap(items) }));
        if (hasHead) {
          const b = await git(["branch", "--show-current"]);
          repo.branch = b.code === 0 ? b.stdout.trim() : "";
        }
        return repo;
  }

  // Session: the session's own diff. Staged: index vs HEAD. Changes: work tree vs index.
  async load(key, context) {
    const { group, path, item, repo } = this.item(key);
    if (!item) return;
    const root = repo.root, on = repo.on;
    const lang = langOf(path);
    const diff = async (args) => {
      const r = await exec("git", [...READ, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", ...args, "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      return first < 0 ? [item.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    };
    let lines;
    // Staged files show what the commit would hold (HEAD → index), in Session mode too.
    if (repo.trees && group !== "outside" && group !== "staged") lines = await diff([repo.trees.base, repo.trees.now]);
    else if (group === "staged" || group === "outside") lines = await diff(["--cached"]);
    else if (item.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        item.add = countLines(text);
        lines = [`@@ -0,0 +1,${item.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else lines = await diff([]);
    if (this.key() === context && this.open === key) this.lang = lang;
    if (this.key() === context && this.open === key) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    // Indent guides every 2 columns when the code indents by 2, else every 4. Odd indents
    // (a JSDoc " * " line, a continuation) say nothing about the step.
    const leads = this.rows.filter((r) => r.kind && r.kind !== "@" && r.text.trim()).map((r) => /^ */.exec(r.text)[0].length).filter((n) => n >= 2 && n % 2 === 0);
    this.indent = leads.some((n) => n % 4 === 2) ? 2 : 4;
    this.longest = Math.max(0, ...this.rows.map(row => row.text.length + 1));
  }

  endResize(cx) {
    if (!this.resizing) return;
    this.resizing = null;
    try { localStorage.setItem("listHeight", String(this.listH ?? 0)); } catch {}
    cx.notify();
  }

  setPreview(on, cx) {
    this.preview = on;
    try { localStorage.setItem("preview", on ? "on" : "off"); } catch {}
    if (!on) { this.open = null; this.setLines([]); this.closed = true; }
    else { this.closed = false; this.refresh(cx); }
    cx.notify();
  }

  pick(key, cx) {
    const { repo } = this.item(key);
    if (repo) this.setActive(repo.root);
    if (!this.preview) { this.compare(key, cx); return; }
    this.open = this.open === key ? null : key; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(key, context); }
      catch (e) { if (this.key() === context && this.open === key) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // What a file is compared against in the side-by-side view (mods/diff-view): the same two
  // states this panel's own diff shows.
  sides(group, f, repo) {
    if (repo.trees && group !== "outside" && group !== "staged") {
      const s = repo.session, x = s && s.root !== repo.root ? s.extra?.[repo.root] : s, at = x?.at ? new Date(x.at) : null;
      const since = at ? ` ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}` : "";
      return { left: repo.trees.base, right: "worktree", leftLabel: `Session start${since}`, rightLabel: "Working tree" };
    }
    if (group === "staged" || group === "outside") return { left: repo.hasHead ? "HEAD" : "none", right: "index", leftLabel: "HEAD", rightLabel: "Staged" };
    return { left: f.fresh ? "none" : "index", right: "worktree", leftLabel: f.fresh ? "New file" : "Index", rightLabel: "Working tree" };
  }

  // Opens the file big, old and new side by side, with every listed file of its repo a step away.
  // edit: opens it straight in the compare's editor.
  compare(key, cx, edit = false) {
    const { repo } = this.item(key);
    if (!repo) return;
    const files = [];
    for (const g of repo.groups) for (const f of g.items) files.push({ key: `${g.id}|${f.path}`, path: f.path, status: f.status, ...this.sides(g.kind, f, repo) });
    const index = files.findIndex((f) => f.key === key);
    if (index < 0) return;
    openOverlay({ mod: "diff-view", kind: "dialog", width: 0.94, height: 0.92, props: { root: repo.root, on: repo.on, files, index, edit } });
  }

  // The compare can edit a file's working-tree copy on this computer (writeTextFile is local only).
  canEdit(key) {
    const { group, item, repo } = this.item(key);
    return Boolean(item && repo && !repo.on && this.sides(group, item, repo).right === "worktree");
  }

  // Stage and unstage change the repo's index, as `git add` / `git restore --staged` would.
  // Acting in a repo makes it the one Commit goes to.
  gitAction(repo, args, cx) {
    if (!repo || this.busy) return;
    const root = repo.root, on = repo.on;
    this.setActive(root);
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
        if (r.code !== 0) throw gitError(r, `git ${args.join(" ")}`);
      } catch (e) { this.fail(args[0] === "add" ? "Stage failed" : "Unstage failed", e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }
  stage(repo, paths, cx) { if (paths.length) this.gitAction(repo, ["add", "-A", "--", ...paths], cx); }
  unstage(repo, paths, cx) {
    if (paths.length) this.gitAction(repo, repo.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths], cx);
  }

  // Discard, as VS Code's ↺ on Changes: the working copy goes back to the index (to HEAD if
  // nothing is staged), and new untracked files are deleted. Asks first: it can't be undone.
  discard(repo, paths, label, cx) {
    const items = this.group("changes", repo).filter((f) => paths.includes(f.path));
    if (!items.length || !repo || this.busy) return;
    this.confirming = { items, label: this.repos.length > 1 ? `${label} (${repo.name})` : label, repo }; this.note = null;
    cx.notify();
  }
  discardNow(cx) {
    const ask = this.confirming;
    this.confirming = null;
    if (!ask || !ask.repo || this.busy) { cx.notify(); return; }
    const root = ask.repo.root, on = ask.repo.on;
    const conflicts = ask.items.filter((f) => f.status === "C").map((f) => f.path);
    const fresh = ask.items.filter((f) => f.fresh).map((f) => f.path);
    const tracked = ask.items.filter((f) => !f.fresh && f.status !== "C").map((f) => f.path);
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const git = async (args) => {
          const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
          if (r.code !== 0) throw gitError(r, `git ${args.slice(0, 2).join(" ")} …`);
        };
        if (tracked.length) await git(["restore", "--worktree", "--", ...tracked]);
        if (fresh.length) await git(["clean", "-f", "-q", "--", ...fresh]);
        const done = tracked.length + fresh.length;
        if (conflicts.length) {
          this.note = `Not discarded (merge conflict, resolve first): ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? ` +${conflicts.length - 3}` : ""}`;
          notify({ title: "Some files were not discarded", body: `${conflicts.length} file${conflicts.length === 1 ? " has" : "s have"} a merge conflict: resolve first`, level: "warning" });
        } else if (done) notify({ title: "Changes discarded", body: `${done} file${done === 1 ? "" : "s"}`, level: "success" });
      } catch (e) { this.fail("Discard failed", e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Commits what's staged, like `git commit`. In Session mode the session's committed files
  // then leave its list.
  // From the ⋯ menu also: all (stage this list's Changes first), smart (all when nothing is
  // staged), amend (an empty message keeps the last one), signoff.
  commit(cx, opts = {}) {
    const repo = this.repo();
    const amend = Boolean(opts.amend);
    if (!repo || this.busy || this.loading || this.generating || this.context !== this.key()) return;
    if (!this.message.trim() && !amend) { if (opts.menu) this.warn("Can't commit", "Type a commit message first", cx); return; }
    const staged = this.group("staged", repo), outside = this.group("outside", repo);
    const all = Boolean(opts.all || (opts.smart && !staged.length && !outside.length));
    const extra = all ? this.group("changes", repo).filter((f) => f.status !== "C") : [];
    if (!staged.length && !outside.length && !extra.length && !amend) { this.warn("Can't commit", all ? "No changes to commit" : "Nothing is staged: stage files with + first", cx); return; }
    const reverted = [...staged, ...outside].filter((f) => f.reverted).map((f) => f.path);
    if (reverted.length) {
      this.warn("Can't commit", `Reverted but still staged: ${reverted.slice(0, 3).join(", ")}${reverted.length > 3 ? ` +${reverted.length - 3}` : ""}. Unstage (−) to drop the change, or stage (+) again to commit it.`, cx);
      return;
    }
    const root = repo.root, on = repo.on, context = this.context, message = this.message.trim();
    const session = repo.trees ? repo.session : null, paths = [...staged, ...extra].map((f) => f.path);
    this.busy = true; this.note = null; this.opLabel = amend ? "Amending" : "Committing";
    cx.spawn(async (cx) => {
      try {
        if (extra.length) {
          const a = await exec("git", ["--literal-pathspecs", "add", "-A", "--", ...extra.map((f) => f.path)], { cwd: root, on });
          if (a.code !== 0) throw gitError(a, "git add");
        }
        const args = ["commit", ...(message ? ["-m", message] : ["--no-edit"]), ...(amend ? ["--amend"] : []), ...(opts.signoff ? ["--signoff"] : [])];
        const r = await exec("env", [...QUIET, "git", ...args], { cwd: root, on });
        if (r.code !== 0) throw gitError(r, `git commit${amend ? " --amend" : ""}${opts.signoff ? " --signoff" : ""}`);
        this.ok(amend ? "Commit amended" : "Committed", tail(r.stdout, 1) || message, cx);
        this.message = ""; this.input.set_value("");
        if (session && paths.length) {
          const tree = await this.advance(root, on, repo.trees.base, paths);
          const now = (shared(SESSIONS) ?? {})[session.address] ?? record(session);
          this.saveSession(session.address, withRoot(now, root, { tree }));
        }
      } catch (e) { this.fail(amend ? "Amend failed" : "Commit failed", e, this.key() === context); }
      finally { this.busy = false; this.opLabel = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // A short green line under the buttons for what the ⋯ menu did; it goes after a while.
  done(text, cx) {
    const seq = ++this.doneSeq;
    this.doneNote = text || "Done";
    cx.timer.after(6000, (cx) => { if (seq === this.doneSeq) { this.doneNote = null; cx.notify(); } });
  }

  // Success: the green line plus a toast, so it's seen even with the panel hidden.
  ok(title, body, cx) {
    this.done(body ? `${title}: ${body}` : title, cx);
    notify({ title, body: body || "", level: "success" });
  }

  // Couldn't start (nothing staged, busy...): the red note plus a warning toast.
  warn(title, text, cx) {
    this.note = text;
    notify({ title, body: text, level: "warning" });
    cx?.notify();
  }

  // Failure: the short red note in the panel, and a dialog with everything git printed and
  // what to do next. `show` false (the panel moved to another repo meanwhile) skips the note.
  fail(title, e, show = true) {
    const message = String(e?.message ?? e);
    if (show) this.note = `${title}: ${message}`;
    const detail = e?.detail ?? message;
    openOverlay({
      mod: "git-result", kind: "dialog", width: 620, height: 420,
      props: { title, command: e?.command ?? null, hint: gitHint(detail), detail },
    });
  }

  // The ⋯ menu's work (mods/git-menu): git commands, or what the panel's own buttons do.
  menuOp(op, cx) {
    if (op.kind === "view") { if (this.tree !== op.tree) this.toggleTree(cx); return; }
    if (op.kind === "sort") { this.sort = op.sort; try { localStorage.setItem("sort", op.sort); } catch {} if (this.tree) this.toggleTree(cx); cx.notify(); return; }
    if (op.kind === "mode") { this.setMode(op.mode, cx); return; }
    if (op.kind === "preview") { this.setPreview(op.on, cx); return; }
    // The rest act on the repo the menu was opened for.
    const repo = this.repos.find((r) => r.root === op.root) ?? this.repo();
    if (repo && repo.root !== this.root) this.setActive(repo.root, cx);
    if (op.kind === "commit") { this.commit(cx, { ...op, menu: true }); return; }
    if (op.kind === "stage-all" || op.kind === "discard-all") {
      const items = this.group("changes", repo).filter((f) => (op.tracked ? !f.fresh : op.untracked ? f.fresh : true));
      if (!items.length) { this.warn(op.kind === "stage-all" ? "Nothing to stage" : "Nothing to discard", "No changes", cx); return; }
      const paths = items.map((f) => f.path);
      if (op.kind === "stage-all") this.stage(repo, paths, cx);
      else this.discard(repo, paths, op.tracked ? "all tracked files" : op.untracked ? "all untracked files" : `all ${paths.length} file${paths.length === 1 ? "" : "s"}`, cx);
      return;
    }
    if (op.kind === "unstage-all") {
      const paths = [...this.group("staged", repo), ...this.group("outside", repo)].map((f) => f.path);
      if (!paths.length) { this.warn("Nothing to unstage", "Nothing is staged", cx); return; }
      this.unstage(repo, paths, cx);
      return;
    }
    const root = op.root ?? repo?.root, on = op.on ?? repo?.on ?? null;
    const label = op.label ?? "Git";
    if (!root) { this.warn(`${label} didn't run`, "Not a git repository", cx); return; }
    if (this.busy) { this.warn(`${label} didn't run`, `${this.opLabel ?? "Another git action"} is still running: try again in a moment`, cx); return; }
    this.busy = true; this.note = null; this.doneNote = null; this.opLabel = label;
    cx.spawn(async (cx) => {
      const opts = { cwd: root, on, timeout: 300000 };
      try {
        let out = "";
        if (op.kind === "git") {
          for (const args of op.steps) {
            const r = await exec("env", [...QUIET, "git", ...args], opts);
            if (r.code !== 0) throw gitError(r, `git ${args.join(" ")}`);
            out = `${r.stdout}\n${r.stderr}`;
          }
        } else if (op.kind === "sh") {
          const r = await exec("env", [...QUIET, "sh", "-c", op.script, "sh", ...(op.args ?? [])], opts);
          if (r.code !== 0) throw gitError(r, label.toLowerCase() === "push" ? "git push" : label.toLowerCase() === "sync" ? "git pull && git push" : label);
          out = `${r.stdout}\n${r.stderr}`;
        } else if (op.kind === "undo") {
          // As VS Code: the commit goes, its changes stay staged and its message comes back.
          const msg = await exec("git", ["log", "-1", "--format=%B"], opts);
          if (msg.code !== 0) throw gitError(msg, "git log -1", "There is no commit to undo");
          const parent = await exec("git", ["rev-parse", "-q", "--verify", "HEAD~1"], opts);
          const r = parent.code === 0 ? await exec("git", ["reset", "--soft", "HEAD~1"], opts) : await exec("git", ["update-ref", "-d", "HEAD"], opts);
          if (r.code !== 0) throw gitError(r, "git reset --soft HEAD~1");
          const text = msg.stdout.trim();
          if (text && !this.message.trim()) { this.message = text.split("\n")[0]; this.input.set_value(this.message); }
          out = "Last commit undone: its changes are staged";
        } else if (op.kind === "clone") {
          // Here: a folder picked for it; on another machine: next to this repo.
          const into = on ? root.replace(/\/[^/]+\/?$/, "") || "/" : await pickFolder({ prompt: "Clone into" });
          if (!into) { notify({ title: "Clone cancelled", body: "", level: "info" }); return; }
          const name = op.url.replace(/[/:]+$/, "").split(/[/:]/).pop().replace(/\.git$/, "") || "repo";
          this.opLabel = `Cloning ${name}`; cx.notify();
          const r = await exec("env", [...QUIET, "git", "clone", "--", op.url, name], { cwd: into, on, timeout: 600000 });
          if (r.code !== 0) throw gitError(r, `git clone ${op.url}`);
          run("space.new", { folder: `${into.replace(/\/$/, "")}/${name}`, machine: on ?? "" });
          out = `Cloned into ${tilde(`${into.replace(/\/$/, "")}/${name}`)}`;
        }
        if (op.kind === "git" || op.kind === "sh") this.ok(`${label} succeeded`, summary(out), cx);
        else this.ok(label === "Git" ? "Done" : `${label} done`, out, cx);
      } catch (e) {
        // exec itself rejects on a timeout or an unreachable machine: no git output then.
        this.fail(`${label} failed`, e);
      }
      finally { this.busy = false; this.opLabel = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  generate(cx) {
    const repo = this.repo();
    if (!repo || this.generating || this.busy || this.loading) return;
    const staged = this.group("staged").length + this.group("outside").length;
    if (!staged && !this.group("changes").length) return;
    const context = this.context, root = repo.root, on = repo.on;
    const args = staged ? ["cached", "", ""] : repo.trees ? ["range", repo.trees.base, repo.trees.now] : ["all", "", ""];
    // genSeq: Cancel (or a newer run) makes this one's answer stale; exec can't be killed,
    // so the program finishes in the background and its answer is dropped.
    const seq = ++this.genSeq;
    this.generating = true; this.genDone = false; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", GENERATE, "sh", root, ...args], { cwd: root, on, timeout: 120000 });
        if (seq !== this.genSeq) return;
        const line = r.stdout.split("\n").map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, "").trim()).filter(Boolean).pop();
        if (r.code !== 0 || !line) throw new Error(r.stderr.trim().split("\n").filter(Boolean).pop() || `exit code ${r.code}`);
        if (this.key() === context) {
          this.message = line; this.input.set_value(line); this.input.focus();
          // A short green border says the message is in.
          this.genDone = true;
          cx.timer.after(1500, (cx) => { if (seq === this.genSeq) { this.genDone = false; cx.notify(); } });
        }
      } catch (e) { if (seq === this.genSeq && this.key() === context) this.note = `Could not write a message: ${e?.message ?? e}`; }
      finally { if (seq === this.genSeq) { this.generating = false; cx.notify(); } }
    });
    cx.notify();
  }

  cancelGenerate(cx) {
    if (!this.generating) return;
    this.genSeq++; this.generating = false; this.genDone = false;
    cx.notify();
  }

  // The message box while Generate runs: spinner, animated text, a cancel ×,
  // and a bar sliding along the bottom edge. All native animation, no timers.
  generatingBox(t) {
    const w = this.msgW || 240, bar = Math.max(40, Math.round(w * 0.3));
    return h_flex().id("commit-message").mx(10).mt(4).h(32).flex_none().pl(10).pr(4).gap(8).items_center().rounded(6)
      .relative().overflow_hidden().border_1().border_color(t.accent).bg(t.accent + "14")
      .on_size_change((s, cx) => { if (Math.round(s.width) !== this.msgW) { this.msgW = Math.round(s.width); cx.notify(); } })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.accent).spin(900))
      .child(h_flex().flex_1().min_w(0).items_center().text_size(12).text_color(t.muted)
        .child(div().truncate().child("Writing commit message"))
        .child(div().w(16).flex_none().frames(["", ".", "..", "..."], 380).child("")))
      .child(div().id("generate-cancel").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.cancelGenerate(cx)).tooltip("Cancel")
        .child(svg("mods/workspace-chrome/x.svg").size(14)))
      .child(div().absolute().bottom(0).left(0).h(2).w(bar).rounded(1).bg(t.accent)
        .loop("left", { from: -bar, to: w, period: 1400 }));
  }

  // Right-click on a file or folder: reveal it, open it, copy its path (mods/file-menu).
  fileMenu(el, g, rel, dir = false) {
    const root = g.repo?.root;
    if (!root) return el;
    return el.on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({ mod: "file-menu", kind: "popup", at: "pointer", width: 240, height: 220, props: { path: `${root}/${rel}`, root, on: g.repo.on ?? null, dir } });
    });
  }

  // Rows show their buttons while the pointer is on them, as editors do.
  hoverable(el, id) {
    return el.on_hover((hovered, cx) => {
      if (hovered) this.hovered = id; else if (this.hovered === id) this.hovered = null;
      cx.notify();
    });
  }

  iconButton(id, name, click, t) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => click(cx)).child(icon(name, 16));
  }

  pill(id, label, on, click, t) {
    return div().id(id).px(7).h(20).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => click(cx)).child(label);
  }

  // The buttons a row offers: discard (↺) and stage (+) what isn't staged, unstage (−) what is.
  rowAction(g, id, paths, t, label) {
    if (g.kind === "changes") return h_flex().flex_none().gap(2).items_center()
      .child(this.iconButton(`discard-${id}`, "discard", (cx) => this.discard(g.repo, paths, label, cx), t).tooltip("Discard changes"))
      .child(this.iconButton(`stage-${id}`, "add", (cx) => this.stage(g.repo, paths, cx), t).tooltip("Stage changes"));
    if (g.kind === "staged" || g.kind === "outside") return this.iconButton(`unstage-${id}`, "remove", (cx) => this.unstage(g.repo, paths, cx), t);
    return null;
  }

  // Committed starts folded; a click flips a group from its default.
  groupFolded(g) { return this.folded.has(g.id) !== (g.kind === "committed"); }

  // With several repos, each gets a header: which repo (and where), its branch, how many
  // files. A click makes it the one Commit goes to; the chevron folds it.
  repoRow(repo, t) {
    const id = `repo-${repo.root}`, folded = this.foldedRepos.has(repo.root), active = repo.root === this.repo()?.root;
    const count = repo.groups.reduce((n, g) => n + (g.kind === "committed" ? 0 : g.items.length), 0);
    const staged = repo.groups.reduce((n, g) => n + (g.kind === "staged" || g.kind === "outside" ? g.items.length : 0), 0);
    return h_flex().id(id).h(40).flex_none().mt(4).pl(2).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
      .border_l(3).border_color(active ? t.accent : "#00000000").bg(active ? t.accent + "14" : t.background).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.setActive(repo.root); if (folded) this.foldedRepos.delete(repo.root); cx.notify(); })
      .child(div().id(`${id}-fold`).size(20).flex_none().flex().items_center().justify_center().rounded(4).hover((s) => s.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(this.foldedRepos, repo.root, cx); })
        .child(icon(folded ? "chevron-right" : "chevron-down", 16).text_color(t.muted)))
      .child(folderIcon(FT, !folded, repo.name))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(repo.name))
          .when(Boolean(repo.branch), (e) => e.child(div().flex_none().max_w(140).truncate().text_size(10.5).text_color(t.muted).child(`⎇ ${repo.branch}`))))
        .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(repo.error ? repo.error : tilde(repo.root))))
      .when(active, (e) => e.child(div().flex_none().px(6).h(16).flex().items_center().rounded(8).bg(t.accent + "33").text_size(10).text_color(t.accent).child("commit here")))
      .when(!active && staged > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`${staged} staged`)))
      .child(div().flex_none().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_color(t.muted).text_size(10).child(String(count)));
  }

  groupRow(g, t, nested) {
    const id = `group-${g.id}`, open = !this.groupFolded(g), action = this.hovered === id ? this.rowAction(g, id, g.items.map((f) => f.path), t, `all ${g.items.length} file${g.items.length === 1 ? "" : "s"}`) : null;
    return this.hoverable(h_flex().id(id).h(24).flex_none().pl(4 + (nested ? 14 : 0)).pr(4).gap(4).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.folded, g.id, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 16).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(g.kind === "outside" ? t.blocked : t.foreground).child(GROUP_TITLE[g.kind]))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_color(t.muted).text_size(10).child(String(g.items.length))), id);
  }

  dirRow(g, { dir, name, depth, paths }, t) {
    const id = `dir-${g.id}|${dir}`, key = `${g.id}:${dir}`, open = !this.collapsed.has(key);
    const action = this.hovered === id ? this.rowAction(g, id, paths, t, `${paths.length} file${paths.length === 1 ? "" : "s"} in ${dir}`) : null;
    return this.hoverable(this.fileMenu(h_flex().id(id), g, dir, true).h(24).flex_none().pl(20 + (this.nest ?? 0) + depth * 14).pr(4).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.collapsed, key, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 16).text_color(t.muted))
      .child(folderIcon(FT, open, name))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().size(6).mx(4).flex_none().rounded(3).bg(t.dim)), id);
  }

  fileRow(g, f, depth, t) {
    const key = `${g.id}|${f.path}`, parts = f.path.split("/"), name = parts.pop();
    const action = this.hovered === key ? this.rowAction(g, key, [f.path], t, f.fresh ? `${name} (new file, will be deleted)` : name) : null;
    const compare = this.hovered === key ? div().id(`compare-${key}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.compare(key, cx))
      .child(svg("mods/diff-view/split.svg").size(16)) : null;
    return this.hoverable(this.fileMenu(h_flex().id(key), g, f.path).h(24).flex_none().pl(20 + (this.nest ?? 0) + depth * 14).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .when(this.open === key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((e, cx) => { if (e.click_count === 2) this.compare(key, cx); else this.pick(key, cx); })
      // In the tree a file lines up under its folder's icon, past the chevron column.
      .when(this.tree, (e) => e.child(div().w(16).flex_none()))
      .child(typeIcon(FT, name, t))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).max_w(240).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(name))
        .when(Boolean(f.reverted), (e) => e.child(div().flex_none().text_size(11).text_color(t.blocked).child("reverted · still staged")))
        .when(!this.tree && parts.length > 0, (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))))
      .when(Boolean(compare), (e) => e.child(compare))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(t[LETTER_TINT[f.status]] ?? t.muted).child(f.status)), key);
  }

  // Added and removed lines: a solid edge, a tinted gutter and line, a +/− sign, and the
  // changed words inside the line on a stronger tint.
  // Code rows: indent guides, then syntax-colored tokens, with the changed words on a strong tint.
  codeTokens(row) {
    if (row.tokens) return row.tokens;
    const unit = this.indent ?? 4, lead = /^ */.exec(row.text)[0].length, levels = row.kind === "" ? 0 : Math.floor(lead / unit), off = levels * unit;
    const mark = row.mark && [Math.max(0, row.mark[0] - off), Math.max(0, row.mark[1] - off)];
    row.levels = levels;
    row.tokens = row.kind === "" ? [{ text: row.text }] : markTokens(tokenize(row.text.slice(off), this.lang ?? langOf("")), mark);
    return row.tokens;
  }

  // The compare view's terminal look (mods/diff-view): solid rows, GitHub's dark syntax colors.
  // A light appearance keeps the theme's colors.
  diffRow(row, t, size = diffSize()) {
    const { kind, number } = row, height = rowHeight(size);
    if (kind === "@") return div().w_full().px(12).h(height).flex_none().flex().items_center().truncate().bg(t.accent + "1f").text_color(t.accent).child(row.text);
    const v = settings().dark === false ? {
      syntax: { keyword: t.ansi12, control: t.ansi12, literal: t.ansi13, function: t.ansi11, type: t.ansi14, tag: t.ansi14, string: t.ansi3,
        number: t.ansi13, attr: t.ansi10, bracket: t.ansi13, comment: t.dim, punct: t.muted },
      text: t.foreground, add: t.ansi2 + "30", del: t.ansi1 + "30", addWord: t.ansi2 + "80", delWord: t.ansi1 + "80",
      addSign: t.ansi2, delSign: t.ansi1, number: t.dim, changedNumber: t.foreground, guide: t.border,
    } : VIVID;
    const bg = kind === "+" ? v.add : kind === "-" ? v.del : null, word = kind === "+" ? v.addWord : kind === "-" ? v.delWord : null;
    const tokens = this.codeTokens(row), unit = this.indent ?? 4;
    const body = h_flex().flex_1().min_w(0).overflow_hidden().h_full().items_center()
      .children(Array.from({ length: row.levels ?? 0 }, () => div().flex_none().h_full().flex().items_center().border_l(1).border_color(v.guide ?? t.border).child(" ".repeat(unit))))
      .children(tokens.map((tk) => {
        const k = tk.kind === "keyword" ? (CONTROL.has(tk.text) ? "control" : LITERAL.has(tk.text) ? "literal" : "keyword") : tk.kind;
        return div().flex_none().text_color(v.syntax[k] ?? v.text).when(k === "comment" || k === "attr", (e) => e.italic())
          .when(Boolean(tk.hl && word), (e) => e.bg(word)).child(tk.text);
      }));
    return h_flex().w_full().h(height).flex_none().items_center().when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(Math.max(40, Math.ceil(5 * charWidth(size)) + 4)).h_full().flex_none().pr(4).flex().items_center().justify_end().text_color(bg ? v.changedNumber : v.number)
        .child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_color(kind === "+" ? v.addSign : kind === "-" ? v.delSign : v.number).child(kind === "+" ? "+" : kind === "-" ? "-" : ""))
      .child(body);
  }

  // Search, like VS Code's: text in every file of the working tree, tracked or not, minus what
  // .gitignore leaves out (git grep: fast, skips binaries). Not only the changed files.
  setSearching(on, cx) {
    this.searching = on;
    if (on) { this.find.focus(); if (this.query.length >= 2) this.search(cx); }
    else this.handle.focus();
    cx.notify();
  }
  setFindOption(name, cx) {
    this[name] = !this[name];
    try { localStorage.setItem(name, this[name] ? "1" : "0"); } catch {}
    this.search(cx);
  }
  // The query as a JavaScript pattern, to mark the matches in the results; null if it isn't one.
  findPattern() {
    const q = this.found?.query ?? "";
    if (!q) return null;
    try { return new RegExp(this.found.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), this.found.matchCase ? "g" : "gi"); }
    catch { return null; }
  }
  search(cx) {
    const q = this.query, root = this.root, on = this.repo()?.on ?? null;
    if (!root || q.length < 2) {
      this.findRun++; this.found = null; this.finding = false;
      this.findNote = !root ? "Not a git repository" : q ? "Type at least 2 characters" : null;
      cx.notify(); return;
    }
    const seq = ++this.findRun, matchCase = this.findCase, regex = this.findRegex;
    this.finding = true; this.findNote = null;
    cx.spawn(async (cx) => {
      try {
        const args = [...READ, "grep", "-n", "-I", "-z", "--untracked", "--no-color", "--full-name", "--max-count", "200", regex ? "-E" : "-F"];
        if (!matchCase) args.push("-i");
        args.push("-e", q, "--", ".");
        const r = await exec("git", args, { cwd: root, on, timeout: 30000 });
        if (seq !== this.findRun) return;
        // 1: nothing found. More: a bad pattern or a git error.
        if (r.code > 1) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `git grep failed (${r.code})`);
        // -z: path \0 line \0 text, one match per line.
        const files = new Map();
        let count = 0, capped = false;
        for (const rec of r.stdout.split("\n")) {
          const a = rec.indexOf("\0"), b = a < 0 ? -1 : rec.indexOf("\0", a + 1);
          if (b < 0) continue;
          if (count >= 2000) { capped = true; break; }
          const path = rec.slice(0, a);
          if (!files.has(path)) files.set(path, []);
          files.get(path).push({ line: Number(rec.slice(a + 1, b)), text: untab(rec.slice(b + 1)).slice(0, 500) });
          count++;
        }
        this.found = { query: q, matchCase, regex, root, on, files: [...files].map(([path, hits]) => ({ path, hits })), count, capped };
        this.findAt = null;
      } catch (e) { if (seq === this.findRun) { this.found = null; this.findNote = String(e?.message ?? e); } }
      finally { if (seq === this.findRun) { this.finding = false; cx.notify(); } }
    });
    cx.notify();
  }
  // The results as the list draws them: a row per file, then its matches unless folded.
  // Kept until the results or the folding change: render asks on every redraw.
  findRows() {
    if (this.findDrawn?.found === this.found && this.findDrawn.ver === this.foldVer) return this.findDrawn.out;
    const out = [];
    for (const file of this.found?.files ?? []) {
      out.push({ file });
      if (!this.foundFolded.has(file.path)) for (const hit of file.hits) out.push({ file, hit });
    }
    this.findDrawn = { found: this.found, ver: this.foldVer, out };
    return out;
  }
  // Opens a match in the side-by-side view (mods/diff-view), on the whole file at that line;
  // every file found is a step away there ([ and ]).
  openFound(file, hit, cx) {
    const found = this.found;
    if (!found) return;
    this.findAt = `${file.path}:${hit.line}`;
    const files = found.files.map((f) => ({ key: `find|${f.path}`, path: f.path, status: "",
      left: this.hasHead ? "HEAD" : "none", right: "worktree", leftLabel: this.hasHead ? "HEAD" : "Empty", rightLabel: "Working tree",
      line: f === file ? hit.line : f.hits[0]?.line, find: found.query }));
    const index = found.files.indexOf(file);
    openOverlay({ mod: "diff-view", kind: "dialog", width: 0.94, height: 0.92, props: { root: found.root, on: found.on, files, index, edit: false } });
    cx.notify();
  }
  // A match's line, the matching parts marked.
  findText(text, t) {
    const re = this.findPattern(), body = text.trimStart(), parts = [];
    let last = 0;
    if (re) for (const m of body.matchAll(re)) {
      if (!m[0]) break;
      if (m.index > last) parts.push(div().flex_none().child(body.slice(last, m.index)));
      parts.push(div().flex_none().rounded(2).bg(t.ansi3 + "55").text_color(t.foreground).child(m[0]));
      last = m.index + m[0].length;
      if (parts.length > 40) break;
    }
    if (last < body.length) parts.push(div().flex_none().child(body.slice(last)));
    return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_color(t.muted).children(parts);
  }
  findRow(row, t) {
    if (!row.hit) {
      const parts = row.file.path.split("/"), name = parts.pop(), open = !this.foundFolded.has(row.file.path);
      return h_flex().w_full().h(22).flex_none().px(6).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .child(icon(open ? "chevron-down" : "chevron-right", 16).text_color(t.muted))
        .child(typeIcon(FT, name, t))
        .child(div().flex_none().max_w(220).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
        .child(div().flex_none().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(row.file.hits.length)));
    }
    const at = this.findAt === `${row.file.path}:${row.hit.line}`;
    return h_flex().w_full().h(22).flex_none().pl(30).pr(6).gap(8).items_center().rounded(5).cursor_pointer()
      .when(at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(row.hit.line)))
      .child(this.findText(row.hit.text, t));
  }
  searchBody(t) {
    const rows = this.findRows(), f = this.found;
    const summary = this.findNote ?? (this.finding && !f ? "Searching…" : f ? (f.count
      ? `${f.count}${f.capped ? "+" : ""} result${f.count === 1 ? "" : "s"} in ${f.files.length} file${f.files.length === 1 ? "" : "s"}${f.capped ? " · showing the first 2,000" : ""}`
      : "No results") : "Searches every file in the repo, changed or not (not what .gitignore hides)");
    const option = (id, label, on, tip) => div().id(id).w(26).h(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_size(11.5).font_semibold().tooltip(tip).bg(on ? t.accent + "33" : t.background).text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.setFindOption(id, cx)).child(label);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().id("find-box").mx(10).mt(4).h(32).flex_none().pl(8).pr(4).gap(4).items_center().rounded(6).border_1().border_color(t.accent).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.find.focus(); })
        .child(icon("search", 14).text_color(t.muted))
        .child(div().flex_1().min_w(0).h_full().flex().items_center().child(Input.new(this.find).h_full().text_size(12).text_color(t.foreground)))
        .child(option("findCase", "Aa", this.findCase, "Match case"))
        .child(option("findRegex", ".*", this.findRegex, "Regular expression")))
      .child(h_flex().px(14).pt(6).pb(4).gap(6).items_center().text_size(11).text_color(this.findNote && f === null && this.query.length >= 2 ? t.ansi1 : t.dim)
        .child(div().flex_1().min_w(0).truncate().child(summary))
        .when(Boolean(this.finding && f), (e) => e.child(div().flex_none().child("searching…"))))
      .child(div().flex_1().min_h(0).relative().border_t(1).border_color(t.border)
        .child(v_virtual_list("find-rows", rows.length, 22, (i) => String(i),
          (range) => rows.slice(range.start, range.end).map((row) => this.findRow(row, t))).size_full().p(6)
          // The list refuses per-row handlers: a row's click is the list's.
          .on_item_click((key, cx) => {
            const row = this.findRows()[Number(key)];
            if (!row) return;
            if (row.hit) this.openFound(row.file, row.hit, cx);
            else { if (this.foundFolded.has(row.file.path)) this.foundFolded.delete(row.file.path); else this.foundFolded.add(row.file.path); this.foldVer = (this.foldVer ?? 0) + 1; cx.notify(); }
          }))
        .child(Scrollbar.vertical("find-rows").viewport_from_layout().absolute().inset_0()));
  }

  render(cx) {
    this.trackSessions(cx);
    if (this.key() !== this.context) this.refresh(cx);
    const op = shared(GITOP);
    // Run after this render: cx.notify() isn't allowed while rendering (toggles call it).
    if (op?.seq && op.seq !== this.opSeq) { this.opSeq = op.seq; if (op.owner === this.uid) cx.spawn(async (cx) => this.menuOp(op, cx)); }
    const t = theme(), session = this.mode === "session" ? this.session() : null;
    // The runtime ignores toLocaleTimeString's options (it adds seconds): hours and minutes by hand.
    const at = session?.at ? new Date(session.at) : null;
    const since = at ? `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}` : null;
    const fpane = (() => { const f = focused(); return f?.pane ? panes().find((p) => p.pane === f.pane) : null; })();
    const prog = fpane?.program, active = this.repo(), many = this.repos.length > 1;
    const repo = many ? `${this.repos.length} repos` : active?.name;
    const tracked = session ? sessionRoots(session).length > 0 : false;
    const followIcon = prog?.icon ? (prog.tint ? svg(prog.icon).size(12).flex_none().text_color(t.muted) : image(prog.icon).size(12).flex_none()) : null;
    const following = repo ? [prog?.name || (fpane?.terminal ? "Terminal" : null), repo, tracked ? `since ${since}${session.live ? "" : " (ended)"}` : null].filter(Boolean).join(" · ") : null;
    const staged = this.group("staged").length + this.group("outside").length, total = this.groups.reduce((n, g) => n + g.items.length, 0);
    const stagedElsewhere = this.repos.filter((r) => r !== active).map((r) => [r, this.group("staged", r).length + this.group("outside", r).length]).filter(([, n]) => n);
    const canCommit = Boolean(this.message.trim() && staged && this.root && !this.busy && !this.loading && !this.generating);
    const rows = [];
    this.nest = many ? 14 : 0;
    for (const r of this.repos) {
      if (many) { rows.push({ repo: r }); if (this.foldedRepos.has(r.root)) continue; }
      for (const g of r.groups) {
        // A repo with nothing for this session shows just its header.
        if (many && !g.items.length) continue;
        rows.push({ group: g });
        if (this.groupFolded(g)) continue;
        const items = this.tree ? treeRows(buildTree(g.items), this.collapsed, g.id) : [...g.items].sort(SORTS[this.sort] ?? SORTS.path).map((file) => ({ file, depth: 0 }));
        for (const row of items) rows.push({ ...row, in: g });
      }
    }
    const empty = this.error || (this.loading ? "Loading changes…" : !this.root ? "No folder" : this.mode === "session" ? "This session hasn't changed anything yet" : "No changes");
    const root = v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.height - this.panelH) > 1) { this.panelH = size.height; cx.notify(); } })
      // Dragging the line between the list and the diff: pressed on the line, moved anywhere.
      .on_mouse_move((e, cx) => {
        if (!this.resizing) return;
        this.listH = Math.round(Math.min(Math.max(44, this.panelH - 160), Math.max(44, this.resizing.h + e.position.y - this.resizing.y)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endResize(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endResize(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.confirming) { this.confirming = null; cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.searching) { this.setSearching(false, cx); cx.stop_propagation(); }
        else if (e.key === "f" && (e.modifiers?.control || e.modifiers?.platform) && e.modifiers?.shift) { this.setSearching(true, cx); cx.stop_propagation(); }
      });
    const header = h_flex().h(38).flex_none().pl(14).pr(8).gap(8).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(this.searching ? "SEARCH" : "CHANGES"))
        .when(!this.searching, (e) => e.child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(this.pill("mode-session", "Session", this.mode === "session", (cx) => this.setMode("session", cx), t))
          .child(this.pill("mode-all", "All", this.mode === "all", (cx) => this.setMode("all", cx), t))))
        .child(div().flex_1())
        // Search in all files; again (or Esc) goes back to the changes.
        .child(div().id("find-toggle").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .tooltip(this.searching ? "Back to changes (Esc)" : "Search in all files")
          .bg(this.searching ? t.accent + "33" : t.background).text_color(this.searching ? t.accent : t.muted).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.setSearching(!this.searching, cx))
          .child(icon("search", 16)))
        .when(!this.searching && !this.preview, (e) => e.child(div().id("preview-on").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.setPreview(true, cx))
          .child(svg("mods/diff-view/split.svg").size(16))))
        .when(!this.searching, (e) => e.child(this.iconButton("view", this.tree ? "list-flat" : "list-tree", (cx) => this.toggleTree(cx), t)))
        // The repo's history as a graph (mods/git-graph); only in a git repository.
        .when(!this.searching && Boolean(this.root), (e) => e.child(this.iconButton("graph", "graph", () =>
          openOverlay({ mod: "git-graph", kind: "dialog", width: 0.94, height: 0.92, props: { root: this.root, on: active?.on ?? null } }), t)
          .tooltip(many ? `History of ${active?.name}` : "History")))
        .child(this.iconButton("refresh", "refresh", (cx) => this.searching ? this.search(cx) : this.refresh(cx), t))
        // More git, as VS Code's ⋯: pull, push, branches, stashes... (mods/git-menu).
        .when(!this.searching, (e) => e.child(this.iconButton("more", "more", () =>
          openOverlay({ mod: "git-menu", kind: "popup", at: "pointer", width: 270, height: 560,
            props: { root: this.root, on: active?.on ?? null, owner: this.uid, tree: this.tree, mode: this.mode, sort: this.sort, preview: this.preview } }), t)
          .tooltip(many ? `More actions for ${active?.name}` : "More actions")));
    if (this.searching) return root.child(header).child(this.searchBody(t));
    return root.child(header)
      // Which pane the panel follows: with several terminals or agents in a tab, the focused one.
      .when(Boolean(following), (el) => el.child(h_flex().h(22).flex_none().px(14).gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(followIcon), (e) => e.child(followIcon))
        .child(div().flex_1().min_w(0).truncate().child(following))
        .when(tracked, (e) => e.child(div().id("session-restart").px(6).rounded(4).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.restart(cx)).child("Start over")))))
      .child(this.generating ? this.generatingBox(t) : h_flex().id("commit-message").mx(10).mt(4).h(32).flex_none().pl(10).pr(4).gap(4).items_center().rounded(6).border_1()
        .border_color(this.genDone ? t.ansi2 : this.typing ? t.accent : t.border).cursor_text()
        .on_size_change((s, cx) => { if (Math.round(s.width) !== this.msgW) { this.msgW = Math.round(s.width); cx.notify(); } })
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().flex_1().min_w(0).h_full().flex().items_center().child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(this.iconButton("generate", "sparkle", (cx) => this.generate(cx), t).tooltip("Generate commit message")))
      .child(h_flex().id("commit").mx(10).mt(8).h(30).flex_none().gap(6).items_center().justify_center().rounded(6).text_size(13)
        .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim).when(canCommit, (e) => e.cursor_pointer())
        .on_click((_e, cx) => this.commit(cx))
        .child(icon("check", 16)).child(div().min_w(0).truncate().child(this.busy ? `${this.opLabel ?? "Working"}…` : this.generating ? "Waiting for message…" : many ? `Commit to ${active?.name}` : "Commit")))
      .when(total > 0, (el) => el.child(div().px(14).pt(4).text_size(11).text_color(t.dim)
        .child([staged ? `${staged} staged${many ? ` in ${active?.name}` : ""}${this.group("outside").length ? ` · ${this.group("outside").length} from outside this session` : ""}` : `Nothing staged${many ? ` in ${active?.name}` : ""} · stage files with +`,
          ...stagedElsewhere.map(([r, n]) => `${n} staged in ${r.name}`)].join(" · "))))
      // Discard asks here first, as VS Code's dialog does: it can't be undone.
      .when(Boolean(this.confirming), (el) => el.child(v_flex().id("discard-confirm").mx(10).mt(8).p(8).gap(8).flex_none().rounded(6)
        .border_1().border_color(t.ansi1).bg(t.ansi1 + "1a").text_size(12)
        .child(div().text_color(t.foreground).child(`Discard changes in ${this.confirming.label}?`))
        .child(div().text_size(11).text_color(t.muted).child("This can't be undone. Untracked files are deleted."))
        .child(h_flex().gap(6).justify_end()
          .child(this.pill("discard-cancel", "Cancel", false, (cx) => { this.confirming = null; cx.notify(); }, t))
          .child(div().id("discard-yes").px(9).h(22).flex().items_center().rounded(5).text_size(11).cursor_pointer()
            .bg(t.ansi1).text_color("#ffffff").hover((s) => s.opacity(0.88))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.discardNow(cx))
            .child("Discard")))))
      // Tall enough for every row, plus the empty note (which can wrap) when there are none.
      .child(div().id("changes-list-box").mt(8).min_h(44).relative().border_t(1).border_color(t.border)
        .on_size_change((size) => { this.listMeasured = size.height; })
        .when(!this.preview, (e) => e.flex_1().border_b(1))
        .when(this.preview && this.listH === null, (e) => e.flex_1().max_h(rows.reduce((h, row) => h + (row.repo ? 44 : 24), 0) + 12 + (total ? 0 : 48)))
        .when(this.preview && this.listH !== null, (e) => e.flex_none().h(Math.min(this.listH, Math.max(44, this.panelH - 160))))
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(rows.map((row) => row.repo ? this.repoRow(row.repo, t) : row.group ? this.groupRow(row.group, t, many) : row.file ? this.fileRow(row.in, row.file, row.depth, t) : this.dirRow(row.in, row, t)))
          .when(!total, (e) => e.child(div().px(8).py(4).text_size(12).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 files of a group")))
      .when(this.preview, (pv) => pv
        // The line between the list and the diff: drag to resize, double-click to fit the list again.
        .child(div().id("list-resize").h(7).flex_none().flex().flex_col().justify_center().cursor_row_resize()
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            if (e.click_count === 2) { this.listH = null; this.resizing = null; try { localStorage.setItem("listHeight", "0"); } catch {} }
            else this.resizing = { y: e.position.y, h: this.listH ?? this.listMeasured };
            cx.notify();
          })
          .child(div().w_full().h(this.resizing ? 3 : 1).bg(this.resizing ? t.accent : t.border).hover((st) => st.bg(t.accent))))
        // The diff's own bar: which file, open it side by side, put the preview away.
        .child(h_flex().h(30).flex_none().pl(12).pr(6).gap(4).items_center().border_b(1).border_color(t.border).text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(this.open ? t.muted : t.dim)
            .child(this.open ? (many ? `${this.item(this.open).repo?.name ?? ""} › ` : "") + this.item(this.open).path : total > 0 ? "Select a file to view its changes" : ""))
          .when(Boolean(this.open && this.item(this.open).item), (e) => e.child(h_flex().id("compare-open").h(22).px(7).gap(5).flex_none().items_center()
            .rounded(5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.compare(this.open, cx))
            .child(svg("mods/diff-view/split.svg").size(14)).child("Compare")))
          .when(Boolean(this.open) && this.canEdit(this.open), (e) => e.child(h_flex().id("edit-open").size(22).flex_none().items_center().justify_center().tooltip("Edit")
            .rounded(5).text_color(settings().dark === false ? t.accent : "#58a6ff").cursor_pointer().hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.compare(this.open, cx, true))
            .child(svg("mods/diff-view/edit.svg").size(14))))
          .child(div().id("preview-off").size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.setPreview(false, cx))
            .child(svg("mods/diff-view/close.svg").size(14))))
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(diffSize())
          .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(Math.max(300, this.longest * charWidth(diffSize()) + 70)).h_full().child(v_virtual_list("changes-diff", this.rows.length, rowHeight(diffSize()), (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, diffSize()))).size_full())))
          .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())))
      // With the preview put away the list fills the panel; this bar brings the preview back.
      .when(!this.preview, (e) => e.child(h_flex().id("preview-show").mx(10).mb(10).mt(6).h(30).flex_none().gap(6).items_center().justify_center()
        .rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.setPreview(true, cx))
        .child(svg("mods/diff-view/split.svg").size(14)).child("Show diff preview")))
      .when(Boolean(this.doneNote) && !this.note, (e) => e.child(div().px(10).py(8).text_size(11).text_color(t.ansi2).child(this.doneNote)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
