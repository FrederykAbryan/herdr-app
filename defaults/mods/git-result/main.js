// Why a git action from the Changes panel failed: the panel opens this as a dialog with
// props { title, hint, detail, command }. `detail` is everything git printed (stdout and
// stderr), `hint` a plain-words next step for the errors people meet most (push rejected,
// merge conflicts, diverged branches, auth). Copy puts the whole output on the clipboard.
// Enter or Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, settings } from "herdr";

export default class GitResult extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { closeOverlay(props()?.overlay); }

  render(cx) {
    const t = theme(), p = props() ?? {};
    const lines = String(p.detail ?? "").replace(/\r/g, "").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const mono = settings().font_family ?? "JetBrains Mono";
    const button = (id, label, solid, onClick) => h_flex().id(id).h(30).px(14).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(solid ? t.solid : t.input).bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("git-result").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "escape") { cx.stop_propagation(); this.close(); }
      })
      .size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13)
      .child(h_flex().gap(10).items_center()
        .child(div().size(10).rounded(5).flex_none().bg(t.blocked))
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "Git failed"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(p.command), (el) => el.child(div().text_size(11.5).text_color(t.dim).font_family(mono).truncate().child(`$ ${p.command}`)))
      .when(Boolean(p.hint), (el) => el.child(h_flex().gap(8).px(10).py(8).rounded(6).bg(t.raised).items_start()
        .child(div().flex_none().font_semibold().text_color(t.accent).child("What to do:"))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(p.hint))))
      .child(v_flex().id("git-result-out").flex_1().min_h(0).px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.background)
        .overflow_y_scrollbar()
        .children((lines.length ? lines : ["(git printed nothing)"]).map((l) =>
          div().font_family(mono).text_size(12).line_height("17px").text_color(/^(error|fatal|CONFLICT|!|hint: Updates were rejected)/i.test(l.trim()) ? t.ansi1 : t.muted).child(l || " "))))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("git-result-copy", this.copied ? "Copied" : "Copy output", false, (_e, cx) => { cx.write_to_clipboard(p.detail ?? ""); this.copied = true; cx.notify(); }))
        .child(button("git-result-ok", "OK", true, () => this.close())));
  }
}
