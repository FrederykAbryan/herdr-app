import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, run, closeOverlay, theme, setShared } from "herdr";

// A tab being dragged, browser style. The tab bar opens this as a transparent window over the
// whole app once a pressed tab moves, so the tab can follow the pointer anywhere (a mod only
// hears the pointer over its own block). It draws the tab row on top of the real one: the other
// tabs slide aside to show where it lands, and resting on the middle of a tab offers to Join.
// Dropping off the row puts it back. Everything in props is in window pointer px.
//
// props: { tabs: [{ id, name, icon, tint, status, active, zoomed }], i, W, lefts, top, h,
//          row: { x, y, w, h }, grab: { x, y }, start: { x, y }, gap, z, overlay }
const ICON = "mods/tab-drag/scm-layout.svg";
const JOIN_DELAY = 280; // ms resting on a tab's middle before it offers to join
const BAND = 26; // px above and below the row that still count as on it

export default class TabDrag extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = { ...(p.start ?? { x: 0, y: 0 }) };
    this.origin = { x: 0, y: 0 };
    this.to = p.i;
    this.join = null;
    this.pending = null;
    this.onRow = true;
    this.done = false;
    this.last = Date.now();
    this.h = cx.focus_handle();
    cx.timer.after(30, () => this.h.focus());
    // A release outside the window never reaches us: give up when the pointer has gone quiet.
    cx.timer.every(1000, (cx) => { if (Date.now() - this.last > 8000) this.finish(false, cx); });
  }

  finish(drop, cx) {
    if (this.done) return;
    this.done = true;
    const p = props(), source = p.tabs[p.i].id;
    if (drop && this.join !== null) setShared("tabs.join", { source, target: p.tabs[this.join].id, seq: Date.now() });
    else if (drop && this.onRow && this.to !== p.i) run("tab.move", { id: source, index: this.to + 1 });
    closeOverlay(p.overlay);
    cx?.notify();
  }

  move(e, cx) {
    if (this.done) return;
    this.last = Date.now();
    if (e && "pressed_button" in e && e.pressed_button == null) return this.finish(true, cx);
    if (e.local_position) this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
    this.p = { x: e.position.x, y: e.position.y };
    const p = props(), { x, y } = this.p, n = p.tabs.length;
    const mid = (j) => p.lefts[j] + p.W[j] / 2;
    this.onRow = y >= p.row.y - BAND && y <= p.row.y + p.row.h + BAND;
    let zone = null;
    if (this.onRow) for (let j = 0; j < n; j++) if (j !== p.i && Math.abs(x - mid(j)) < p.W[j] * 0.25) zone = j;
    if (zone === null) { this.pending = null; this.join = null; }
    else if (zone !== this.join && this.pending !== zone) {
      this.pending = zone; this.join = null;
      cx.timer.after(JOIN_DELAY, (cx) => { if (!this.done && this.pending === zone) { this.join = zone; this.pending = null; cx.notify(); } });
    }
    // Where it would land: past the middle of a tab (not the one it's resting on).
    let to = p.i;
    if (this.onRow) {
      for (let j = p.i + 1; j < n; j++) if (j !== zone && x > mid(j)) to = j;
      for (let j = p.i - 1; j >= 0; j--) if (j !== zone && x < mid(j)) to = j;
    }
    this.to = to;
    cx.notify();
  }

  face(t, tab, w, z) {
    return h_flex().h(props().h / z).w(w / z).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8).border(1)
      .when(Boolean(tab.icon), (el) => el.child(tab.tint ? svg(tab.icon).size(14).flex_none().text_color(t.muted) : image(tab.icon).size(14).flex_none()))
      .child(div().flex_1().min_w(0).truncate().child(tab.zoomed ? `${tab.name} Z` : tab.name))
      .when(tab.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(tab.status === "blocked" || tab.status === "done", (el) => el.child(div().size(6).flex_none().rounded(3).bg(t[tab.status])));
  }

  render() {
    const t = theme(), p = props(), o = this.origin;
    if (!p?.tabs?.[p.i]) return div();
    const z = p.z;
    const room = p.W[p.i] + p.gap;
    const row = div().absolute().left((p.row.x - o.x) / z).top((p.row.y - o.y) / z).w(p.row.w / z).h(p.row.h / z)
      .bg(t.chrome).overflow_hidden()
      .children(p.tabs.map((tab, j) => {
        if (j === p.i) return div().id(`slot-${tab.id}`);
        const shift = j > p.i && j <= this.to ? -room : j < p.i && j >= this.to ? room : 0;
        const joining = this.join === j;
        return this.face(t, tab, p.W[j], z).id(`slot-${tab.id}`).absolute()
          .left((p.lefts[j] - p.row.x + shift) / z).top((p.top - p.row.y) / z).transition("left", 160)
          .border_color(joining ? t.accent : tab.active ? t.border : t.chrome)
          .bg(joining ? `${t.accent}2e` : tab.active ? t.raised : t.chrome)
          .text_color(joining || tab.active ? t.foreground : t.muted)
          .when(joining, (el) => el.child(h_flex().flex_none().gap(4).px(6).h(18).rounded(5).items_center().bg(t.accent)
            .text_color(t.accent_foreground).text_size(11).font_semibold().child(svg(ICON).size(11)).child("Join")));
      }));
    const lifted = this.face(t, p.tabs[p.i], p.W[p.i], z).id("lifted").absolute()
      .left((this.p.x - p.grab.x - o.x) / z).top((this.p.y - p.grab.y - o.y) / z)
      .border_color(t.accent).bg(t.raised).text_color(t.foreground).shadow_lg()
      .opacity(this.join !== null ? 0.75 : this.onRow ? 1 : 0.9);
    return div().id("root").size_full().relative().cursor_grabbing().track_focus(this.h)
      .on_key_down((e, cx) => { if (e.key === "escape") this.finish(false, cx); })
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_mouse_up("left", (e, cx) => { this.move(e, cx); this.finish(true, cx); })
      // A press while dragging means the release was missed somewhere: drop where it is.
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.finish(true, cx); })
      .on_hover((hovered, cx) => { if (!hovered) this.finish(false, cx); })
      .child(row)
      .child(lifted);
  }
}
