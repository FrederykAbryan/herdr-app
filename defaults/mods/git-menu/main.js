// The Changes panel's ⋯ menu, as VS Code's Source Control has: pull, push, clone, checkout,
// fetch, and submenus for commit, changes, branches, remotes, stashes, tags and worktrees.
// Opened as a popup with props { root, on, owner, tree, mode, sort, preview }.
//
// A popup's own tasks end when it closes, so the menu only asks (pickers, names, confirms)
// and hands the work to the panel that opened it: shared GITOP = { owner, seq, ...op }.
// Worktrees open the shipped `worktree` dialog.
// ↑/↓ move, Enter or → opens, ← or the back row goes up, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, setShared, openOverlay, focused } from "herdr";

const GITOP = "changes.gitop";
const ICON = "mods/workspace-chrome";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

const git = (args) => ({ kind: "git", steps: [args] });
const sh = (script, args = []) => ({ kind: "sh", script, args });
const SEP = { sep: true };
// Pickers list local branches first, then remote ones, then tags (each newest first).
const KIND_ORDER = { local: 0, remote: 1, tag: 2 };

// Push and Sync publish a branch that has no upstream yet, to origin (else the first remote).
const REMOTE = `r=$(git remote | grep -qx origin && echo origin || git remote | head -n1)`;
const PUSH = `${REMOTE}
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then exec git push "$@"; fi
[ -n "$r" ] || { echo "No remote to push to: add one first (Remote › Add Remote…)" >&2; exit 1; }
exec git push -u "$r" HEAD "$@"`;
const SYNC = `${REMOTE}
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then git pull --no-edit && exec git push; fi
[ -n "$r" ] || { echo "No remote to sync with: add one first (Remote › Add Remote…)" >&2; exit 1; }
exec git push -u "$r" HEAD`;

const worktree = (action, folder) => ({
  kind: "overlay",
  overlay: { mod: "worktree", kind: "dialog", ...(action === "open" ? { width: 560, height: 480 } : { width: 460, height: 280 }), props: { space: focused()?.space, folder, action } },
});

