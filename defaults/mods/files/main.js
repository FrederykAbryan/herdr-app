// A lazy file browser for the focused pane's folder, with bounded previews. A local file's
// preview turns into an editor with Edit: ctrl+s saves, refusing if the file changed on disk.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, layout, run, shared, setShared, openOverlay } from "herdr";
import { typeIcon, folderIcon } from "./filetypes.js";

const FT = "mods/files";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  env: "bash", zsh: "bash", fish: "bash", bashrc: "bash", zshrc: "bash", profile: "bash", ini: "properties", conf: "properties", cfg: "properties",
  yml: "yaml", py: "python", rs: "rust", h: "c", makefile: "make", mk: "make" };
const MAX_EDIT = 400000;

// Edit-button icon colors: vivid in dark mode (the theme's ANSI colors are pale there), the theme's in light.
const tint = (t) => settings().dark === false
  ? { edit: t.accent, save: t.ansi2, done: t.ansi4, discard: t.ansi1, reload: t.ansi3, overwrite: t.ansi9 }
  : { edit: "#58a6ff", save: "#3fb950", done: "#58a6ff", discard: "#f85149", reload: "#d29922", overwrite: "#ff7b72" };
// The editor's language for a file: .env, .env.local, .env.production... read as shell
// (keys, strings, ${VARS} and comments all get colors); others by extension.
const langOf = (path) => {
  const name = path.split("/").pop().toLowerCase();
  if (name.startsWith(".env") || name.endsWith(".env")) return "bash";
  const ext = name.includes(".") ? name.split(".").pop() : name;
  return LANG[ext] ?? ext;
};
// Code colors: GitHub's dark palette in dark mode, the theme's in light.
const syntaxFor = (t) => settings().dark === false
  ? { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, variable: t.ansi3, property: t.ansi4, operator: t.ansi5 }
  : { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", function: "#d2a8ff", type: "#ffa657", number: "#79c0ff", constant: "#79c0ff",
      variable: "#ffa657", property: "#7ee787", operator: "#ff7b72" };
const PER_FOLDER = 500, TOTAL = 5000;

// ctrl+/ comments: `#` for shell-like languages, `--` for SQL/Lua, wrapped for markup and CSS, else `//`.
const HASH = new Set(["bash", "sh", "python", "yaml", "properties", "make", "ruby", "r", "perl", "dockerfile", "nix", "elixir", "graphql", "gitignore", "editorconfig"]);
const DASH = new Set(["sql", "lua", "haskell"]);
const WRAP = { html: ["<!--", "-->"], xml: ["<!--", "-->"], svg: ["<!--", "-->"], md: ["<!--", "-->"], markdown: ["<!--", "-->"], css: ["/*", "*/"] };
const commentFor = (path) => {
  const l = langOf(path);
  return HASH.has(l) ? ["#", ""] : DASH.has(l) ? ["--", ""] : WRAP[l] ?? ["//", ""];
};
// The whole lines a selection touches: [a, b) without the final newline. A selection that
// ends at the start of a line (dragged down to it) leaves that line out, as in VS Code.
const lineSpan = (text, r) => {
  const s = Math.min(r.start, r.end), e = Math.max(r.start, r.end);
  const last = e > s && text[e - 1] === "\n" ? e - 1 : e;
  const a = s === 0 ? 0 : text.lastIndexOf("\n", s - 1) + 1;
  const nl = text.indexOf("\n", last);
  return { s, e, a, b: nl < 0 ? text.length : nl };
};

