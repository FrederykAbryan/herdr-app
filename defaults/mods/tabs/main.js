import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";
import { discover, current, runningTab, start, stop as stopScript, show } from "./run.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Full screen: the panes take the whole window. Hides the sidebar, side panel and status bar
// and maximizes the window, remembering which were shown (shared, so it survives a restart)
// to put back exactly that.
const FULL = "workspace.fullscreen";
const CHROME = ["sidebar", "panel", "status"];
function toggleFullscreen() {
  const root = layout(), was = shared(FULL);
  if (!was) {
    const saved = Object.fromEntries(CHROME.map((id) => [id, Boolean(find(root, id)) && !find(root, id).hidden]));
    saved.maximized = Boolean(window()?.maximized);
    setShared(FULL, saved);
    for (const id of CHROME) if (saved[id]) run("layout.hide", { id });
    if (!saved.maximized) run("window.maximize");
  } else {
    setShared(FULL, null);
    for (const id of CHROME) if (was[id]) run("layout.show", { id });
    if (!was.maximized && window()?.maximized) run("window.maximize");
  }
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.project = null;
    this.detect(cx);
    cx.timer.every(2500, (cx) => this.detect(cx));
  }

  // The focused pane's project for the Run button: looked up again when the pane's folder
  // changes, and every 15 s (scripts added to package.json).
  detect(cx) {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const cwd = pane?.cwd || f?.cwd || space?.folder, on = space?.machine ?? null;
    const key = JSON.stringify([cwd, on]);
    if (!cwd || this.looking || (key === this.projectKey && Date.now() - this.looked < 15000)) return;
    this.looking = true;
    cx.spawn(async (cx) => {
      try {
        const info = await discover(cwd, on);
        if (JSON.stringify(info) !== JSON.stringify(this.project)) { this.project = info; cx.notify(); }
        this.projectKey = key; this.looked = Date.now();
      } catch {} finally { this.looking = false; }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    // In full screen a space switch doesn't bring the panel back; a click on Files or Changes still does.
    if (!space || !panel || shared(FULL)) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = c.named ? c.name : program?.name ?? "Terminal";
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // Run: ▷ starts the project's script in its own tab (■ stops it while it runs), the name shows
    // that tab, the chevron lists every script.
    const info = this.project, c = info ? current(info) : null, live = c ? runningTab(info, c) : null;
    const runColor = settings().dark === false ? { run: t.ansi2, stop: t.ansi1 } : { run: "#3fb950", stop: "#f85149" };
    const runButton = () => h_flex().id("run").h(26).flex_none().items_center().rounded(6).border(1).border_color(t.border).text_size(12)
      .child(div().id("run-go").h_full().pl(7).pr(5).flex().items_center().rounded(6).text_color(live ? runColor.stop : runColor.run)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .tooltip(live ? `Stop ${c.text}` : `Run ${c.text}`)
        .on_click((_e, cx) => { if (live) stopScript(info, c); else cx.spawn(async () => { await start(info, c, space?.id); }); })
        .child(svg(`mods/tabs/run-${live ? "stop" : "play"}.svg`).size(13)))
      .child(div().id("run-name").h_full().pr(8).flex().items_center().gap(5).text_color(live ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .tooltip(live ? `Show the ${c.label} tab` : `${info.kind}: ${c.text}`)
        .on_click((_e, cx) => { if (live) show(info, c); else cx.spawn(async () => { await start(info, c, space?.id); }); })
        .child(div().max_w(120).truncate().child(c.label.charAt(0).toUpperCase() + c.label.slice(1)))
        .when(Boolean(live), (el) => el.child(div().size(6).rounded(3).bg(runColor.run))))
      .child(div().w(1).h(14).bg(t.border))
      .child(div().id("run-more").h_full().w(22).flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).tooltip(`${info?.kind ?? ""} commands`)
        .on_click(() => openOverlay({ mod: "run-menu", kind: "popup", width: 320, props: { info, space: space?.id } }))
        .child(svg("mods/files/chevron-down.svg").size(12)));
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .when(Boolean(c), el => el.child(runButton()).child(div().w(6).flex_none()))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(button("pane-grid", svg("mods/tabs/scm-layout.svg").size(15), () => openOverlay({ mod: "pane-grid", kind: "popup", width: 392, height: 360 })).tooltip("Split into a grid"))
      .child(button("fullscreen", svg(`mods/tabs/scm-screen-${shared(FULL) ? "normal" : "full"}.svg`).size(15), toggleFullscreen)
        .when(Boolean(shared(FULL)), (e) => e.bg(t.selected).text_color(t.foreground)).tooltip(shared(FULL) ? "Leave full screen" : "Full screen"))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
