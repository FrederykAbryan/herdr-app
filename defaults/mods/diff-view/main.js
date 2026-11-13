import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, ScrollHandle, v_virtual_list } from "gpui-base";
import { exec, theme, settings, props, closeOverlay } from "herdr";

// Compare a changed file with how it was before, side by side (or inline), as a dialog over the
// window. Opened by the Changes panel with props:
//   { root, on, files: [{ path, status, left, right, leftLabel, rightLabel }], index }
// left/right: "none" (the file isn't there), "worktree", "index", or a commit/tree id ("HEAD", a
// session snapshot). The right side is read again every few seconds, so an agent's edits show live.

const SELF = "mods/diff-view";
const icon = (name, size = 16) => svg(`${SELF}/${name}.svg`).size(size).flex_none();
const CONTEXT = 3, ROW = 20, CHAR = 7.6;

// Both sides into temp files, then git's own diff with the whole file as context.
const DIFF = `
root=$1; left=$2; right=$3; path=$4
tmp=$(mktemp -d) || exit 1; trap 'rm -rf "$tmp"' EXIT
g() { git -C "$root" --no-optional-locks -c core.fsmonitor=false "$@"; }
get() { case $1 in
  none) : ;;
  worktree) if [ -f "$root/$path" ]; then cat -- "$root/$path"; fi ;;
  index) g show ":$path" 2>/dev/null ;;
  *) g show "$1:$path" 2>/dev/null ;;
esac; }
get "$left" > "$tmp/a"; get "$right" > "$tmp/b"
for f in a b; do [ "$(wc -c < "$tmp/$f")" -gt 3000000 ] && { echo "@@TOOBIG@@"; exit 0; }; done
if cmp -s "$tmp/a" "$tmp/b"; then echo "@@SAME@@"; cat "$tmp/b"; exit 0; fi
git diff --no-index --no-color --no-ext-diff --no-textconv --histogram -U100000000 -- "$tmp/a" "$tmp/b"
c=$?; [ $c -le 1 ] || exit $c
`;

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// The same small highlighter as the Changes panel.
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
  while (i < text.length) {
    const s = text.slice(i);
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
// The part of a changed line that differs from its partner, out to whole words.
function markPair(a, b) {
  const max = Math.min(a.text.length, b.text.length), word = (c) => /[\p{L}\p{N}_]/u.test(c ?? "");
  let p = 0; while (p < max && a.text[p] === b.text[p]) p++;
  let s = 0; while (s < max - p && a.text[a.text.length - 1 - s] === b.text[b.text.length - 1 - s]) s++;
  while (p > 0 && word(a.text[p - 1])) p--;
  while (s > 0 && word(a.text[a.text.length - s]) && word(b.text[b.text.length - s])) s--;
  if (p + s > 0) { a.mark = [p, a.text.length - s]; b.mark = [p, b.text.length - s]; }
}

// Full-context unified diff → aligned rows: { l, r, kind: "same" | "change" }, each side
// { n, text } or null. A block's removed and added lines pair up row by row.
function parse(stdout) {
  if (stdout.startsWith("@@TOOBIG@@")) return { note: "This file is too large to compare (over 3 MB)" };
  if (stdout.startsWith("@@SAME@@")) {
    const lines = stdout.slice(9).replace(/\n$/, "").split("\n");
    if (lines.length === 1 && !lines[0]) return { note: "No differences" };
    return { rows: lines.map((t, i) => ({ kind: "same", l: { n: i + 1, text: untab(t) }, r: { n: i + 1, text: untab(t) } })), same: true };
  }
  if (/^Binary files /m.test(stdout)) return { note: "Binary file · no text to compare" };
  const all = stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return { note: "No text differences" };
  const rows = [];
  let ln = 1, rn = 1, dels = [], adds = [], add = 0, del = 0;
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const l = dels[i] ?? null, r = adds[i] ?? null;
      if (l && r) markPair(l, r);
      rows.push({ kind: "change", l, r });
    }
    dels = []; adds = [];
  };
  for (const line of all.slice(first)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { flush(); ln = Math.max(1, +m[1]); rn = Math.max(1, +m[2]); continue; }
    const k = line[0], text = untab(line.slice(1));
    if (k === "-") { dels.push({ n: ln++, text }); del++; }
    else if (k === "+") { adds.push({ n: rn++, text }); add++; }
    else if (k === " ") { flush(); rows.push({ kind: "same", l: { n: ln++, text }, r: { n: rn++, text } }); }
  }
  flush();
  return { rows, add, del };
}