// An item: { label, sub } opens a submenu; { label, steps?, run } asks each step, then
// run(values, p) gives the op. Steps: { pick: source, title }, { ask, value?, optional? },
// { confirm: (values) => text }.
function menus(p) {
  const check = (on) => (on ? "check" : null);
  return {
    root: [
      { label: "View & Sort", sub: "view" }, SEP,
      { label: "Pull", run: () => ({ ...git(["pull"]), label: "Pull" }) },
      { label: "Push", run: () => ({ ...sh(PUSH), label: "Push" }) },
      { label: "Clone", steps: [{ ask: "Repository URL to clone" }], run: ([url]) => ({ kind: "clone", url, label: "Clone" }) },
      { label: "Checkout to…", steps: [{ pick: "checkout", title: "Select a branch or tag to checkout" }], run: ([r]) => checkout(r) },
      { label: "Fetch", run: () => ({ ...git(["fetch"]), label: "Fetch" }) }, SEP,
      { label: "Commit", sub: "commit" },
      { label: "Changes", sub: "changes" },
      { label: "Pull, Push", sub: "sync" },
      { label: "Branch", sub: "branch" },
      { label: "Remote", sub: "remote" },
      { label: "Stash", sub: "stash" },
      { label: "Tags", sub: "tags" },
      { label: "Worktrees", sub: "worktrees" },
    ],
    view: [
      { label: "View as Tree", icon: check(p.tree), run: () => ({ kind: "view", tree: true }) },
      { label: "View as List", icon: check(!p.tree), run: () => ({ kind: "view", tree: false }) }, SEP,
      { label: "Sort by Name", icon: check(p.sort === "name"), run: () => ({ kind: "sort", sort: "name" }), hint: "List view" },
      { label: "Sort by Path", icon: check(p.sort === "path"), run: () => ({ kind: "sort", sort: "path" }), hint: "List view" },
      { label: "Sort by Status", icon: check(p.sort === "status"), run: () => ({ kind: "sort", sort: "status" }), hint: "List view" }, SEP,
      { label: "Session Changes", icon: check(p.mode === "session"), run: () => ({ kind: "mode", mode: "session" }) },
      { label: "All Changes", icon: check(p.mode === "all"), run: () => ({ kind: "mode", mode: "all" }) }, SEP,
      { label: "Diff Preview", icon: check(p.preview), run: () => ({ kind: "preview", on: !p.preview }) },
    ],
    commit: [
      { label: "Commit", run: () => ({ kind: "commit", smart: true }) },
      { label: "Commit Staged", run: () => ({ kind: "commit" }) },
      { label: "Commit All", run: () => ({ kind: "commit", all: true }) },
      { label: "Undo Last Commit", run: () => ({ kind: "undo", label: "Undo Last Commit" }) },
      { label: "Abort Rebase", run: () => ({ ...git(["rebase", "--abort"]), label: "Abort Rebase" }) }, SEP,
      { label: "Commit (Amend)", run: () => ({ kind: "commit", smart: true, amend: true }) },
      { label: "Commit Staged (Amend)", run: () => ({ kind: "commit", amend: true }) },
      { label: "Commit All (Amend)", run: () => ({ kind: "commit", all: true, amend: true }) }, SEP,
      { label: "Commit (Signed Off)", run: () => ({ kind: "commit", smart: true, signoff: true }) },
      { label: "Commit Staged (Signed Off)", run: () => ({ kind: "commit", signoff: true }) },
      { label: "Commit All (Signed Off)", run: () => ({ kind: "commit", all: true, signoff: true }) },
    ],
    changes: [
      { label: "Stage All Changes", run: () => ({ kind: "stage-all" }) },
      { label: "Stage All Tracked Changes", run: () => ({ kind: "stage-all", tracked: true }) },
      { label: "Stage All Untracked Changes", run: () => ({ kind: "stage-all", untracked: true }) },
      { label: "Unstage All Changes", run: () => ({ kind: "unstage-all" }) }, SEP,
      { label: "Discard All Changes", run: () => ({ kind: "discard-all" }) },
      { label: "Discard All Tracked Changes", run: () => ({ kind: "discard-all", tracked: true }) },
      { label: "Discard All Untracked Changes", run: () => ({ kind: "discard-all", untracked: true }) },
    ],
    sync: [
      { label: "Sync", run: () => ({ ...sh(SYNC), label: "Sync" }) }, SEP,
      { label: "Pull", run: () => ({ ...git(["pull"]), label: "Pull" }) },
      { label: "Pull (Rebase)", run: () => ({ ...git(["pull", "--rebase"]), label: "Pull (Rebase)" }) },
      { label: "Pull from…", steps: [{ pick: "remoteBranches", title: "Pick a branch to pull from" }],
        run: ([b]) => ({ ...git(["pull", b.remote, b.branch]), label: `Pull from ${b.name}` }) }, SEP,
      { label: "Push", run: () => ({ ...sh(PUSH), label: "Push" }) },
      { label: "Push to…", steps: [{ pick: "remotes", title: "Pick a remote to push to" }],
        run: ([r]) => ({ ...git(["push", "-u", r.name, "HEAD"]), label: `Push to ${r.name}` }) },
      { label: "Push (Force with Lease)", steps: [{ confirm: () => "Force push this branch? Commits on the remote that you don't have are lost, unless someone pushed since your last fetch." }],
        run: () => ({ ...git(["push", "--force-with-lease"]), label: "Force push" }) }, SEP,
      { label: "Fetch", run: () => ({ ...git(["fetch"]), label: "Fetch" }) },
      { label: "Fetch (Prune)", run: () => ({ ...git(["fetch", "--prune"]), label: "Fetch (Prune)" }) },
      { label: "Fetch From All Remotes", run: () => ({ ...git(["fetch", "--all"]), label: "Fetch From All Remotes" }) },
    ],
    branch: [
      { label: "Merge…", steps: [{ pick: "branches", title: "Select a branch to merge into the current one" }],
        run: ([b]) => ({ ...git(["merge", "--no-edit", b.name]), label: `Merge ${b.name}` }) },
      { label: "Rebase Branch…", steps: [{ pick: "branches", title: "Select a branch to rebase onto" }],
        run: ([b]) => ({ ...git(["rebase", b.name]), label: `Rebase onto ${b.name}` }) }, SEP,
      { label: "Create Branch…", steps: [{ ask: "New branch name" }],
        run: ([name]) => ({ ...git(["switch", "-c", name]), label: `Create branch ${name}` }) },
      { label: "Create Branch From…", steps: [{ pick: "refs", title: "Select a ref to create the branch from" }, { ask: "New branch name" }],
        run: ([b, name]) => ({ ...git(["switch", "-c", name, b.name]), label: `Create branch ${name}` }) }, SEP,
      { label: "Rename Branch…", steps: [{ ask: "New name for the current branch", value: (s) => s.branch ?? "" }],
        run: ([name]) => ({ ...git(["branch", "-m", name]), label: `Rename to ${name}` }) },
      { label: "Delete Branch…", steps: [{ pick: "local", title: "Select a branch to delete" }, { confirm: ([b]) => `Delete branch ${b.name}?` }],
        run: ([b]) => ({ ...git(["branch", "-d", b.name]), label: `Delete branch ${b.name}` }) },
      { label: "Delete Branch (Force)…", steps: [{ pick: "local", title: "Select a branch to force-delete" }, { confirm: ([b]) => `Force-delete branch ${b.name}? Commits only on it are lost.` }],
        run: ([b]) => ({ ...git(["branch", "-D", b.name]), label: `Delete branch ${b.name}` }) },
      { label: "Delete Remote Branch…", steps: [{ pick: "remoteBranches", title: "Select a remote branch to delete" }, { confirm: ([b]) => `Delete ${b.branch} on ${b.remote}? Everyone using it loses it.` }],
        run: ([b]) => ({ ...git(["push", b.remote, "--delete", b.branch]), label: `Delete ${b.name}` }) }, SEP,
      { label: "Publish Branch…", steps: [{ pick: "remotes", title: "Pick a remote to publish the branch to", auto: true }],
        run: ([r]) => ({ ...git(["push", "-u", r.name, "HEAD"]), label: `Publish to ${r.name}` }) },
    ],
    remote: [
      { label: "Add Remote…", steps: [{ ask: "Remote name", value: (s) => (s.remotes?.length ? "" : "origin") }, { ask: "Remote URL" }],
        run: ([name, url]) => ({ ...git(["remote", "add", name, url]), label: `Add remote ${name}` }) },
      { label: "Remove Remote…", steps: [{ pick: "remotes", title: "Pick a remote to remove" }, { confirm: ([r]) => `Remove remote ${r.name}? Its remote-tracking branches go too.` }],
        run: ([r]) => ({ ...git(["remote", "remove", r.name]), label: `Remove remote ${r.name}` }) },
    ],
    stash: [
      { label: "Stash", steps: [{ ask: "Stash message (optional)", optional: true }],
        run: ([m]) => ({ ...git(["stash", "push", ...(m ? ["-m", m] : [])]), label: "Stash" }) },
      { label: "Stash (Include Untracked)", steps: [{ ask: "Stash message (optional)", optional: true }],
        run: ([m]) => ({ ...git(["stash", "push", "-u", ...(m ? ["-m", m] : [])]), label: "Stash" }) },
      { label: "Stash Staged", steps: [{ ask: "Stash message (optional)", optional: true }],
        run: ([m]) => ({ ...git(["stash", "push", "--staged", ...(m ? ["-m", m] : [])]), label: "Stash Staged" }) }, SEP,
      { label: "Apply Latest Stash", run: () => ({ ...git(["stash", "apply"]), label: "Apply stash" }) },
      { label: "Apply Stash…", steps: [{ pick: "stashes", title: "Pick a stash to apply" }],
        run: ([s]) => ({ ...git(["stash", "apply", s.name]), label: `Apply ${s.name}` }) }, SEP,
      { label: "Pop Latest Stash", run: () => ({ ...git(["stash", "pop"]), label: "Pop stash" }) },
      { label: "Pop Stash…", steps: [{ pick: "stashes", title: "Pick a stash to pop" }],
        run: ([s]) => ({ ...git(["stash", "pop", s.name]), label: `Pop ${s.name}` }) }, SEP,
      { label: "Drop Stash…", steps: [{ pick: "stashes", title: "Pick a stash to drop" }, { confirm: ([s]) => `Drop ${s.name} (${s.detail})? It can't be undone.` }],
        run: ([s]) => ({ ...git(["stash", "drop", s.name]), label: `Drop ${s.name}` }) },
      { label: "Drop All Stashes…", steps: [{ confirm: () => "Drop every stash? It can't be undone." }],
        run: () => ({ ...git(["stash", "clear"]), label: "Drop all stashes" }) },
    ],
    tags: [
      { label: "Create Tag…", steps: [{ ask: "Tag name" }, { ask: "Tag message (optional: makes an annotated tag)", optional: true }],
        run: ([name, m]) => ({ ...git(["tag", ...(m ? ["-a", name, "-m", m] : [name])]), label: `Create tag ${name}` }) },
      { label: "Delete Tag…", steps: [{ pick: "tags", title: "Pick a tag to delete" }, { confirm: ([tg]) => `Delete tag ${tg.name}?` }],
        run: ([tg]) => ({ ...git(["tag", "-d", tg.name]), label: `Delete tag ${tg.name}` }) },
      { label: "Delete Remote Tag…", steps: [{ pick: "tags", title: "Pick a tag to delete on the remote" }, { pick: "remotes", title: "From which remote", auto: true }, { confirm: ([tg, r]) => `Delete tag ${tg.name} on ${r.name}?` }],
        run: ([tg, r]) => ({ ...git(["push", r.name, "--delete", `refs/tags/${tg.name}`]), label: `Delete ${tg.name} on ${r.name}` }) }, SEP,
      { label: "Push Tags", run: () => ({ ...git(["push", "--tags"]), label: "Push tags" }) },
    ],
    worktrees: [
      { label: "Create Worktree…", run: () => worktree("new", p.root) },
      { label: "Open Worktree…", run: () => worktree("open", p.root) },
      { label: "Delete Worktree…", steps: [{ pick: "worktrees", title: "Pick a worktree to delete" }], run: ([w]) => worktree("remove", w.path) },
    ],
  };
}

