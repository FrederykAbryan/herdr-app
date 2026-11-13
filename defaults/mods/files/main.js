// A lazy file browser for the focused pane's folder, with bounded previews. A local file's
// preview turns into an editor with Edit: ctrl+s saves, refusing if the file changed on disk.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window } from "herdr";

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

// File-type icons, VS Code style: a colored letter badge, or a colored glyph (ft-*.svg).
// { badge, bg, fg } or { glyph, color }; first match wins: whole name, then extension.
const BADGE = (badge, bg, fg = "#ffffff") => ({ badge, bg, fg }), GLYPH = (glyph, color) => ({ glyph, color });
const BY_NAME = {
  "package.json": GLYPH("package", "#e8274b"), "package-lock.json": GLYPH("lock", "#e8274b"), "bun.lock": GLYPH("lock", "#f9f1e1"),
  "pnpm-lock.yaml": GLYPH("lock", "#f69220"), "yarn.lock": GLYPH("lock", "#2c8ebb"), "cargo.lock": GLYPH("lock", "#dea584"),
  "composer.lock": GLYPH("lock", "#8892be"), "pubspec.lock": GLYPH("lock", "#40c4ff"), "pubspec.yaml": GLYPH("package", "#40c4ff"),
  "cargo.toml": GLYPH("package", "#dea584"), "composer.json": GLYPH("package", "#8892be"),
  "dockerfile": GLYPH("whale", "#2496ed"), "docker-compose.yml": GLYPH("whale", "#2496ed"), "docker-compose.yaml": GLYPH("whale", "#2496ed"),
  "compose.yml": GLYPH("whale", "#2496ed"), "compose.yaml": GLYPH("whale", "#2496ed"), ".dockerignore": GLYPH("whale", "#5f7a8a"),
  ".gitignore": GLYPH("git", "#f14e32"), ".gitattributes": GLYPH("git", "#f14e32"), ".gitmodules": GLYPH("git", "#f14e32"), ".gitkeep": GLYPH("git", "#f14e32"),
  "license": GLYPH("key", "#e5c07b"), "license.md": GLYPH("key", "#e5c07b"), "license.txt": GLYPH("key", "#e5c07b"),
  "readme.md": GLYPH("info", "#42a5f5"), "readme": GLYPH("info", "#42a5f5"), "makefile": GLYPH("terminal", "#e37933"),
  "tsconfig.json": BADGE("TS", "#3178c6"), "jsconfig.json": BADGE("JS", "#f0db4f", "#1b1b1b"),
  ".editorconfig": GLYPH("gear", "#9aa5b1"), ".prettierrc": GLYPH("gear", "#56b3b4"), ".eslintrc": GLYPH("gear", "#8080f2"),
};
const BY_EXT = {
  ts: BADGE("TS", "#3178c6"), mts: BADGE("TS", "#3178c6"), cts: BADGE("TS", "#3178c6"), tsx: GLYPH("atom", "#3178c6"), jsx: GLYPH("atom", "#61dafb"),
  js: BADGE("JS", "#f0db4f", "#1b1b1b"), mjs: BADGE("JS", "#f0db4f", "#1b1b1b"), cjs: BADGE("JS", "#f0db4f", "#1b1b1b"),
  json: GLYPH("braces", "#f0c94a"), jsonc: GLYPH("braces", "#f0c94a"), json5: GLYPH("braces", "#f0c94a"),
  html: GLYPH("code", "#e44d26"), htm: GLYPH("code", "#e44d26"), xml: GLYPH("code", "#f1662a"), vue: BADGE("V", "#41b883"), svelte: BADGE("S", "#ff3e00"), astro: BADGE("A", "#ff5d01"),
  css: GLYPH("hash", "#42a5f5"), scss: GLYPH("hash", "#f06292"), sass: GLYPH("hash", "#f06292"), less: GLYPH("hash", "#5b7bd5"),
  md: BADGE("M", "#42a5f5"), mdx: BADGE("MX", "#f9ac00", "#1b1b1b"),
  py: BADGE("PY", "#3776ab"), rb: BADGE("RB", "#cc342d"), php: BADGE("PHP", "#777bb4"), go: BADGE("GO", "#00add8"), rs: BADGE("RS", "#dea584", "#1b1b1b"),
  java: BADGE("J", "#e76f00"), kt: BADGE("K", "#7f52ff"), kts: BADGE("K", "#7f52ff"), swift: BADGE("SW", "#f05138"), dart: BADGE("DT", "#0175c2"),
  c: BADGE("C", "#5c6bc0"), h: BADGE("H", "#7e57c2"), cpp: BADGE("C++", "#00599c"), hpp: BADGE("H", "#7e57c2"), cs: BADGE("C#", "#68217a"),
  lua: BADGE("LU", "#000080"), r: BADGE("R", "#276dc3"), ex: BADGE("EX", "#6e4a7e"), exs: BADGE("EX", "#6e4a7e"), zig: BADGE("Z", "#f7a41d", "#1b1b1b"),
  sh: GLYPH("terminal", "#89e051"), bash: GLYPH("terminal", "#89e051"), zsh: GLYPH("terminal", "#89e051"), fish: GLYPH("terminal", "#89e051"),
  ps1: GLYPH("terminal", "#5391fe"), bat: GLYPH("terminal", "#c1f12e"), cmd: GLYPH("terminal", "#c1f12e"),
  sql: GLYPH("db", "#e38c00"), prisma: GLYPH("db", "#5a67d8"), graphql: BADGE("GQ", "#e535ab"), gql: BADGE("GQ", "#e535ab"),
  yml: GLYPH("gear", "#cb6ce6"), yaml: GLYPH("gear", "#cb6ce6"), toml: GLYPH("gear", "#9c4221"), ini: GLYPH("gear", "#9aa5b1"), conf: GLYPH("gear", "#9aa5b1"),
  cfg: GLYPH("gear", "#9aa5b1"), properties: GLYPH("gear", "#9aa5b1"), env: GLYPH("gear", "#f5d547"), lock: GLYPH("lock", "#9aa5b1"),
  png: GLYPH("image", "#26a69a"), jpg: GLYPH("image", "#26a69a"), jpeg: GLYPH("image", "#26a69a"), gif: GLYPH("image", "#26a69a"), webp: GLYPH("image", "#26a69a"),
  bmp: GLYPH("image", "#26a69a"), ico: GLYPH("image", "#f5d547"), svg: GLYPH("image", "#ffb13b"), avif: GLYPH("image", "#26a69a"),
  pdf: GLYPH("pdf", "#e53935"), txt: GLYPH("text", "#9aa5b1"), log: GLYPH("text", "#8d6e63"), csv: GLYPH("text", "#43a047"),
  zip: GLYPH("archive", "#afb42b"), gz: GLYPH("archive", "#afb42b"), tar: GLYPH("archive", "#afb42b"), tgz: GLYPH("archive", "#afb42b"), "7z": GLYPH("archive", "#afb42b"), rar: GLYPH("archive", "#afb42b"),
  pem: GLYPH("key", "#e5c07b"), key: GLYPH("key", "#e5c07b"), crt: GLYPH("key", "#e5c07b"),
};
const FOLDER = "#dcb67a";
function fileType(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env") || lower.endsWith(".env")) return BY_EXT.env;
  if (lower.startsWith("dockerfile")) return BY_NAME.dockerfile;
  if (lower.startsWith(".eslintrc") || lower.startsWith(".prettierrc")) return BY_NAME[lower.startsWith(".e") ? ".eslintrc" : ".prettierrc"];
  if (lower.startsWith("readme")) return BY_NAME.readme;
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return BY_EXT[ext] ?? null;
}
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
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
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
      font_family: settings().font_family, font_size: 12, syntax: syntaxFor(theme()) });
    if (!readonly) code.on("change", (_e, cx) => { this.leaving = false; if (!this.conflict) this.editNote = null; cx.notify(); });
    return code;
  }

  // Edit: here only (writeTextFile can't reach another machine), and not a truncated file.
  canEdit() { return Boolean(this.file && this.text !== null && !this.on && this.text.length <= MAX_EDIT); }
  dirty() { return Boolean(this.editing && this.code && this.code.value() !== this.text); }

  setEditing(on, cx) {
    if (!this.canEdit() || on === this.editing) return;
    if (!on && this.dirty() && !this.leaving) { this.leaving = true; this.editNote = "Unsaved changes · click Done again to discard"; cx.notify(); return; }
    this.code?.release();
    this.editing = on; this.leaving = false; this.conflict = false; this.editNote = null;
    this.code = this.editor(this.file, this.text, !on);
    cx.notify();
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
      .on_click((_e, cx) => { if (enabled) click(cx); }).child(svg(`mods/diff-view/${name}.svg`).size(15));
  }

  // A row's icon: a folder (open or shut), a file type's badge or glyph, else a plain page.
  icon(entry, open, t) {
    if (entry.dir) return svg(`mods/files/ft-folder${open ? "-open" : ""}.svg`).size(16).flex_none().text_color(FOLDER);
    const type = fileType(entry.name);
    if (!type) return svg("mods/files/file.svg").size(15).flex_none().text_color(t.muted);
    if (type.glyph) return svg(`mods/files/ft-${type.glyph}.svg`).size(15).flex_none().text_color(type.color);
    const n = type.badge.length;
    return div().w(16).h(14).flex_none().flex().items_center().justify_center().rounded(3).bg(type.bg).text_color(type.fg)
      .text_size(n > 2 ? 6 : n > 1 ? 7.5 : 9).font_semibold().line_height("14px").child(type.badge);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
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
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (this.editing && e.key === "s" && (e.modifiers?.control || e.modifiers?.platform)) { this.save(cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => {
          if (dirty) { this.editNote = "Save or discard your edits first"; cx.notify(); return; }
          this.show(null); cx.notify();
        }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      // Read-only preview with Edit, or the editor with Save / Done.
      .when(Boolean(this.file) && this.canEdit(), el => el.child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
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
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