export default class DiffView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.files = p.files ?? []; this.index = Math.min(Math.max(0, p.index ?? 0), Math.max(0, this.files.length - 1));
    this.root = p.root; this.on = p.on ?? null;
    this.handle = cx.focus_handle(); this.scroll = ScrollHandle.new();
    try { this.split = localStorage.getItem("split") !== "inline"; } catch { this.split = true; }
    try { this.full = localStorage.getItem("full") === "full"; } catch { this.full = false; }
    this.width = 1200; this.change = -1;
    // Where the line between the sides sits, as a share of the width: dragged, remembered.
    try { this.ratio = Math.min(0.85, Math.max(0.15, Number(localStorage.getItem("ratio")) || 0.5)); } catch { this.ratio = 0.5; }
    this.load(cx, true);
    cx.timer.every(2500, (cx) => this.load(cx, false));
  }

  file() { return this.files[this.index]; }

  load(cx, fresh) {
    const f = this.file();
    if (!f || !this.root || (this.loading && !fresh)) return;
    const seq = (this.seq = (this.seq ?? 0) + 1);
    if (fresh) { this.rows = null; this.note = null; this.raw = null; this.expanded = new Set(); this.change = -1; this.items = null; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DIFF, "sh", this.root, f.left, f.right, f.path], { cwd: this.root, on: this.on, timeout: 60000 });
        if (seq !== this.seq) return;
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`);
        if (r.stdout === this.raw) return;
        const first = this.raw === null;
        this.raw = r.stdout;
        const d = parse(r.stdout);
        this.lang = langOf(f.path); this.note = d.note ?? null; this.rows = d.rows ?? []; this.stats = { add: d.add ?? 0, del: d.del ?? 0 };
        this.same = Boolean(d.same);
        this.longest = Math.max(20, ...this.rows.map((row) => Math.max(row.l?.text.length ?? 0, row.r?.text.length ?? 0)));
        this.build();
        if (first && this.blocks.length) { this.change = 0; this.jump(cx); }
        else if (this.change >= this.blocks.length) this.change = this.blocks.length - 1;
      } catch (e) { if (seq === this.seq) this.note = `Cannot compare: ${e?.message ?? e}`; }
      finally { if (seq === this.seq) this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  // What's drawn: every row (full file) or only changes with a few lines around them, the rest
  // folded into a row that opens on click. blocks: where each change starts among the items.
  build() {
    const rows = this.rows ?? [], items = [], blocks = [];
    const keep = new Array(rows.length).fill(this.full);
    if (!this.full) rows.forEach((row, i) => {
      if (row.kind !== "change") return;
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) keep[j] = true;
    });
    for (let i = 0; i < rows.length;) {
      if (keep[i] || this.expanded.has(i)) {
        if (rows[i].kind === "change" && (i === 0 || rows[i - 1].kind !== "change")) blocks.push(items.length);
        items.push({ row: rows[i], block: rows[i].kind === "change" ? blocks.length - 1 : -1 }); i++; continue;
      }
      let j = i; while (j < rows.length && !keep[j] && !this.expanded.has(j)) j++;
      items.push({ fold: i, count: j - i, end: j }); i = j;
    }
    this.items = items; this.blocks = blocks;
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    try { localStorage.setItem("ratio", String(this.ratio)); } catch {}
    cx.notify();
  }

  setFull(full, cx) {
    this.full = full;
    try { localStorage.setItem("full", full ? "full" : "changes"); } catch {}
    this.build(); this.jump(cx); cx.notify();
  }
  setSplit(split, cx) {
    this.split = split;
    try { localStorage.setItem("split", split ? "split" : "inline"); } catch {}
    cx.notify();
  }
  unfold(item, cx) { for (let i = item.fold; i < item.end; i++) this.expanded.add(i); this.build(); cx.notify(); }

  // The list draws inline rows as more than one line per item: count them for scrolling.
  lineOf(itemIndex) {
    if (this.split) return itemIndex;
    let n = 0;
    for (let i = 0; i < itemIndex; i++) { const it = this.items[i]; n += it.row && it.row.kind === "change" ? (it.row.l ? 1 : 0) + (it.row.r ? 1 : 0) : 1; }
    return n;
  }
  jump(cx) {
    if (this.full || this.change < 0 || !this.blocks?.length) return;
    // A little room above the change, like an editor's reveal.
    this.scroll.scroll_to_item(Math.max(0, this.lineOf(this.blocks[this.change]) - 3));
    cx.notify();
  }
  step(by, cx) {
    if (!this.blocks?.length) return;
    // Stepping through changes is the Changes view's job: the full file can't be scrolled to one.
    if (this.full) this.setFull(false, cx);
    this.change = Math.min(this.blocks.length - 1, Math.max(0, (this.change < 0 ? (by > 0 ? -1 : 0) : this.change) + by));
    this.jump(cx);
  }
  openFile(index, cx) {
    if (index < 0 || index >= this.files.length || index === this.index) return;
    this.index = index; this.load(cx, true);
  }

  // Lines as the list draws them. Split: one per row. Inline: a change row becomes its − then its +.
  lines() {
    const out = [];
    for (const it of this.items ?? []) {
      if (it.fold !== undefined || this.split || it.row.kind === "same") { out.push(it); continue; }
      if (it.row.l) out.push({ side: "l", row: it.row, block: it.block });
      if (it.row.r) out.push({ side: "r", row: it.row, block: it.block });
    }
    return out;
  }

  dismiss() { const id = props()?.overlay; if (id) closeOverlay(id); }

  tokens(cell) {
    if (!cell.tokens) cell.tokens = markTokens(tokenize(cell.text, this.lang ?? langOf("")), cell.mark);
    return cell.tokens;
  }

  code(cell, color, t) {
    const syntax = {
      keyword: t.ansi12, function: t.ansi11, type: t.ansi14, tag: t.ansi14, string: t.ansi3, number: t.ansi13,
      attr: t.ansi10, bracket: t.ansi13, comment: t.dim, punct: t.muted,
    };
    // Both sides scroll sideways together (this.hx); numbers and signs stay put.
    return h_flex().flex_1().min_w(0).overflow_hidden().h_full().items_center().child(h_flex().flex_none().h_full().items_center().ml(-(this.hx ?? 0))
      .children(this.tokens(cell).map((tk) => div().flex_none().text_color(syntax[tk.kind] ?? t.foreground)
        .when(tk.kind === "function", (e) => e.font_bold()).when(tk.kind === "comment" || tk.kind === "attr", (e) => e.italic())
        .when(Boolean(tk.hl && color), (e) => e.rounded(3).bg(color + "80")).child(tk.text))));
  }

  // How far the code can scroll sideways: the longest line past the room one side gives it.
  sides() {
    const left = Math.floor((this.width - 1) * this.ratio);
    return [left, this.width - 1 - left];
  }
  maxHx() {
    const side = this.split ? Math.min(...this.sides()) : this.width;
    return Math.max(0, (this.longest ?? 0) * CHAR + 24 - (side - 63));
  }
  scrollX(by, cx) {
    const next = Math.min(this.maxHx(), Math.max(0, (this.hx ?? 0) + by));
    if (next !== this.hx) { this.hx = next; cx.notify(); }
  }

  // One side of a row: number, sign, code. kind: "same", "-", "+", or "gap" (nothing on this side).
  // cur: this row belongs to the change the counter is on: a stronger tint and an accent edge.
  half(cell, kind, width, t, cur = false) {
    const color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : null;
    const el = h_flex().h_full().flex_none().w(width).items_center().overflow_hidden();
    if (kind === "gap") return el.bg(cur ? t.accent + "1c" : t.raised + "60").child(div().w(3).h_full().flex_none().when(cur, (e) => e.bg(t.accent)));
    return el.when(Boolean(color), (e) => e.bg(color + (cur ? "5c" : "26")))
      .child(div().w(3).h_full().flex_none().when(Boolean(color), (e) => e.bg(cur ? t.accent : color)))
      .child(div().w(46).h_full().flex_none().pr(8).flex().items_center().justify_end().text_color(color ?? t.dim).child(String(cell.n)))
      .child(div().w(14).flex_none().font_semibold().text_color(color ?? t.dim).child(kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(this.code(cell, color, t));
  }

  line(it, [lw, rw], t) {
    if (it.fold !== undefined) {
      return h_flex().id(`fold-${it.fold}`).w_full().h(ROW).flex_none().px(12).gap(8).items_center().cursor_pointer()
        .bg(t.accent + "14").text_color(t.accent).hover((s) => s.bg(t.accent + "26"))
        .on_click((_e, cx) => this.unfold(it, cx))
        .child(icon("unfold", 14)).child(`${it.count} unchanged line${it.count === 1 ? "" : "s"}`);
    }
    const { row } = it, cur = it.block !== undefined && it.block >= 0 && it.block === this.change;
    if (!this.split) {
      if (row.kind === "same") return h_flex().w_full().h(ROW).flex_none().child(this.half(row.r, "same", lw + rw + 1, t));
      return h_flex().w_full().h(ROW).flex_none().child(this.half(row[it.side], it.side === "l" ? "-" : "+", lw + rw + 1, t, cur));
    }
    const same = row.kind === "same";
    return h_flex().w_full().h(ROW).flex_none()
      .child(this.half(row.l, same ? "same" : row.l ? "-" : "gap", lw, t, cur))
      .child(div().w(1).h_full().flex_none().bg(cur ? t.accent : t.border))
      .child(this.half(row.r, same ? "same" : row.r ? "+" : "gap", rw, t, cur));
  }

  button(id, name, label, click, t, enabled = true) {
    return h_flex().id(id).h(26).px(label ? 8 : 0).when(!label, (e) => e.w(26).justify_center()).gap(5).items_center().flex_none().rounded(6)
      .text_size(12).text_color(enabled ? t.muted : t.dim).when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (enabled) click(cx); })
      .when(Boolean(name), (e) => e.child(icon(name, 16))).when(Boolean(label), (e) => e.child(label));
  }

  pill(id, label, on, click, t) {
    return div().id(id).px(8).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => click(cx)).child(label);
  }

  render(cx) {
    const t = theme(), f = this.file();
    if (!f) return div().id("diff-view").size_full().p(20).bg(t.background).text_color(t.dim).child("Nothing to compare");
    const parts = f.path.split("/"), name = parts.pop(), lines = this.lines();
    const widths = this.sides();
    if ((this.hx ?? 0) > this.maxHx()) this.hx = this.maxHx();
    const n = this.blocks?.length ?? 0, at = this.change;
    const empty = this.note ?? (this.rows ? null : "Loading…");
    return v_flex().id("diff-view").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_mouse_down("left", () => this.handle.focus())
      // Dragging the line between the sides: the press is on the handle, the moves anywhere.
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.ratio = Math.min(0.85, Math.max(0.15, this.drag.ratio + (e.position.x - this.drag.x) / Math.max(1, this.width)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "n" || k === "j" || k === "down" && e.modifiers?.alt) this.step(1, cx);
        else if (k === "p" || k === "k" || k === "up" && e.modifiers?.alt) this.step(-1, cx);
        else if (k === "]") this.openFile(this.index + 1, cx);
        else if (k === "[") this.openFile(this.index - 1, cx);
        else if (k === "f") this.setFull(!this.full, cx);
        else if (k === "s") this.setSplit(!this.split, cx);
        else if (k === "left") this.scrollX(-CHAR * 8, cx);
        else if (k === "right") this.scrollX(CHAR * 8, cx);
        else if (k === "home") this.scrollX(-1e9, cx);
        else if (k === "escape" || k === "q") this.dismiss();
        else return;
        cx.stop_propagation();
      })
      // File, where it's from, and moving between files.
      .child(h_flex().h(44).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().font_semibold().child(name))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(parts.join("/")))
          .when(Boolean(this.stats && (this.stats.add || this.stats.del)), (e) => e
            .child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${this.stats.add}`))
            .child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${this.stats.del}`))))
        .when(this.files.length > 1, (e) => e.child(h_flex().flex_none().gap(2).items_center()
          .child(this.button("file-prev", "chevron-left", null, (cx) => this.openFile(this.index - 1, cx), t, this.index > 0))
          .child(div().text_size(12).text_color(t.muted).child(`${this.index + 1} / ${this.files.length} files`))
          .child(this.button("file-next", "chevron-right", null, (cx) => this.openFile(this.index + 1, cx), t, this.index < this.files.length - 1))))
        .child(this.button("close", "close", null, () => this.dismiss(), t)))
      // Which side is which, and the view controls.
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().px(6).h(20).flex().items_center().rounded(4).bg(t.ansi1 + "30").text_color(t.ansi1).child(f.leftLabel ?? "Before"))
          .child(div().text_color(t.dim).child("→"))
          .child(div().px(6).h(20).flex().items_center().rounded(4).bg(t.ansi2 + "30").text_color(t.ansi2).child(f.rightLabel ?? "Now"))
          .when(this.loading && Boolean(this.rows), (e) => e.child(div().text_color(t.dim).child("updating…"))))
        .child(h_flex().flex_none().gap(2).items_center()
          .child(this.button("change-prev", "arrow-up", null, (cx) => this.step(-1, cx), t, n > 0 && at > 0))
          .child(div().id("change-count").w(104).h(24).flex().items_center().justify_center().rounded(5).whitespace_nowrap()
            .when(n > 0, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { if (!n) return; if (this.full) this.setFull(false, cx); this.change = (at + 1) % n; this.jump(cx); }).text_color(t.muted).child(n ? `${Math.max(1, at + 1)} of ${n} change${n === 1 ? "" : "s"}` : "no changes"))
          .child(this.button("change-next", "arrow-down", null, (cx) => this.step(1, cx), t, n > 0 && at < n - 1)))
        .child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(this.pill("only-changes", "Changes", !this.full, (cx) => this.setFull(false, cx), t))
          .child(this.pill("full-file", "Full file", this.full, (cx) => this.setFull(true, cx), t)))
        .child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(this.pill("split", "Side by side", this.split, (cx) => this.setSplit(true, cx), t))
          .child(this.pill("inline", "Inline", !this.split, (cx) => this.setSplit(false, cx), t))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .when(Boolean(empty), (e) => e.child(div().p(16).text_color(t.dim).child(empty)))
        .when(!empty, (e) => e
          // Changes only: a plain list (few rows), so a change can be scrolled to. Full file: a
          // virtual list, drawn a screen at a time.
          .child(div().id("diff-x").size_full().overflow_hidden()
            .on_scroll_wheel((e, cx) => {
              const dx = Math.abs(e.delta?.x ?? 0) > Math.abs(e.delta?.y ?? 0) ? e.delta.x : e.modifiers?.shift ? e.delta?.y ?? 0 : 0;
              if (dx) { this.scrollX(-dx, cx); cx.stop_propagation(); }
            })
            .child(div().w_full().h_full().relative()
              .when(!this.full, (e) => e.child(v_flex().id("diff-plain").absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll)
                .children(lines.map((it) => this.line(it, widths, t)))))
              .when(this.full, (e) => e.child(v_virtual_list("diff-rows", lines.length, ROW, (i) => String(i),
                (range) => lines.slice(range.start, range.end).map((it) => this.line(it, widths, t))).size_full()))))
          .when(this.split, (e) => e.child(div().id("divider").absolute().top(0).bottom(0).left(widths[0] - 3).w(7).cursor_col_resize()
            .flex().justify_center()
            .on_mouse_down("left", (ev, cx) => {
              cx.stop_propagation(); this.handle.focus();
              if (ev.click_count === 2) { this.ratio = 0.5; this.drag = null; try { localStorage.setItem("ratio", "0.5"); } catch {} }
              else this.drag = { x: ev.position.x, ratio: this.ratio };
              cx.notify();
            })
            .child(div().w(this.drag ? 3 : 1).h_full().bg(this.drag ? t.accent : t.border).hover((st) => st.bg(t.accent)))))
          .when(!this.full, (e) => e.child(Scrollbar.vertical("diff-plain").absolute().inset_0()))
          .when(this.full, (e) => e.child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))))
      .child(h_flex().h(24).flex_none().px(12).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("n / p  next / previous change").child("[ / ]  previous / next file").child("f  full file").child("s  side by side / inline").child("shift+wheel / ← →  scroll sideways").child("drag the middle line to resize").child("Esc  close"));
  }
}