const TITLES = { view: "View & Sort", commit: "Commit", changes: "Changes", sync: "Pull, Push", branch: "Branch", remote: "Remote", stash: "Stash", tags: "Tags", worktrees: "Worktrees" };

function checkout(r) {
  if (r.create) return { ...git(["switch", "-c", r.create]), label: `Create branch ${r.create}` };
  if (r.kind === "tag") return { ...git(["switch", "--detach", r.name]), label: `Checkout ${r.name}` };
  // A remote branch: its local branch if there is one, else a new one tracking it.
  if (r.kind === "remote") return r.local ? { ...git(["switch", r.branch]), label: `Checkout ${r.branch}` } : { ...git(["switch", "--track", r.name]), label: `Checkout ${r.branch}` };
  return { ...git(["switch", r.name]), label: `Checkout ${r.name}` };
}

export default class GitMenu extends View {
  init(_props, cx) {
    this.stack = ["root"]; this.at = 0; this.flow = null; this.state = {};
    this.text = "";
    this.makeInput("", "");
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The current branch and the remotes: titles, defaults and the "auto" pick need them.
    const p = props() ?? {};
    if (p.root) cx.spawn(async (cx) => {
      const run = (args) => exec("git", [...READ, ...args], { cwd: p.root, on: p.on ?? undefined }).catch(() => ({ code: 1, stdout: "" }));
      const [b, r] = await Promise.all([run(["branch", "--show-current"]), run(["remote"])]);
      this.state = { branch: b.stdout.trim() || null, remotes: r.stdout.split("\n").filter(Boolean) };
      cx.notify();
    });
  }