// Full screen for the Files panel: hides the sidebar, the panes and the status bar, lets the
// panel take the whole width and maximizes the window, remembering what was shown (shared, so
// it survives a restart) to put back exactly that.
const FULL = "files.fullscreen";
const HIDE = ["sidebar", "main", "status"];
const findNode = (n, id) => !n ? null : n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? findNode(c, id), null);
function setFullscreen(on) {
  const root = layout(), was = shared(FULL);
  if (on && !was) {
    const saved = Object.fromEntries(HIDE.map((id) => [id, Boolean(findNode(root, id)) && !findNode(root, id).hidden]));
    saved.panel = findNode(root, "panel")?.size ?? null;
    saved.maximized = Boolean(window()?.maximized);
    setShared(FULL, saved);
    for (const id of HIDE) if (saved[id]) run("layout.hide", { id });
    run("layout.resize", { id: "panel", weight: 1 });
    if (!saved.maximized) run("window.maximize");
  } else if (!on && was) {
    setShared(FULL, null);
    for (const id of HIDE) if (was[id]) run("layout.show", { id });
    if (was.panel?.px) run("layout.resize", { id: "panel", px: was.panel.px });
    else if (was.panel?.weight) run("layout.resize", { id: "panel", weight: was.panel.weight });
    if (!was.maximized && window()?.maximized) run("window.maximize");
  }
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // Full screen with a file open: the tree stays on the left at this width (drag the line).
    try { const w = Number(localStorage.getItem("treeWidth")); this.treeW = w > 0 ? w : 320; } catch { this.treeW = 320; }
    this.width = 1200; this.drag = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => {
      this.refresh(cx);
      // The panel was closed while full screen (its tab-bar button): don't leave the panes hidden.
      if (shared(FULL) && findNode(layout(), "panel")?.hidden) setFullscreen(false);
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.text = null; this.editing = false; this.editNote = null; this.conflict = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text;
        this.code = this.editor(path, text.length > MAX_EDIT ? text.slice(0, MAX_EDIT) + "\n… (file truncated)" : text, true);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  editor(path, value, readonly) {
    const code = EditorState.new({ language: langOf(path), readonly, value,
      font_family: settings().font_family, font_size: settings().font_size, syntax: syntaxFor(theme()) });
    if (!readonly) code.on("change", (_e, cx) => { this.leaving = false; if (!this.conflict) this.editNote = null; cx.notify(); });
    return code;
  }

  // Edit: here only (writeTextFile can't reach another machine), and not a truncated file.
  canEdit() { return Boolean(this.file && this.text !== null && !this.on && this.text.length <= MAX_EDIT); }
  dirty() { return Boolean(this.editing && this.code && this.code.value() !== this.text); }

  setEditing(on, cx) {
    if (!this.canEdit() || on === this.editing) return;
    if (!on && this.dirty() && !this.leaving) { this.leaving = true; this.editNote = "Unsaved changes · click Done again to discard"; cx.notify(); return; }
    // Keep the cursor/selection across the swap (a double-click's word stays selected).
    let range = null;
    try { range = this.code?.selected_range() ?? null; } catch {}
    this.code?.release();
    this.editing = on; this.leaving = false; this.conflict = false; this.editNote = null;
    this.code = this.editor(this.file, this.text, !on);
    if (range) try { this.code.set_selected_range(range); } catch {}
    if (on) this.code.focus();
    cx.notify();
  }

  // Replaces [a, b) as one undo step, then selects `sel`.
  splice(a, b, text, sel) {
    this.code.set_selected_range({ start: a, end: b });
    this.code.replace(text);
    this.code.set_selected_range(sel);
  }

  // ctrl+/: comment the touched lines, or uncomment them when every non-blank one is commented.
  toggleComment() {
    const text = this.code.value(), { s, e, a, b } = lineSpan(text, this.code.selected_range());
    const [open, close] = commentFor(this.file);
    const lines = text.slice(a, b).split("\n"), body = lines.filter((l) => l.trim());
    if (!body.length) return;
    const commented = (l) => { const t = l.trim(); return t.startsWith(open) && (!close || t.endsWith(close)); };
    const uncomment = body.every(commented);
    const indent = Math.min(...body.map((l) => l.match(/^\s*/)[0].length));
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      if (!uncomment) return l.slice(0, indent) + open + " " + l.slice(indent) + (close ? " " + close : "");
      const i = l.indexOf(open);
      let rest = l.slice(i + open.length).replace(/^ /, "");
      if (close) { const j = rest.lastIndexOf(close); rest = rest.slice(0, j).replace(/ $/, "") + rest.slice(j + close.length); }
      return l.slice(0, i) + rest;
    }).join("\n");
    const first = out.split("\n", 1)[0].length - lines[0].length, total = out.length - (b - a);
    const start = Math.max(a, s + first);
    this.splice(a, b, out, s === e ? { start, end: start } : { start, end: Math.max(start, e + total) });
  }

  // ctrl+shift+down / up: copy the touched lines below / above, the cursor going with the copy
  // (down) or staying on the upper one (up), as VS Code's Copy Line Down / Up.
  copyLines(down) {
    const text = this.code.value(), { s, e, a, b } = lineSpan(text, this.code.selected_range());
    const block = text.slice(a, b), d = down ? block.length + 1 : 0;
    this.splice(b, b, "\n" + block, { start: s + d, end: e + d });
  }

  save(cx, force = false) {
    if (!this.editing || !this.code || this.saving) return;
    const text = this.code.value(), path = this.file, full = `${this.root}/${path}`;
    if (!force && text === this.text) return;
    this.saving = true;
    cx.spawn(async cx => {
      try {
        const expected = force ? await readTextFile(full) : this.text;
        await writeTextFile(full, text, expected);
        if (this.file === path) { this.text = text; this.conflict = false; this.leaving = false; this.editNote = "Saved"; }
      } catch { if (this.file === path) { this.conflict = true; this.editNote = "Changed on disk since you opened it"; } }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  // Back to the file as it is on disk now, dropping the edits.
  reload(cx) {
    const path = this.file;
    cx.spawn(async cx => {
      const text = await readTextFile(`${this.root}/${path}`).catch(() => null);
      if (text !== null && this.file === path && this.code) { this.text = text; this.code.set_value(text); this.conflict = false; this.leaving = false; this.editNote = "Reloaded"; }
      cx.notify();
    });
  }

  // An icon button (icons from the compare view's set) with its name on hover.
  button(id, name, tip, click, t, enabled = true, color = null) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).tooltip(tip)
      .text_color(enabled ? color ?? t.muted : color ? color + "66" : t.dim)
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(color ?? t.foreground)))
      .on_click((_e, cx) => { if (enabled) click(cx); }).child(svg(name.includes("/") ? name : `mods/diff-view/${name}.svg`).size(15));
  }

  // A row's icon: a folder (open or shut), the file type's badge or glyph, else a plain page.
  icon(entry, open, t) {
    return entry.dir ? folderIcon(FT, open, entry.name) : typeIcon(FT, entry.name, t);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(!entry.dir && path === this.file, el => el.bg(t.selected))
        // Right-click: reveal it, open it, copy its path (mods/file-menu).
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "file-menu", kind: "popup", at: "pointer", width: 240, height: 220,
            props: { path: `${this.root}/${path}`, root: this.root, on: this.on ?? null, dir: Boolean(entry.dir) } });
        })
        .on_click((_e, cx) => {
          if (entry.dir) return this.toggle(path, cx);
          if (path === this.file) return;
          // Beside an open editor: don't drop unsaved edits by opening another file.
          if (this.dirty()) { this.editNote = "Save or discard your edits first"; this.leaving = false; cx.notify(); return; }
          this.show(path, cx);
        })
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(this.icon(entry, open, t))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const dirty = this.dirty();
    const full = Boolean(shared(FULL)), canFull = full || Boolean(findNode(layout(), "panel"));
    const split = full && Boolean(this.file);
    const treeW = Math.round(Math.min(Math.max(160, this.treeW), Math.max(160, this.width - 280)));
    const tree = v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
    const fileView = this.file ? this.fileView(t, dirty) : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      // Dragging the line between the tree and the file: pressed on the line, moved anywhere.
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.treeW = Math.round(Math.min(Math.max(160, this.width - 280), Math.max(160, this.drag.w + e.position.x - this.drag.x)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {}, ctrl = m.control || m.platform;
        if (this.editing && this.code && ctrl && !m.alt) {
          if (e.key === "s" && !m.shift) { this.save(cx); cx.stop_propagation(); return; }
          if (e.key === "/" && !m.shift) { this.toggleComment(); cx.stop_propagation(); cx.notify(); return; }
          if (m.shift && (e.key === "down" || e.key === "up")) { this.copyLines(e.key === "down"); cx.stop_propagation(); cx.notify(); return; }
        }
        if (e.key === "escape" && !this.editing && full) { setFullscreen(false); cx.stop_propagation(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => {
          if (dirty) { this.editNote = "Save or discard your edits first"; cx.notify(); return; }
          this.show(null); cx.notify();
        }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(canFull, el => el.child(this.button("files-fullscreen", `${FT}/scm-screen-${full ? "normal" : "full"}.svg`,
          full ? "Leave full screen (Esc)" : "Full screen", () => setFullscreen(!full), t, true, full ? tint(t).done : null))))
      .when(!this.file, el => el.child(tree))
      .when(Boolean(this.file) && !split, el => el.child(fileView))
      // Full screen: the tree stays, the file opens beside it; drag the line (double-click: back to 320).
      .when(split, el => el.child(h_flex().id("files-split").flex_1().min_h(0).min_w(0)
        .child(v_flex().id("files-side").w(treeW).flex_none().min_h(0).h_full().child(tree))
        .child(div().id("files-resize").w(7).flex_none().h_full().flex().justify_center().cursor_col_resize()
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            if (e.click_count === 2) { this.treeW = 320; this.drag = null; try { localStorage.setItem("treeWidth", "320"); } catch {} }
            else this.drag = { x: e.position.x, w: treeW };
            cx.notify();
          })
          .child(div().w(this.drag ? 3 : 1).h_full().bg(this.drag ? t.accent : t.border).hover(s => s.bg(t.accent))))
        .child(v_flex().id("files-main").flex_1().min_w(0).min_h(0).h_full().child(fileView))));
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    try { localStorage.setItem("treeWidth", String(this.treeW)); } catch {}
    cx.notify();
  }

  // The open file: read-only preview with Edit, or the editor with Save / Done.
  fileView(t, dirty) {
    return v_flex().id("files-file").flex_1().min_h(0).min_w(0)
      .when(this.canEdit(), el => el.child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .when(this.editing, el => el.child(div().px(6).h(20).flex().flex_none().items_center().rounded(4).bg(t.accent + "26").text_color(t.accent).child("Editing")))
          .when(dirty, el => el.child(div().flex_none().text_color(t.foreground).child("●")))
          .when(Boolean(this.saving), el => el.child(div().flex_none().text_color(t.dim).child("saving…")))
          .when(Boolean(this.editNote), el => el.child(div().min_w(0).truncate().text_color(this.conflict || this.leaving ? t.ansi1 : t.dim).child(this.editNote))))
        .when(!this.editing, el => el.child(this.button("files-edit", "edit", "Edit", cx => this.setEditing(true, cx), t, true, tint(t).edit)))
        .when(this.editing && this.conflict, el => el
          .child(this.button("files-reload", "refresh", "Reload from disk (drop your edits)", cx => this.reload(cx), t, true, tint(t).reload))
          .child(this.button("files-overwrite", "overwrite", "Overwrite the file on disk", cx => this.save(cx, true), t, true, tint(t).overwrite)))
        .when(this.editing && dirty && !this.conflict, el => el.child(this.button("files-discard", "discard", "Discard changes", cx => this.reload(cx), t, true, tint(t).discard)))
        .when(this.editing, el => el
          .child(this.button("files-save", "save", "Save (ctrl+s)", cx => this.save(cx), t, dirty && !this.saving, tint(t).save))
          .child(this.button("files-done", "check", "Done", cx => this.setEditing(false, cx), t, true, tint(t).done)))))
      // Double-click the preview to start editing, keeping the word it selected.
      .child(this.code
        ? div().id("files-code").flex_1().min_h(0).flex().flex_col()
          .on_mouse_down("left", (e, cx) => { if (!this.editing && e.click_count === 2 && this.canEdit()) this.setEditing(true, cx); })
          .child(Editor.new(this.code).flex_1().min_h(0))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"));
  }
}
