// Grid menu: splits the focused pane into a layout of several terminals or agents at once.
// Each pane is its own terminal; the Changes panel follows whichever one has focus.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { panes, focused, exec, knownAgents, run, theme, props, closeOverlay } from "herdr";

// Each shape is the splits that make it from one pane, A: [pane to split, direction], where
// a pane is A or the result of an earlier step (1, 2, ...). Halving keeps every pane equal.
const SHAPES = [
  { id: "cols", label: "2 side by side", steps: [["A", "right"]], cells: [[0, 0, 1, 2], [1, 0, 1, 2]] },
  { id: "rows", label: "2 stacked", steps: [["A", "down"]], cells: [[0, 0, 2, 1], [0, 1, 2, 1]] },
  { id: "main", label: "1 + 2", steps: [["A", "right"], [1, "down"]], cells: [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]] },
  { id: "grid", label: "2 × 2", steps: [["A", "right"], ["A", "down"], [1, "down"]], cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
];

// The app's `run` gives nothing back; `herdr-app do` prints the new pane, which the next
// split of a shape needs.
async function split(pane, direction, argv) {
  const r = await exec("herdr-app", ["do", "pane.split", JSON.stringify({ direction, pane, ...(argv ? { argv } : {}) })]);
  const out = JSON.parse(r.stdout || "{}");
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `exit code ${r.code}`);
  return out.pane;
}

export default class PaneGrid extends View {
  init(_props, cx) {
    this.agents = [];
    try { this.run = JSON.parse(localStorage.getItem("run") ?? "null"); } catch { this.run = null; }
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((a) => a.installed).slice(0, 5); } catch { this.agents = []; }
      cx.notify();
    });
  }

  choose(agent, cx) {
    this.run = agent ? { key: agent.key, name: agent.name, run: agent.run } : null;
    try { localStorage.setItem("run", JSON.stringify(this.run)); } catch {}
    cx.notify();
  }

  build(shape, cx) {
    const start = focused()?.pane;
    if (!start || !panes().some((p) => p.pane === start)) { this.error = "Click a terminal first: the grid starts from the focused pane"; cx.notify(); return; }
    this.busy = shape.id; this.error = null;
    const argv = this.run?.run ?? null;
    cx.spawn(async (cx) => {
      try {
        const made = [];
        for (const [from, direction] of shape.steps) made.push(await split(from === "A" ? start : made[from - 1], direction, argv));
        run("pane.focus", { pane: start });
        closeOverlay(props().overlay);
      } catch (e) { this.error = `Could not split: ${e?.message ?? e}`; }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  // A small drawing of the shape: its cells in a 2 × 2 box.
  preview(shape, t, on) {
    return div().w(46).h(32).flex_none().relative().rounded(4).border_1().border_color(on ? t.accent : t.input)
      .children(shape.cells.map(([x, y, w, h]) => div().absolute().left(2 + x * 21).top(2 + y * 14).w(w * 21 - 2).h(h * 14 - 2).rounded(2).bg(on ? t.accent + "66" : t.dim + "55")));
  }

  render() {
    const t = theme(), tab = focused()?.tab, count = panes().filter((p) => p.tab === tab).length;
    const title = (s) => div().px(8).pt(6).pb(4).text_size(11).text_color(t.dim).child(s);
    const choice = (id, label, pic, on, pick) => h_flex().id(id).h(28).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(t.foreground).hover((e) => e.bg(t.hover)).on_click((_e, cx) => pick(cx))
      .child(div().w(14).flex_none().flex().justify_center().child(pic ?? ""))
      .child(div().flex_1().truncate().child(label))
      .when(on, (e) => e.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none()));
    const icon = (p) => p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.foreground) : image(p.icon).size(14)) : null;
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(title(count > 1 ? `Split the focused pane (this tab has ${count})` : "Split this tab into"))
      .child(h_flex().px(4).gap(6).flex_wrap().children(SHAPES.map((s) => v_flex().id(`shape-${s.id}`).w(86).p(6).gap(5).items_center().rounded(8).cursor_pointer()
        .hover((e) => e.bg(t.hover)).on_click((_e, cx) => this.build(s, cx))
        .child(this.preview(s, t, this.busy === s.id))
        .child(div().text_size(11).text_color(t.muted).child(this.busy === s.id ? "Opening…" : s.label)))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(title("New panes run"))
      .child(choice("run-shell", "Terminal", svg("icons/shell.svg").size(14), !this.run, (cx) => this.choose(null, cx)))
      .children(this.agents.map((a) => choice(`run-${a.key}`, a.name, icon(a), this.run?.key === a.key, (cx) => this.choose(a, cx))))
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(6).text_size(11).text_color(t.ansi1).child(this.error)));
  }
}