  // A fresh box per step: its own placeholder and starting text.
  makeInput(placeholder, value) {
    this.input = InputState.new({ placeholder, value });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
  }

  list() { return menus(props() ?? {})[this.stack[this.stack.length - 1]] ?? []; }
  choices() { return this.list().map((it, i) => ({ it, i })).filter(({ it }) => !it.sep); }

  // A step's list: refs, remotes, stashes, tags or worktrees, read once per step.
  async source(name) {
    const p = props() ?? {}, cur = this.state.branch;
    const run = async (args) => {
      const r = await exec("git", [...READ, ...args], { cwd: p.root, on: p.on ?? undefined });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
      return r.stdout.split("\n").filter(Boolean);
    };
    if (name === "remotes") return (await run(["remote", "-v"])).filter((l) => l.endsWith("(fetch)"))
      .map((l) => { const [n, url] = l.split(/\s+/); return { name: n, detail: url }; });
    if (name === "stashes") return (await run(["stash", "list", "--format=%gd%x09%s"])).map((l) => { const [n, ...s] = l.split("\t"); return { name: n, detail: s.join("\t") }; });
    if (name === "tags") return (await run(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(contents:subject)", "refs/tags"]))
      .map((l) => { const [n, ...s] = l.split("\t"); return { name: n, detail: s.join("\t"), kind: "tag" }; });
    if (name === "worktrees") {
      const out = [];
      for (const l of await run(["worktree", "list", "--porcelain"])) {
        if (l.startsWith("worktree ")) out.push({ path: l.slice(9), name: l.slice(9).split("/").pop(), detail: "" });
        else if (l.startsWith("branch ") && out.length) out[out.length - 1].detail = l.slice(7).replace("refs/heads/", "");
      }
      return out.slice(1).map((w) => ({ ...w, detail: w.detail || w.path }));
    }
    const refs = (await run(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(contents:subject)",
      "refs/heads", "refs/remotes", ...(name === "checkout" || name === "refs" ? ["refs/tags"] : [])]))
      .map((l) => { const [full, short, sha, ...s] = l.split("\t"); return { full, name: short, detail: `${sha} ${s.join("\t")}`.trim() }; })
      .filter((r) => !r.full.endsWith("/HEAD"));
    const locals = new Set(refs.filter((r) => r.full.startsWith("refs/heads/")).map((r) => r.name));
    const all = refs.map((r) => {
      if (r.full.startsWith("refs/heads/")) return { ...r, kind: "local" };
      if (r.full.startsWith("refs/tags/")) return { ...r, kind: "tag" };
      const remote = r.full.split("/")[2], branch = r.name.slice(remote.length + 1);
      return { ...r, kind: "remote", remote, branch, local: locals.has(branch) };
    }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    if (name === "local") return all.filter((r) => r.kind === "local" && r.name !== cur);
    if (name === "remoteBranches") return all.filter((r) => r.kind === "remote");
    if (name === "branches") return all.filter((r) => r.kind !== "tag" && r.name !== cur);
    if (name === "checkout") return all.filter((r) => !(r.kind === "local" && r.name === cur) && !(r.kind === "remote" && r.local && r.branch === cur));
    return all;
  }

  open(i, cx) {
    const it = this.list()[i];
    if (!it || it.sep) return;
    if (it.sub) { this.stack.push(it.sub); this.at = 0; cx.notify(); return; }
    if (!it.steps?.length) { this.finish(it, [], cx); return; }
    this.flow = { it, values: [], step: 0 };
    this.enter(cx);
  }

  // Shows the flow's current step.
  enter(cx) {
    const f = this.flow, step = f.it.steps[f.step];
    this.at = 0; this.text = ""; this.picks = null; this.pickError = null;
    if (step.ask || step.pick) {
      const v = step.value ? step.value(this.state) : "";
      this.makeInput(step.ask ? "" : "Type to filter", v); this.text = v;
      cx.timer.after(30, () => this.input.focus());
    } else this.handle.focus();
    if (step.pick) {
      const seq = this.flowSeq = (this.flowSeq ?? 0) + 1;
      cx.spawn(async (cx) => {
        try {
          const list = await this.source(step.pick);
          if (seq !== this.flowSeq) return;
          this.picks = list;
          // One remote to choose from: chosen.
          if (step.auto && list.length === 1) { this.next(list[0], cx); return; }
        } catch (e) { if (seq === this.flowSeq) this.pickError = String(e?.message ?? e); }
        cx.notify();
      });
    }
    cx.notify();
  }

  next(value, cx) {
    const f = this.flow;
    f.values.push(value); f.step++;
    if (f.step >= f.it.steps.length) this.finish(f.it, f.values, cx);
    else this.enter(cx);
  }

  back(cx) {
    if (this.flow) {
      const f = this.flow;
      if (f.step === 0) { this.flow = null; this.flowSeq = (this.flowSeq ?? 0) + 1; this.handle.focus(); }
      else { f.step--; f.values.pop(); this.enter(cx); return; }
    } else if (this.stack.length > 1) this.stack.pop();
    else return closeOverlay(props()?.overlay);
    this.at = 0; cx.notify();
  }

  filtered() {
    const q = this.text.trim().toLowerCase(), step = this.flow?.it.steps[this.flow.step];
    const list = (this.picks ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.detail ?? "").toLowerCase().includes(q));
    // Checkout: a name nothing matches exactly becomes a new branch.
    if (step?.pick === "checkout" && q && !(this.picks ?? []).some((r) => r.name === this.text.trim()) && this.text.trim() !== this.state.branch)
      return [{ create: this.text.trim(), name: `Create new branch “${this.text.trim()}”`, detail: "" }, ...list];
    return list;
  }

  submit(cx) {
    const step = this.flow?.it.steps[this.flow.step];
    if (!step) return;
    if (step.pick) { const r = this.filtered()[this.at]; if (r) this.next(r, cx); return; }
    if (step.ask) { const v = this.text.trim(); if (v || step.optional) this.next(v, cx); }
  }

  finish(it, values, cx) {
    const p = props() ?? {};
    const op = it.run(values, p);
    closeOverlay(p.overlay);
    if (!op) return;
    if (op.kind === "overlay") { openOverlay(op.overlay); return; }
    setShared(GITOP, { ...op, owner: p.owner, root: p.root, on: p.on ?? null, seq: `${Date.now()}-${Math.random()}` });
  }

  row(id, label, t, { selected, icon, chevron, hint, click, danger } = {}) {
    return h_flex().id(id).h(28).px(8).gap(8).flex_none().rounded(6).items_center().cursor_pointer()
      .text_color(danger ? t.ansi1 : t.foreground)
      .when(Boolean(selected), (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => click(cx))
      .child(div().w(14).flex_none().when(Boolean(icon), (el) => el.child(svg(`${ICON}/${icon}.svg`).size(14).text_color(t.accent))))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .when(Boolean(chevron), (el) => el.child(svg(`${ICON}/chevron-right.svg`).size(14).flex_none().text_color(t.muted)));
  }

  title(text, t) {
    return h_flex().id("gm-back").h(28).px(6).gap(6).flex_none().items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.back(cx))
      .child(svg(`${ICON}/chevron-left.svg`).size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().child(text));
  }

  render(cx) {
    const t = theme(), p = props() ?? {};
    const root = v_flex().id("git-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => this.key(e, cx));
    if (!p.root) return root.h(44).child(div().px(9).py(8).text_color(t.dim).child("Not a git repository"));
    if (this.flow) return this.renderFlow(root, t);
    const list = this.list(), menu = this.stack[this.stack.length - 1], sub = this.stack.length > 1;
    const choices = this.choices();
    const sel = choices[Math.min(this.at, choices.length - 1)]?.i;
    const h = 10 + (sub ? 34 : 0) + list.reduce((n, it) => n + (it.sep ? 9 : 28), 0);
    return root.h(h)
      .when(sub, (el) => el.child(this.title(TITLES[menu] ?? "", t)).child(div().mx(7).my(3).h(1).bg(t.border)))
      .children(list.map((it, i) => it.sep ? div().mx(7).my(4).h(1).flex_none().bg(t.border)
        : this.row(`gm-${menu}-${i}`, it.label, t, { selected: i === sel, icon: it.icon, chevron: Boolean(it.sub), hint: it.hint && menu === "view" && !p.tree ? null : it.hint,
          click: (cx) => this.open(i, cx) })));
  }

  renderFlow(root, t) {
    const f = this.flow, step = f.it.steps[f.step];
    const head = this.title(f.it.label.replace(/…$/, ""), t);
    if (step.confirm) {
      return root.h(150).child(head)
        .child(div().px(9).pt(6).flex_1().text_size(12.5).text_color(t.foreground).child(step.confirm(f.values)))
        .child(h_flex().px(4).pb(3).gap(6).justify_end()
          .child(h_flex().id("gm-cancel").h(26).px(10).items_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.back(cx)).child("Cancel"))
          .child(h_flex().id("gm-ok").h(26).px(12).items_center().rounded(6).cursor_pointer().bg(t.ansi1).text_color("#ffffff").hover((s) => s.opacity(0.88))
            .on_click((_e, cx) => this.next(true, cx)).child("Confirm")));
    }
    const input = h_flex().h(30).mx(3).my(3).px(8).flex_none().items_center().rounded(6).border_1().border_color(t.accent)
      .child(div().flex_1().min_w(0).h_full().flex().items_center().child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)));
    if (step.ask) {
      return root.h(118).child(head).child(div().px(9).pt(2).text_size(11.5).text_color(t.muted).child(step.ask)).child(input)
        .child(div().px(9).text_size(11).text_color(t.dim).child(step.optional ? "Enter to continue (empty is fine)" : "Enter to confirm"));
    }
    const list = this.filtered(), at = Math.min(this.at, Math.max(0, list.length - 1));
    const body = this.pickError ? [div().px(9).py(6).text_color(t.ansi1).child(this.pickError)]
      : this.picks === null ? [div().px(9).py(6).text_color(t.dim).child("Loading…")]
      : !list.length ? [div().px(9).py(6).text_color(t.dim).child(this.picks.length ? "No match" : "Nothing here")]
      : list.slice(0, 200).map((r, i) => h_flex().id(`gm-pick-${i}`).h(40).px(8).gap(8).flex_none().rounded(6).items_center().cursor_pointer()
        .when(i === at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.next(r, cx))
        .child(svg(`${ICON}/${r.create ? "plus" : r.kind === "tag" ? "archive" : r.kind === "remote" ? "server" : step.pick === "stashes" ? "layers" : step.pick === "remotes" ? "server" : step.pick === "worktrees" ? "folder" : "git-branch"}.svg`)
          .size(14).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(r.name))
          .when(Boolean(r.detail), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(r.detail)))));
    return root.h(Math.min(460, 112 + Math.max(1, Math.min(list.length, 8)) * 40)).child(head)
      .child(div().px(9).text_size(11.5).text_color(t.muted).truncate().child(step.title ?? ""))
      .child(input)
      .child(v_flex().id("gm-picks").flex_1().min_h(0).overflow_y_scrollbar().children(body));
  }

  key(e, cx) {
    const step = this.flow?.it.steps[this.flow.step];
    const n = step?.pick ? this.filtered().length : step ? 0 : this.choices().length;
    if (e.key === "down" && n) this.at = (Math.min(this.at, n - 1) + 1) % n;
    else if (e.key === "up" && n) this.at = (Math.min(this.at, n - 1) + n - 1) % n;
    else if (e.key === "escape") { cx.stop_propagation(); this.back(cx); return; }
    else if (!step && (e.key === "enter" || e.key === "right")) { const c = this.choices()[this.at]; if (c) this.open(c.i, cx); return; }
    else if (!step && e.key === "left") { this.back(cx); return; }
    else if (step?.confirm && e.key === "enter") { this.next(true, cx); return; }
    else return;
    cx.stop_propagation();
    cx.notify();
  }
}
