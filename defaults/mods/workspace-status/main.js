import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { spaces, agents, theme, run, window, keys, focused, panes, exec, openOverlay, closeOverlay, props, notify } from "herdr";

// The folder this mod's popup opens itself from (a clone renames it).
const SELF = "workspace-status";

// Where the active space's repo is: its focused pane's folder, else its first terminal's, else where it was made.
function where(space) {
  const f = focused();
  if (f?.space === space.id && f.cwd) return f.cwd;
  return panes().find(p => p.space === space.id && p.cwd)?.cwd ?? space.folder;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (!props()?.branchMenu) return;
    // The branch popup: a filter and the repo's branches, newest commit first.
    this.filter = "";
    this.at = 0;
    this.branches = null;
    this.busy = false;
    this.error = null;
    this.input = InputState.new({ placeholder: "Switch to a branch, or type a new name…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.load(cx);
  }

  load(cx) {
    const { folder, machine } = props();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["for-each-ref", "--sort=-committerdate",
          "--format=%(refname)%09%(refname:short)%09%(committerdate:relative)%09%(HEAD)", "refs/heads", "refs/remotes"],
          { cwd: folder, on: machine });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "not a git repository");
        const all = r.stdout.split("\n").filter(Boolean).map(line => {
          const [ref, name, when, head] = line.split("\t");
          return { remote: ref.startsWith("refs/remotes/"), name, when, current: head === "*" };
        }).filter(b => !(b.remote && (b.name.endsWith("/HEAD") || !b.name.includes("/"))));
        const local = new Set(all.filter(b => !b.remote).map(b => b.name));
        // A remote branch already checked out locally is the local one.
        this.branches = all.filter(b => !b.remote || !local.has(b.name.slice(b.name.indexOf("/") + 1)));
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.branches = [];
      }
      cx.notify();
    });
  }

  rows() {
    const q = this.filter.trim();
    const list = (this.branches ?? []).filter(b => b.name.toLowerCase().includes(q.toLowerCase()));
    const exact = (this.branches ?? []).some(b => b.name === q || (b.remote && b.name.endsWith(`/${q}`)));
    return q && !exact && !/\s/.test(q) ? [...list, { create: true, name: q }] : list;
  }

  pick(row, cx) {
    if (!row || this.busy) return;
    const { folder, machine, overlay } = props();
    if (row.current) return closeOverlay(overlay);
    const args = row.create ? ["switch", "-c", row.name]
      : row.remote ? ["switch", "--track", row.name]
      : ["switch", row.name];
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: folder, on: machine, timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args.join(" ")} failed`);
        closeOverlay(overlay);
        notify({ title: `Switched to ${row.create || !row.remote ? row.name : row.name.slice(row.name.indexOf("/") + 1)}`, level: "success", timeout: 2500 });
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  menu(t) {
    const rows = this.rows();
    const at = Math.min(this.at, Math.max(0, rows.length - 1));
    const row = (b, i) => h_flex().id(`br-${i}`).h(28).px(10).gap(8).items_center().rounded(6).flex_none().cursor_pointer()
      .when(i === at, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.pick(b, cx); })
      .child(svg(`mods/workspace-chrome/${b.create ? "plus" : b.current ? "check" : "git-branch"}.svg`).size(13).flex_none()
        .text_color(b.current ? t.accent : t.dim))
      .child(div().flex_1().truncate().text_color(b.current ? t.foreground : b.remote ? t.muted : t.foreground)
        .child(b.create ? `Create branch “${b.name}”` : b.name))
      .when(Boolean(b.when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(b.when)));
    // A popup is as tall as its content: the list needs a height of its own, not flex_1.
    return v_flex().id("branch-menu").w_full().p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); return; }
        if (!rows.length) return;
        if (k === "down") this.at = (at + 1) % rows.length;
        else if (k === "up") this.at = (at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(Input.new(this.input).h(32).px(10).flex_none().rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(Boolean(this.error), el => el.child(div().px(4).text_size(11.5).text_color(t.blocked).child(this.error)))
      .when(this.branches === null || this.busy, el => el.child(h_flex().px(6).py(6).gap(8).items_center().text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
        .child(this.busy ? "Switching…" : "Reading branches…")))
      .when(this.branches !== null && !this.busy, el => el.child(v_flex().id("branch-list").max_h(290).gap(1).overflow_y_scrollbar()
        .children(rows.map(row))
        .when(rows.length === 0 && !this.error, el => el.child(div().px(6).py(6).text_color(t.dim).child("No branches match.")))));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    if (props()?.branchMenu) return this.menu(t);
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const openBranches = () => openOverlay({ mod: SELF, kind: "popup", at: "pointer", width: 340, height: 360,
      props: { branchMenu: true, folder: where(space), machine: space.machine ?? undefined } });
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)
        .id("branch").px(6).mx(-6).h(20).rounded(5).cursor_pointer()
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Switch branch")
        .on_click(openBranches)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
