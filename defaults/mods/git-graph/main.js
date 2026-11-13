import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, openOverlay } from "herdr";

// A repo's history as a graph, as a dialog over the window. Opened by the Changes panel with
// props { root, on }. Each row is a commit; lanes are drawn with plain divs (lines and dots).
// The list draws only the rows on screen and scrolls itself (as the palette does): a
// v_virtual_list here drew no rows.
// Click a commit for its message and files; click a file to compare it in mods/diff-view.

const SELF = "mods/git-graph";
const ROW = 26;          // row height, px
const LANE = 22;         // lane width, px
const LINE = 2;          // lane line thickness, px
const DOT = 11;          // commit dot size, px
const MAX_LANES = 14;    // the graph column never grows past this many lanes
const PAGE = 800;        // commits per load
const SEP = "\x1f", END = "\x1e";

const icon = (name, size = 14) => svg(`${SELF}/${name}.svg`).size(size).flex_none();

function ago(seconds) {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, n] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${name}${v > 1 ? "s" : ""} ago`; }
  return "just now";
}

// Refs as git prints them in %D: "HEAD -> main, origin/main, tag: v1".
function parseRefs(text) {
  if (!text) return [];
  return text.split(", ").filter(Boolean).flatMap((r) => {
    if (r.startsWith("HEAD -> ")) return [{ kind: "head", name: r.slice(8) }];
    if (r === "HEAD") return [{ kind: "head", name: "HEAD" }];
    if (r.startsWith("tag: ")) return [{ kind: "tag", name: r.slice(5) }];
    if (r.endsWith("/HEAD")) return [];
    return [{ kind: r.includes("/") ? "remote" : "local", name: r }];
  });
}

// Lanes, top to bottom. Each lane waits for one commit hash; a commit takes the lane that waits
// for it (others waiting for it merge in), then that lane waits for its first parent and new
// lanes open for the other parents. Segments: v = a vertical piece of lane v from..to (row
// fractions), h = a horizontal piece at mid-row between two lanes. Colors follow the lane.
function layout(commits) {
  const lanes = [];
  let widest = 1;
  const rows = commits.map((c) => {
    const segs = [];
    const hits = [];
    lanes.forEach((h, k) => { if (h === c.hash) hits.push(k); });
    let lane = hits.length ? hits[0] : lanes.indexOf(null);
    if (lane < 0) { lane = lanes.length; lanes.push(null); }
    lanes.forEach((h, k) => { if (h && h !== c.hash) segs.push({ v: k, from: 0, to: 1, c: k }); });
    if (hits.length) segs.push({ v: lane, from: 0, to: 0.5, c: lane });
    for (const k of hits.slice(1)) {
      segs.push({ join: k, to: lane, c: k });   // comes down lane k, curves into this commit
      lanes[k] = null;
    }
    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    if (first) segs.push({ v: lane, from: 0.5, to: 1, c: lane });
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k >= 0 && k !== lane) { segs.push({ h: [lane, k], c: k }); continue; }
      k = lanes.indexOf(null);
      if (k < 0) { k = lanes.length; lanes.push(null); }
      lanes[k] = p;
      segs.push({ fork: k, from: lane, c: k }); // leaves this commit, curves down into lane k
    }
    widest = Math.max(widest, lane + 1, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, segs };
  });
  return { rows, lanes: Math.min(widest, MAX_LANES) };
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.root = props()?.root;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.limit = PAGE;
    try { this.all = localStorage.getItem("scope") !== "current"; } catch { this.all = true; }
    this.commits = null;
    this.graph = { rows: [], lanes: 1 };
    this.more = false;
    this.error = null;
    this.selected = null;   // index into commits
    this.offset = 0;        // how far the list is scrolled, px
    this.viewH = 600;       // the list's height, px (measured)
    this.drag = null;       // a scrollbar drag: { y, offset }
    this.details = null;    // { hash, body, files } for the selected commit
    if (this.root) this.load(cx); else this.commits = [];
  }

  git(args) {
    const { root, on } = props();
    return exec("git", ["--no-pager", "-c", "core.quotepath=off", ...args], { cwd: root, on: on ?? undefined, timeout: 60000 });
  }

  load(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const scope = this.all ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"];
        const r = await this.git(["log", ...scope, "--date-order", "-n", String(this.limit + 1),
          `--format=%H${SEP}%P${SEP}%D${SEP}%an${SEP}%ae${SEP}%at${SEP}%s${END}`]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git log failed");
        const commits = r.stdout.split(END).map((s) => s.replace(/^\n/, "")).filter(Boolean).map((line) => {
          const [hash, parents, refs, author, email, at, subject] = line.split(SEP);
          return { hash, parents: parents ? parents.split(" ") : [], refs: parseRefs(refs), author, email, at: Number(at), subject };
        });
        this.more = commits.length > this.limit;
        this.commits = commits.slice(0, this.limit);
        // Parents past the last loaded commit still draw their lanes down to the bottom.
        this.graph = layout(this.commits);
        this.error = null;
        // Keep the selected commit across reloads; else start at HEAD.
        let at = this.picked ? this.commits.findIndex((c) => c.hash === this.picked) : -1;
        if (at < 0) at = this.commits.findIndex((c) => c.refs.some((x) => x.kind === "head"));
        this.selected = null;
        this.select(Math.max(0, at), cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.commits = this.commits ?? [];
      }
      this.loading = false;
      cx.notify();
    });
  }

  select(i, cx) {
    if (!this.commits?.length) return;
    i = Math.max(0, Math.min(this.commits.length - 1, i));
    this.selected = i;
    this.reveal(i);
    const c = this.commits[i];
    this.picked = c.hash;
    if (this.details?.hash === c.hash) return;
    this.details = { hash: c.hash, body: null, files: null };
    cx.spawn(async (cx) => {
      const [body, files] = await Promise.all([
        this.git(["show", "-s", "--format=%B", c.hash]),
        // Against the first parent, as most tools show a merge; the root commit against nothing.
        this.git(c.parents.length ? ["diff-tree", "-r", "--name-status", "-M", "--no-commit-id", c.parents[0], c.hash]
          : ["diff-tree", "-r", "--root", "--name-status", "-M", "--no-commit-id", c.hash]),
      ]).catch((e) => [{ stdout: "" }, { stdout: "", stderr: String(e) }]);
      if (this.details?.hash !== c.hash) return;
      this.details.body = body.stdout.trim();
      this.details.files = files.stdout.split("\n").filter(Boolean).map((l) => {
        const parts = l.split("\t");
        const status = parts[0][0];
        return { status, path: parts[parts.length - 1], from: parts.length > 2 ? parts[1] : null };
      });
      cx.notify();
    });
    cx.notify();
  }

  total() { return (this.commits?.length ?? 0) + (this.more ? 1 : 0); }
  maxOffset() { return Math.max(0, this.total() * ROW - this.viewH); }
  scrollTo(px) { this.offset = Math.max(0, Math.min(this.maxOffset(), px)); }
  // Scrolls only as far as needed to show row i.
  reveal(i) {
    if (i * ROW < this.offset) this.scrollTo(i * ROW);
    else if ((i + 1) * ROW > this.offset + this.viewH) this.scrollTo((i + 1) * ROW - this.viewH);
  }

  // Opens a file of the selected commit in the side-by-side compare, every file of it a step away.
  compare(index) {
    const c = this.commits[this.selected];
    const { root, on } = props();
    const short = c.hash.slice(0, 7);
    const base = c.parents[0] ?? "none";
    const files = this.details.files.map((f) => ({
      path: f.path, status: f.status,
      left: f.status === "A" || base === "none" ? "none" : base, right: f.status === "D" ? "none" : c.hash,
      leftLabel: base === "none" ? "Nothing" : base.slice(0, 7), rightLabel: short,
    }));
    openOverlay({ mod: "diff-view", kind: "dialog", width: 0.94, height: 0.92, props: { root, on, files, index } });
  }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); return; }
    if (k === "down" || k === "j") this.select((this.selected ?? -1) + 1, cx);
    else if (k === "up" || k === "k") this.select((this.selected ?? 1) - 1, cx);
    else if (k === "pagedown") this.select((this.selected ?? 0) + 20, cx);
    else if (k === "pageup") this.select((this.selected ?? 0) - 20, cx);
    else return;
    cx.stop_propagation();
  }

  palette(t) {
    // Vivid on purpose, whatever the theme: lanes have to stand apart at a glance.
    return ["#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000", "#00d9cc", "#e138e8", "#85d900", "#dc5b23", "#6f24d6", "#ffcc00"];
  }

  lines(row, colors, t, selected) {
    const x = (k) => k * LANE + LANE / 2;
    const color = (k) => colors[k % colors.length];
    const width = this.graph.lanes * LANE + 4;
    const merge = this.commits[row.i].parents.length > 1;
    const el = div().relative().w(width).h(ROW).flex_none().overflow_hidden();
    const R = ROW / 2;
    for (const s of row.segs) {
      if (s.v !== undefined) {
        el.child(div().absolute().left(x(s.v) - LINE / 2).top(Math.round(s.from * ROW)).w(LINE).h(Math.round((s.to - s.from) * ROW)).bg(color(s.c)));
      } else if (s.h) {
        const [a, b] = s.h;
        el.child(div().absolute().left(Math.min(x(a), x(b)) - LINE / 2).top(ROW / 2 - LINE / 2).w(Math.abs(x(a) - x(b)) + LINE).h(LINE).bg(color(s.c)));
      } else {
        // A rounded elbow: a box between the two lanes with two of its sides drawn and the
        // corner between them rounded. fork: across at mid-row, then down lane k; join:
        // down lane k from the top, then across to the commit at mid-row.
        const k = s.fork ?? s.join, other = s.fork !== undefined ? s.from : s.to, right = k > other;
        const left = Math.min(x(k), x(other)) - LINE / 2, w = Math.abs(x(k) - x(other)) + LINE;
        let box = div().absolute().left(left).w(w).h(R + LINE / 2).border_color(color(s.c));
        if (s.fork !== undefined) {
          box = box.top(R - LINE / 2).border_t(LINE);
          box = right ? box.border_r(LINE).rounded_tr(R) : box.border_l(LINE).rounded_tl(R);
        } else {
          box = box.top(0).border_b(LINE);
          box = right ? box.border_r(LINE).rounded_br(R) : box.border_l(LINE).rounded_bl(R);
        }
        el.child(box);
      }
    }
    const c = color(row.lane);
    return el.child(div().absolute().left(x(row.lane) - DOT / 2).top(ROW / 2 - DOT / 2).size(DOT).rounded(DOT / 2).bg(c));
  }

  badge(r, t) {
    const tint = { head: t.accent, local: t.ansi2, remote: t.ansi4, tag: t.ansi3 }[r.kind];
    return h_flex().h(17).px(6).gap(4).flex_none().items_center().rounded(4).border_1().border_color(tint).text_size(10.5)
      .text_color(r.kind === "head" ? t.accent_foreground : tint).when(r.kind === "head", (e) => e.bg(t.accent).font_semibold())
      .when(r.kind === "tag", (e) => e.child(icon("tag", 10)))
      .when(r.kind === "remote", (e) => e.child(icon("cloud", 10)))
      .child(div().max_w(160).truncate().child(r.name));
  }

  row(i, colors, t) {
    const c = this.commits[i];
    const sel = i === this.selected;
    const g = this.graph.rows[i];
    return h_flex().id(`c-${i}`).h(ROW).w_full().pr(12).gap(10).items_center().cursor_pointer()
      .when(sel, (e) => e.bg(t.selected))
      .when(!sel, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.handle.focus(); this.select(i, cx); })
      .child(div().pl(8).flex_none().child(this.lines({ ...g, i }, colors, t, sel)))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .children(c.refs.map((r) => this.badge(r, t)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject || "(no message)")))
      .child(div().w(130).flex_none().truncate().text_color(t.muted).child(c.author))
      .child(div().w(104).flex_none().truncate().text_color(t.dim).child(ago(c.at)))
      .child(div().w(58).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.dim).child(c.hash.slice(0, 7)));
  }

  side(t) {
    const c = this.commits?.[this.selected];
    if (!c) return null;
    const d = this.details;
    const STATUS = { A: ["A", t.ansi2], M: ["M", t.ansi3], D: ["D", t.ansi1], R: ["R", t.ansi4], C: ["C", t.ansi4], T: ["T", t.ansi3] };
    const mono = settings().font_family ?? "JetBrains Mono";
    const field = (label, value) => h_flex().gap(8).child(div().w(58).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(value));
    return v_flex().w(400).flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.surface)
      .child(v_flex().p(14).gap(6).flex_none().text_size(12)
        .child(field("Commit", div().font_family(mono).child(c.hash)))
        .child(field("Author", `${c.author} <${c.email}>`))
        .child(field("Date", `${new Date(c.at * 1000).toLocaleString()} · ${ago(c.at)}`))
        .when(c.parents.length > 0, (e) => e.child(field(c.parents.length > 1 ? "Parents" : "Parent",
          div().font_family(mono).child(c.parents.map((p) => p.slice(0, 7)).join("  ")))))
        .when(c.refs.length > 0, (e) => e.child(h_flex().pt(2).gap(4).flex_wrap().children(c.refs.map((r) => this.badge(r, t))))))
      .child(div().mx(14).h(1).flex_none().bg(t.border))
      .child(v_flex().id("detail-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().px(14).py(12).text_size(12.5).line_height("19px").text_color(t.foreground)
          .child(d?.body ?? c.subject))
        .child(h_flex().px(14).pb(6).pt(4).text_size(11).font_semibold().text_color(t.muted)
          .child(d?.files ? `${d.files.length} FILE${d.files.length === 1 ? "" : "S"} CHANGED${c.parents.length > 1 ? " (vs first parent)" : ""}` : "FILES"))
        .when(!d?.files, (e) => e.child(h_flex().px(14).gap(8).items_center().text_size(12).text_color(t.dim)
          .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child("Reading…")))
        .when(Boolean(d?.files), (e) => e.child(v_flex().px(6).pb(12).children(d.files.map((f, i) => {
          const [letter, tint] = STATUS[f.status] ?? [f.status, t.muted];
          const slash = f.path.lastIndexOf("/");
          return h_flex().id(`f-${i}`).h(24).px(8).gap(8).items_center().rounded(5).cursor_pointer().text_size(12)
            .hover((s) => s.bg(t.hover)).on_click(() => this.compare(i))
            .child(div().flex_1().min_w(0).truncate()
              .child(h_flex().gap(6).child(div().flex_none().text_color(t.foreground).child(f.path.slice(slash + 1)))
                .child(div().min_w(0).truncate().text_color(t.dim).child(f.from ? `${f.from} →` : f.path.slice(0, Math.max(0, slash))))))
            .child(div().w(12).flex_none().text_color(tint).font_semibold().child(letter));
        })))));
  }

  setScope(all, cx) {
    if (this.all === all) return;
    this.all = all;
    try { localStorage.setItem("scope", all ? "all" : "current"); } catch {}
    this.picked = null; this.details = null; this.limit = PAGE; this.offset = 0;
    this.load(cx);
    cx.notify();
  }

  list(el, n, colors, t) {
    const total = this.total();
    if (this.offset > this.maxOffset()) this.scrollTo(this.offset);
    const first = Math.floor(this.offset / ROW), last = Math.min(total, Math.ceil((this.offset + this.viewH) / ROW) + 1);
    const rows = [];
    for (let i = first; i < last; i++) {
      if (i < n) rows.push(this.row(i, colors, t));
      else rows.push(h_flex().id("more").h(ROW).w_full().px(16).flex_none().items_center().cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.limit += PAGE; this.load(cx); }).child(`Load ${PAGE} more…`));
    }
    const thumbH = Math.max(28, this.viewH * Math.min(1, this.viewH / Math.max(1, total * ROW)));
    const thumbTop = this.maxOffset() ? (this.offset / this.maxOffset()) * (this.viewH - thumbH) : 0;
    return el.overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - this.viewH) > 1) { this.viewH = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => { this.scrollTo(this.offset - (e.delta?.y ?? 0)); cx.stop_propagation(); cx.notify(); })
      .child(v_flex().absolute().left(0).right(0).top(first * ROW - this.offset).children(rows))
      .when(total * ROW > this.viewH, (e) => e.child(div().id("graph-scrollbar").absolute().top(0).bottom(0).right(0).w(10)
        .on_mouse_down("left", (ev, cx) => {
          cx.stop_propagation();
          const y = ev.position.y;
          this.drag = { y, offset: this.offset, ratio: this.maxOffset() / Math.max(1, this.viewH - thumbH) };
          cx.notify();
        })
        .child(div().absolute().right(2).w(6).top(thumbTop).h(thumbH).rounded(3).bg(this.drag ? t.muted : t.border))));
  }

  render() {
    const t = theme();
    const root = props()?.root ?? "";
    const colors = this.palette(t);
    const n = this.commits?.length ?? 0;
    const pill = (id, label, on, click) => div().id(id).px(9).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.raised)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => click(cx)).child(label);
    const button = (id, name, tip, click) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => click(cx)).child(icon(name, 15));
    return v_flex().id("git-graph").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.scrollTo(this.drag.offset + (e.position.y - this.drag.y) * this.drag.ratio);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(44).flex_none().pl(16).pr(10).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(icon("graph", 16))
        .child(div().text_size(13.5).font_semibold().child("Git graph"))
        .child(div().min_w(0).truncate().text_color(t.dim).child(root.split("/").pop()))
        .child(h_flex().ml(6).p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(pill("scope-all", "All branches", this.all, (cx) => this.setScope(true, cx)))
          .child(pill("scope-head", "Current branch", !this.all, (cx) => this.setScope(false, cx))))
        .child(div().flex_1())
        .when(this.loading, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.working).spin(900)))
        .child(div().text_size(11).text_color(t.dim).child(`${n}${this.more ? "+" : ""} commits · ↑↓ to move · Esc`))
        .child(button("refresh", "refresh", "Refresh", (cx) => { this.details = null; this.load(cx); }))
        .child(button("close", "close", "Close", () => closeOverlay(props().overlay))))
      .when(Boolean(this.error), (e) => e.child(div().px(16).py(10).text_color(t.blocked).child(this.error)))
      // h_flex centers its children, so the list column would be as tall as its content (0 for
      // a virtual list): pin the body to the space left and let the columns fill it.
      .child(div().flex_1().min_h(0).relative().child(h_flex().absolute().inset_0().items_start()
        .child(v_flex().flex_1().min_w(0).h_full()
          .child(h_flex().h(26).flex_none().pr(12).gap(10).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
            .child(div().pl(8).w(this.graph.lanes * LANE + 12).flex_none().child("Graph"))
            .child(div().flex_1().child("Description"))
            .child(div().w(130).flex_none().child("Author"))
            .child(div().w(104).flex_none().child("Date"))
            .child(div().w(58).flex_none().child("Commit")))
          .child(div().flex_1().min_h(0).w_full().relative()
            .when(this.commits === null, (e) => e.child(h_flex().p(16).gap(8).items_center().text_color(t.dim)
              .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child("Reading history…")))
            .when(n > 0, (e) => this.list(e, n, colors, t))
            .when(n === 0 && this.commits !== null && !this.error, (e) => e.child(div().p(16).text_color(t.dim).child("No commits yet.")))))
        .when(n > 0, (e) => e.child(this.side(t)))));
  }
}
