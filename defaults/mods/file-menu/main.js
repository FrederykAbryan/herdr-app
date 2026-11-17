// A file or folder's right-click menu, as editors have: reveal it in the file manager, open it
// with its default app, a terminal in its folder, copy its path. Opened as a popup by the
// Files and Changes panels with props { path (absolute), root?, on?, dir? }.
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec } from "herdr";

const parent = (path) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

// The file manager with the item selected (FileManager1: Nautilus, Dolphin, Nemo...), else
// its folder opened. One shell, started before the popup closes: the popup's own tasks end
// with it, a started program doesn't.
const REVEAL = `uri=$(python3 -I -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$1") &&
gdbus call --session --dest org.freedesktop.FileManager1 --object-path /org/freedesktop/FileManager1 \\
  --method org.freedesktop.FileManager1.ShowItems "['$uri']" "" >/dev/null 2>&1 || setsid -f xdg-open "$2" >/dev/null 2>&1`;

function items(p) {
  const local = !p.on, rel = p.root && p.path.startsWith(`${p.root}/`) ? p.path.slice(p.root.length + 1) : null;
  return [
    ...(local ? [["Reveal in File Manager", "reveal", "folder"]] : []),
    ...(local && !p.dir ? [["Open with Default App", "open", "file-text"]] : []),
    ["Open Terminal Here", "terminal", "terminal"],
    ["Copy Path", "copy", "files"],
    ...(rel ? [["Copy Relative Path", "copy-rel", "files"]] : []),
  ].map(([label, action, icon]) => ({ label, action, icon, rel }));
}

export default class FileMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const p = props() ?? {}, it = items(p)[i];
    if (!it) return;
    const dir = p.dir ? p.path : parent(p.path);
    if (it.action === "reveal") exec("sh", ["-c", REVEAL, "sh", p.path, dir]).catch(() => {});
    else if (it.action === "open") exec("setsid", ["-f", "xdg-open", p.path]).catch(() => {});
    else if (it.action === "terminal") run("tab.new", { folder: dir });
    else if (it.action === "copy") cx.write_to_clipboard(p.path);
    else if (it.action === "copy-rel") cx.write_to_clipboard(it.rel);
    closeOverlay(p.overlay);
  }

  render(cx) {
    const t = theme(), p = props() ?? {}, list = items(p);
    return v_flex().id("file-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        // Copying is its own group, as in editors.
        .when(i > 0 && it.action === "copy", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`fm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground).cursor_pointer()
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(`mods/workspace-chrome/${it.icon}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(it.label)))));
  }
}
