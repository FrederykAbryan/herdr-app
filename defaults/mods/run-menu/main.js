// The Run button's menu (opened from the tab bar): the project's commands, grouped by where they
// come from (Laravel's artisan, its Vite assets, package.json scripts, Flutter...). Click one to
// run it (it becomes the button's command); a running one shows its tab, with restart and stop.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, settings } from "herdr";
import { current, runningTab, start, stop, show } from "./run.js";

const SELF = "mods/run-menu";
const colors = (t) => settings().dark === false ? { run: t.ansi2, stop: t.ansi1 } : { run: "#3fb950", stop: "#f85149" };

export default class RunMenu extends View {
  render() {
    const t = theme(), col = colors(t), { info, space, overlay } = props() ?? {};
    if (!info) return div();
    const close = () => closeOverlay(overlay);
    const chosen = current(info);
    const icon = (id, name, tip, color, click) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(color).tooltip(tip).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); })
      .child(svg(`${SELF}/${name}.svg`).size(13));
    const row = (c) => {
      const live = runningTab(info, c);
      return h_flex().id(`run-${c.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(c.id === chosen.id, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover)).tooltip(c.detail ? `${c.text}  →  ${c.detail}` : c.text)
        .on_click((_e, cx) => {
          close();
          if (live) show(info, c);
          else cx.spawn(async () => { await start(info, c, space); });
        })
        .child(svg(`${SELF}/run-play.svg`).size(12).flex_none().text_color(live ? col.run : t.dim))
        .child(div().flex_none().max_w(130).truncate().text_color(t.foreground).child(c.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.detail ?? c.text))
        .when(Boolean(live), (el) => el
          .child(div().flex_none().text_size(10.5).text_color(col.run).child("running"))
          .child(icon(`restart-${c.id}`, "run-play", "Restart", col.run, (cx) => { close(); cx.spawn(async () => { await start(info, c, space); }); }))
          .child(icon(`stop-${c.id}`, "run-stop", "Stop", col.stop, () => stop(info, c))));
    };
    const groups = [];
    for (const c of info.commands) {
      let g = groups.find((x) => x.name === c.group);
      if (!g) groups.push(g = { name: c.group, items: [] });
      g.items.push(c);
    }
    const list = [];
    for (const g of groups) {
      list.push(div().id(`group-${g.name}`).px(8).pt(list.length ? 8 : 2).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(g.name.toUpperCase()));
      for (const c of g.items) list.push(row(c));
    }
    return v_flex().id("run-menu").w(340).p(6).gap(2).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(8).pt(2).pb(6).gap(6).items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().child(info.dir.split("/").pop()))
        .child(div().flex_none().text_color(t.foreground).child(info.kind)))
      .child(v_flex().id("run-list").max_h(380).overflow_y_scrollbar().gap(1).pt(2).children(list))
      .child(div().px(8).pt(6).text_size(10.5).text_color(t.dim).child(`▷ runs ${chosen.text} · each command gets its own tab`));
  }
}
