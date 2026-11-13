import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, agents, exec, readTextFile, watchFolder, theme, settings, shared, setShared, openOverlay } from "herdr";

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
const icon = (name, size = 14) => svg(`${ICONS}/scm-${name}.svg`).size(size).flex_none();
// One file shape, tinted per type so the list reads like an editor's.
const EXT_TINT = {
  md: "ansi4", mdx: "ansi4", txt: "muted", json: "ansi3", js: "ansi3", mjs: "ansi3", cjs: "ansi3", jsx: "ansi6", ts: "ansi4", tsx: "ansi6",
  html: "ansi1", htm: "ansi1", css: "ansi5", scss: "ansi5", vue: "ansi2", svelte: "ansi1", py: "ansi4", rs: "ansi1", go: "ansi6",
  dart: "ansi6", java: "ansi1", kt: "ansi5", php: "ansi5", rb: "ansi1", sh: "ansi2", yml: "ansi5", yaml: "ansi5", toml: "ansi3",
  sql: "ansi3", pdf: "ansi1", svg: "ansi3", png: "ansi5", jpg: "ansi5", jpeg: "ansi5", gif: "ansi5", lock: "dim",
};
const fileTint = (path, t) => t[EXT_TINT[path.split(".").pop().toLowerCase()]] ?? t.muted;
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

const GROUP_TITLE = { staged: "Staged Changes", outside: "Staged outside this session", changes: "Changes", committed: "Committed by this session" };

export default class Changes extends View {
  init(_props, cx) {
    this.groups = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.pending = new Set(); this.queue = {}; this.collapsed = new Set(); this.collapsedGroups = new Set(["committed"]);
    try { this.mode = localStorage.getItem("mode") === "all" ? "all" : "session"; } catch { this.mode = "session"; }
    try { this.tree = localStorage.getItem("view") !== "list"; } catch { this.tree = true; }
    this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  group(id) { return this.groups.find((g) => g.id === id)?.items ?? []; }
  item(key) {
    const at = key.indexOf("|"), group = key.slice(0, at), path = key.slice(at + 1);
    return { group, path, item: this.group(group).find((f) => f.path === path) };
  }

  // The agent whose changes Session mode shows: the focused pane's, else the tab's most recent.
  session() {
    const f = focused(), saved = shared(SESSIONS) ?? {};
    const tab = agents().filter((a) => a.tab === f?.tab).sort((a, b) => b.seq - a.seq).map((a) => a.address);
    for (const address of [f?.terminal, f?.agent, ...tab]) if (address && saved[address]) return { address, ...saved[address] };
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

  baseline(agent, cx) {
    const pane = panes().find((p) => p.pane === agent.pane);
    if (!pane?.cwd) return;
    const on = spaces().find((s) => s.id === agent.space)?.machine ?? null, address = agent.address;
    this.pending.add(address);
    cx.spawn(async (cx) => {
      let value;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd, on });
        const root = top.code === 0 ? top.stdout.trim() : null;
        value = { root, on, tree: root ? await this.snapshot(root, on) : null, live: true, at: Date.now() };
      } catch (e) { value = { root: null, on, tree: null, live: true, at: Date.now(), error: String(e) }; }
      finally { this.pending.delete(address); }
      this.saveSession(address, value);
      cx.notify();
    });
  }

  // Takes a snapshot for every agent that has none, and marks the ones that went away as ended
  // (kept a few days so a finished session can still be reviewed; it starts over if it returns).
  trackSessions(cx) {
    const live = agents(), saved = shared(SESSIONS) ?? {};
    for (const a of live) if (!saved[a.address]?.live && !this.pending.has(a.address)) this.baseline(a, cx);
    const gone = Object.keys(saved).filter((a) => saved[a].live && !live.some((x) => x.address === a));
    if (gone.length) cx.spawn(async (cx) => {
      const next = { ...(shared(SESSIONS) ?? {}) };
      for (const a of gone) if (next[a]?.live && !agents().some((x) => x.address === a)) next[a] = { ...next[a], live: false, ended: Date.now() };
      setShared(SESSIONS, next);
      cx.notify();
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
    if (!s?.root || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try { this.saveSession(s.address, { ...record(s), tree: await this.snapshot(s.root, s.on), at: Date.now(), error: undefined }); }
      catch (e) { this.note = `Could not snapshot: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = this.key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.groups = []; this.open = null; this.trees = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.groups = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const hasHead = (await git(["rev-parse", "-q", "--verify", "HEAD"])).code === 0;
        let { staged, changes } = parseStatus(status.stdout), outside = [], committed = [], trees = null, error = null;
        if (this.mode === "session") {
          const s = this.session();
          if (!s) error = "No agent session in this tab";
          else if (s.error) error = `Session snapshot failed: ${s.error}`;
          else if (s.root !== root) error = s.root ? `This tab's agent works in ${s.root}` : "This tab's agent didn't start in a git repository";
          if (error) { staged = []; changes = []; }
          else {
            const now = await this.snapshot(root, on);
            const names = await git(["diff", "--name-status", "-z", "--no-renames", s.tree, now]);
            const nums = await git(["diff", "--numstat", "-z", "--no-renames", s.tree, now]);
            for (const r of [names, nums]) if (r.code !== 0) throw new Error(r.stderr);
            const stats = parseNumstat(nums.stdout), mine = new Map(), parts = names.stdout.split("\0");
            for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] && parts[i + 1]) mine.set(parts[i + 1], LETTER[parts[i][0]] ?? "M");
            const listed = new Set([...staged, ...changes].map((f) => f.path));
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
        const cap = (items) => items.slice(0, 1000);
        const limited = [staged, outside, changes, committed].some((items) => items.length > 1000);
        const groups = [["staged", staged], ["outside", outside], ["changes", changes], ["committed", committed]]
          .filter(([id, items]) => items.length || id === "changes").map(([id, items]) => ({ id, items: cap(items) }));
        if (this.key() !== context) return;
        this.root = root; this.on = on; this.hasHead = hasHead; this.groups = groups; this.limited = limited; this.trees = trees; this.error = error;
        this.watch(root, cx);
        if (this.open && !this.item(this.open).item) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        const first = groups.find((g) => g.items.length);
        if (!this.open && !this.closed && first) this.open = `${first.id}|${first.items[0].path}`;
        if (!first) this.setLines([]);
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Session: the session's own diff. Staged: index vs HEAD. Changes: work tree vs index.
  async load(key, context) {
    const { group, path, item } = this.item(key), root = this.root, on = this.on;
    if (!item) return;
    const lang = langOf(path);
    const diff = async (args) => {
      const r = await exec("git", [...READ, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", ...args, "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      return first < 0 ? [item.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    };
    let lines;
    if (this.trees && group !== "outside") lines = await diff([this.trees.base, this.trees.now]);
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
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7.6 + 70));
  }

  pick(key, cx) {
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
  sides(group, f) {
    if (this.trees && group !== "outside") {
      const s = this.session(), at = s?.at ? new Date(s.at) : null;
      const since = at ? ` ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}` : "";
      return { left: this.trees.base, right: "worktree", leftLabel: `Session start${since}`, rightLabel: "Working tree" };
    }
    if (group === "staged" || group === "outside") return { left: this.hasHead ? "HEAD" : "none", right: "index", leftLabel: "HEAD", rightLabel: "Staged" };
    return { left: f.fresh ? "none" : "index", right: "worktree", leftLabel: f.fresh ? "New file" : "Index", rightLabel: "Working tree" };
  }

  // Opens the file big, old and new side by side, with every listed file a step away.
  compare(key, cx) {
    if (!this.root) return;
    const files = [];
    for (const g of this.groups) for (const f of g.items) files.push({ key: `${g.id}|${f.path}`, path: f.path, status: f.status, ...this.sides(g.id, f) });
    const index = files.findIndex((f) => f.key === key);
    if (index < 0) return;
    openOverlay({ mod: "diff-view", kind: "dialog", width: 0.94, height: 0.92, props: { root: this.root, on: this.on, files, index } });
  }

  // Stage and unstage change the repo's index, as `git add` / `git restore --staged` would.
  gitAction(args, cx) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { this.note = String(e?.message ?? e); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }
  stage(paths, cx) { if (paths.length) this.gitAction(["add", "-A", "--", ...paths], cx); }
  unstage(paths, cx) {
    if (paths.length) this.gitAction(this.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths], cx);
  }

  // Commits what's staged, like `git commit`. In Session mode the session's committed files
  // then leave its list.
  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.key()) return;
    const staged = this.group("staged"), outside = this.group("outside");
    if (!staged.length && !outside.length) { this.note = "Nothing is staged: stage files with + first"; cx.notify(); return; }
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const session = this.trees ? this.session() : null, paths = staged.map((f) => f.path);
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["commit", "-m", message], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.message = ""; this.input.set_value("");
        if (session && paths.length) this.saveSession(session.address, { ...record(session), tree: await this.advance(root, on, session.tree, paths) });
      } catch (e) { if (this.key() === context) this.note = `Commit failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  generate(cx) {
    if (!this.root || this.generating || this.busy || this.loading) return;
    const staged = this.group("staged").length + this.group("outside").length;
    if (!staged && !this.group("changes").length) return;
    const context = this.context, root = this.root, on = this.on;
    const args = staged ? ["cached", "", ""] : this.trees ? ["range", this.trees.base, this.trees.now] : ["all", "", ""];
    this.generating = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", GENERATE, "sh", root, ...args], { cwd: root, on, timeout: 120000 });
        const line = r.stdout.split("\n").map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, "").trim()).filter(Boolean).pop();
        if (r.code !== 0 || !line) throw new Error(r.stderr.trim().split("\n").filter(Boolean).pop() || `exit code ${r.code}`);
        if (this.key() === context) { this.message = line; this.input.set_value(line); }
      } catch (e) { if (this.key() === context) this.note = `Could not write a message: ${e?.message ?? e}`; }
      finally { this.generating = false; cx.notify(); }
    });
    cx.notify();
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

  // The + or − a row offers: stage what isn't staged, unstage what is.
  rowAction(group, id, paths, t) {
    if (group === "changes") return this.iconButton(`stage-${id}`, "add", (cx) => this.stage(paths, cx), t);
    if (group === "staged" || group === "outside") return this.iconButton(`unstage-${id}`, "remove", (cx) => this.unstage(paths, cx), t);
    return null;
  }

  groupRow(g, t) {
    const id = `group-${g.id}`, open = !this.collapsedGroups.has(g.id), action = this.hovered === id ? this.rowAction(g.id, id, g.items.map((f) => f.path), t) : null;
    return this.hoverable(h_flex().id(id).h(24).flex_none().px(4).gap(4).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.collapsedGroups, g.id, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 16).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(g.id === "outside" ? t.blocked : t.foreground).child(GROUP_TITLE[g.id]))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_color(t.muted).text_size(10).child(String(g.items.length))), id);
  }

  dirRow(group, { dir, name, depth, paths }, t) {
    const id = `dir-${group}|${dir}`, key = `${group}:${dir}`, open = !this.collapsed.has(key);
    const action = this.hovered === id ? this.rowAction(group, id, paths, t) : null;
    return this.hoverable(h_flex().id(id).h(24).flex_none().pl(20 + depth * 14).pr(4).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.collapsed, key, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 16).text_color(t.muted))
      .child(icon(open ? "folder-opened" : "folder", 16).text_color(t.ansi4))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().size(6).mx(4).flex_none().rounded(3).bg(t.dim)), id);
  }

  fileRow(group, f, depth, t) {
    const key = `${group}|${f.path}`, parts = f.path.split("/"), name = parts.pop();
    const action = this.hovered === key ? this.rowAction(group, key, [f.path], t) : null;
    const compare = this.hovered === key ? div().id(`compare-${key}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.compare(key, cx))
      .child(svg("mods/diff-view/split.svg").size(16)) : null;
    return this.hoverable(h_flex().id(key).h(24).flex_none().pl(20 + depth * 14).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .when(this.open === key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((e, cx) => { if (e.click_count === 2) this.compare(key, cx); else this.pick(key, cx); })
      // In the tree a file lines up under its folder's icon, past the chevron column.
      .when(this.tree, (e) => e.child(div().w(16).flex_none()))
      .child(icon("file", 16).text_color(fileTint(f.path, t)))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).max_w(240).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(name))
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

  diffRow(row, t) {
    const { kind, number, text } = row;
    if (kind === "@") return div().w_full().px(12).h(22).flex_none().flex().items_center().truncate().bg(t.accent + "1f").text_color(t.accent).child(text);
    const color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : null;
    const syntax = {
      keyword: t.ansi12, function: t.ansi11, type: t.ansi14, tag: t.ansi14, string: t.ansi3, number: t.ansi13,
      attr: t.ansi10, bracket: t.ansi13, comment: t.dim, punct: t.muted,
    };
    const tokens = this.codeTokens(row), unit = this.indent ?? 4;
    const body = h_flex().flex_1().min_w(0).overflow_hidden().h_full().items_center()
      .children(Array.from({ length: row.levels ?? 0 }, () => div().flex_none().h_full().flex().items_center().border_l(1).border_color(t.border).child(" ".repeat(unit))))
      .children(tokens.map((tk) => div().flex_none().text_color(syntax[tk.kind] ?? t.foreground)
        .when(tk.kind === "function", (e) => e.font_bold()).when(tk.kind === "comment" || tk.kind === "attr", (e) => e.italic())
        .when(Boolean(tk.hl && color), (e) => e.rounded(3).bg(color + "80")).child(tk.text)));
    return h_flex().w_full().h(22).flex_none().items_center().when(Boolean(color), (e) => e.bg(color + "38"))
      .child(div().w(3).h_full().flex_none().when(Boolean(color), (e) => e.bg(color)))
      .child(div().w(38).h_full().flex_none().pr(6).flex().items_center().justify_end().text_color(color ?? t.dim)
        .when(Boolean(color), (e) => e.bg(color + "40")).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().flex().justify_center().font_semibold().text_color(color ?? t.dim).child(kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(body);
  }

  render(cx) {
    this.trackSessions(cx);
    if (this.key() !== this.context) this.refresh(cx);
    const t = theme(), session = this.mode === "session" ? this.session() : null;
    // The runtime ignores toLocaleTimeString's options (it adds seconds): hours and minutes by hand.
    const at = session?.at ? new Date(session.at) : null;
    const since = at ? `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}` : null;
    const fpane = (() => { const f = focused(); return f?.pane ? panes().find((p) => p.pane === f.pane) : null; })();
    const prog = fpane?.program, repo = this.root?.split("/").pop();
    const followIcon = prog?.icon ? (prog.tint ? svg(prog.icon).size(12).flex_none().text_color(t.muted) : image(prog.icon).size(12).flex_none()) : null;
    const following = repo ? [prog?.name || (fpane?.terminal ? "Terminal" : null), repo, session?.root ? `since ${since}${session.live ? "" : " (ended)"}` : null].filter(Boolean).join(" · ") : null;
    const staged = this.group("staged").length + this.group("outside").length, total = this.groups.reduce((n, g) => n + g.items.length, 0);
    const canCommit = Boolean(this.message.trim() && staged && this.root && !this.busy && !this.loading);
    const rows = [];
    for (const g of this.groups) {
      rows.push({ group: g });
      if (this.collapsedGroups.has(g.id)) continue;
      const items = this.tree ? treeRows(buildTree(g.items), this.collapsed, g.id) : g.items.map((file) => ({ file, depth: 0 }));
      for (const row of items) rows.push({ ...row, in: g.id });
    }
    const empty = this.error || (this.loading ? "Loading changes…" : !this.root ? "No folder" : this.mode === "session" ? "This session hasn't changed anything yet" : "No changes");
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(38).flex_none().pl(14).pr(8).gap(8).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("CHANGES"))
        .child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(this.pill("mode-session", "Session", this.mode === "session", (cx) => this.setMode("session", cx), t))
          .child(this.pill("mode-all", "All", this.mode === "all", (cx) => this.setMode("all", cx), t)))
        .child(div().flex_1())
        .child(this.iconButton("view", this.tree ? "list-flat" : "list-tree", (cx) => this.toggleTree(cx), t))
        .child(this.iconButton("refresh", "refresh", (cx) => this.refresh(cx), t)))
      // Which pane the panel follows: with several terminals or agents in a tab, the focused one.
      .when(Boolean(following), (el) => el.child(h_flex().h(22).flex_none().px(14).gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(followIcon), (e) => e.child(followIcon))
        .child(div().flex_1().min_w(0).truncate().child(following))
        .when(Boolean(session?.root), (e) => e.child(div().id("session-restart").px(6).rounded(4).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.restart(cx)).child("Start over")))))
      .child(h_flex().id("commit-message").mx(10).mt(4).h(32).flex_none().pl(10).pr(4).gap(4).items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().flex_1().min_w(0).h_full().flex().items_center().child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(this.generating
          ? div().w(22).flex_none().flex().justify_center().text_color(t.dim).child("…")
          : this.iconButton("generate", "sparkle", (cx) => this.generate(cx), t)))
      .child(h_flex().id("commit").mx(10).mt(8).h(30).flex_none().gap(6).items_center().justify_center().rounded(6).text_size(13)
        .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim).when(canCommit, (e) => e.cursor_pointer())
        .on_click((_e, cx) => this.commit(cx))
        .child(icon("check", 16)).child(this.busy ? "Working…" : "Commit"))
      .when(total > 0, (el) => el.child(div().px(14).pt(4).text_size(11).text_color(t.dim)
        .child(staged ? `${staged} staged${this.group("outside").length ? ` · ${this.group("outside").length} from outside this session` : ""}` : "Nothing staged · stage files with +")))
      // Tall enough for every row, plus the empty note (which can wrap) when there are none.
      .child(div().mt(8).flex_1().min_h(44).max_h(rows.length * 24 + 12 + (total ? 0 : 48)).relative().border_t(1).border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(rows.map((row) => row.group ? this.groupRow(row.group, t) : row.file ? this.fileRow(row.in, row.file, row.depth, t) : this.dirRow(row.in, row, t)))
          .when(!total, (e) => e.child(div().px(8).py(4).text_size(12).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 files of a group")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 22, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && total > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))
        .when(Boolean(this.open && this.item(this.open).item), (e) => e.child(h_flex().id("compare-open").absolute().top(6).right(14).h(24).px(8).gap(5).items_center()
          .rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11.5).text_color(t.muted).cursor_pointer().font_family(settings().ui_font ?? "Geist")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.compare(this.open, cx))
          .child(svg("mods/diff-view/split.svg").size(14)).child("Compare"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
