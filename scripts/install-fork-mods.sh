#!/bin/sh
# Installs this fork's panels into a released Herdr app as personal mods, without building
# the app. Herdr must be running (the clones are made through `herdr-app do`).
#
#   changes   -> changes-focus   Changes panel: session focus, staging, tree, generate, diffs
#   agents    -> agents-view     Agents sidebar: group / sort / hide idle
#   tabs      -> tabs-plus       Tab bar: grid layouts, full screen, Run button (package.json scripts)
#   pane      -> pane-plus       pane header: an agent's conversation title next to its name
#   pane-grid -> pane-grid       the grid menu (new)
#   tab-drag  -> tab-drag        a dragged tab: follows the pointer, reorders or joins tabs (new)
#   file-menu -> file-menu       right-click on a file in Files/Changes: reveal, open, terminal, copy path (new)
#   git-menu  -> git-menu        the Changes panel's ⋯ menu: pull, push, branches, stashes, tags... (new)
#   git-result -> git-result     why a git action failed: full output + what to do next (new)
#   run-menu  -> run-menu       the Run button's script list (new)
#   diff-view -> diff-view       side-by-side compare, opened from the Changes panel (new)
#   git-graph -> git-graph       commit graph, opened from the Changes panel (new)
#   workspace-status -> workspace-status-plus   status bar: click the branch to switch / create one
#   spaces    -> spaces-plus     Spaces sidebar: groups (fold, drag in, right-click to move)
#   files     -> files-plus      Files panel: Material file/folder icons, colorful previews (.env too), Edit / Save
#   menu      -> menu-plus       space menu with Move to group / New group, the group menu
#
# plus a user service, herdr-session-keeper, that resumes agents after a reboot, an app-id
# shim (Linux) so GNOME shows Herdr's icon instead of a gear while the window opens,
# and a layout `main-focus` (a clone of `main`) that uses them. Your own layout stays as it
# was: switch with ctrl-shift-l. Personal mods are never overwritten by app updates.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
src=$repo/defaults/mods

command -v herdr-app >/dev/null || { echo "herdr-app is not on PATH" >&2; exit 1; }
herdr-app status >/dev/null 2>&1 || { echo "Start Herdr first: the mods are cloned through the running app" >&2; exit 1; }

# clone <shipped> <personal>: a personal copy of a shipped mod, unless one exists already.
clone() {
  [ -d "$home/mods/$2" ] || herdr-app do mod.clone "{\"name\":\"$1\",\"as\":\"$2\"}" >/dev/null
}

clone changes changes-focus
sed -e 's|^const ICONS = "mods/changes";|const ICONS = "mods/changes-focus";|' -e 's|^const FT = "mods/files";|const FT = "mods/files-plus";|' "$src/changes/main.js" > "$home/mods/changes-focus/main.js"
cp "$src/changes/filetypes.js" "$src/changes/icon-map.js" "$home/mods/changes-focus/"
cp "$src"/changes/scm-*.svg "$src/changes/CODICONS-LICENSE" "$home/mods/changes-focus/"

clone agents agents-view
sed 's|^const SELF = "agents";|const SELF = "agents-view";|' "$src/agents/main.js" > "$home/mods/agents-view/main.js"

clone tabs tabs-plus
sed 's|mods/tabs/|mods/tabs-plus/|g' "$src/tabs/main.js" > "$home/mods/tabs-plus/main.js"
cp "$src"/tabs/scm-*.svg "$src"/tabs/run-*.svg "$src/tabs/run.js" "$src/tabs/CODICONS-LICENSE" "$home/mods/tabs-plus/"

clone pane pane-plus
sed 's|mods/pane/|mods/pane-plus/|g' "$src/pane/main.js" > "$home/mods/pane-plus/main.js"

mkdir -p "$home/mods/run-menu"
cp "$src"/run-menu/* "$home/mods/run-menu/"

mkdir -p "$home/mods/tab-drag"
cp "$src"/tab-drag/* "$home/mods/tab-drag/"
mkdir -p "$home/mods/file-menu"
cp "$src"/file-menu/* "$home/mods/file-menu/"
mkdir -p "$home/mods/git-menu"
cp "$src"/git-menu/* "$home/mods/git-menu/"
mkdir -p "$home/mods/git-result"
cp "$src"/git-result/* "$home/mods/git-result/"

mkdir -p "$home/mods/pane-grid"
cp "$src/pane-grid/main.js" "$src/pane-grid/mod.json" "$home/mods/pane-grid/"

mkdir -p "$home/mods/diff-view"
cp "$src"/diff-view/* "$home/mods/diff-view/"

mkdir -p "$home/mods/git-graph"
cp "$src"/git-graph/* "$home/mods/git-graph/"

clone workspace-status workspace-status-plus
sed 's|^const SELF = "workspace-status";|const SELF = "workspace-status-plus";|' "$src/workspace-status/main.js" > "$home/mods/workspace-status-plus/main.js"

clone spaces spaces-plus
sed 's|^const MENU = "menu";|const MENU = "menu-plus";|' "$src/spaces/main.js" > "$home/mods/spaces-plus/main.js"

clone files files-plus
sed -e 's|mods/files/|mods/files-plus/|g' -e 's|^const FT = "mods/files";|const FT = "mods/files-plus";|' "$src/files/main.js" > "$home/mods/files-plus/main.js"
cp "$src"/files/*.svg "$src/files/filetypes.js" "$src/files/icon-map.js" "$home/mods/files-plus/"
rm -rf "$home/mods/files-plus/mi" "$home/mods/files-plus"/ft-*.svg
cp -r "$src/files/mi" "$home/mods/files-plus/"

clone menu menu-plus
sed 's|^const SELF = "menu";|const SELF = "menu-plus";|' "$src/menu/main.js" > "$home/mods/menu-plus/main.js"

for m in spaces-plus menu-plus files-plus changes-focus agents-view tabs-plus tab-drag file-menu git-menu git-result pane-plus pane-grid run-menu diff-view git-graph workspace-status-plus; do herdr-app check "$home/mods/$m"; done

# The layout: clone main once, then point its blocks at the personal mods.
[ -f "$home/layouts/main-focus.json" ] || herdr-app do layout.clone '{"name":"main","as":"main-focus"}' >/dev/null
python3 -I - "$home/layouts/main-focus.json" <<'EOF'
import json, sys
path = sys.argv[1]
swap = {"changes": "changes-focus", "agents": "agents-view", "tabs": "tabs-plus", "pane": "pane-plus", "workspace-status": "workspace-status-plus", "spaces": "spaces-plus", "files": "files-plus"}
layout = json.load(open(path))
def walk(node):
    if isinstance(node, dict):
        content = node.get("content")
        if isinstance(content, dict) and content.get("mod") in swap:
            content["mod"] = swap[content["mod"]]
        # Files' full screen stretches the side panel over the whole window: no 900 px cap.
        if node.get("id") == "panel":
            node["max"] = 10000
        for value in node.values(): walk(value)
    elif isinstance(node, list):
        for value in node: walk(value)
walk(layout)
json.dump(layout, open(path, "w"), indent=2)
EOF
herdr-app do layout.switch '{"name":"main-focus"}' >/dev/null

# Session keeper: after a reboot or core restart, resume the agents (claude, codex, agy,
# cursor-agent) that were running in each terminal. herdr-core already brings back the layout
# and a shell per kept terminal; this types the resume command into that shell.
if command -v systemctl >/dev/null 2>&1; then
  install -Dm755 "$repo/scripts/session-keeper/herdr-session-keeper" "$HOME/.local/bin/herdr-session-keeper"
  install -Dm644 "$repo/scripts/session-keeper/herdr-session-keeper.service" "$HOME/.config/systemd/user/herdr-session-keeper.service"
  systemctl --user daemon-reload && systemctl --user enable --now herdr-session-keeper.service >/dev/null 2>&1 || true
fi
# App-id shim (Linux/Wayland): a released herdr-app names its window ~70 ms after creating it,
# so GNOME shows a gear icon in the dock until then. Preload a tiny library that names it at
# once, and start Herdr's launcher through it. install-linux rewrites the .desktop file on
# update, so run this script again afterwards.
desktop="${XDG_DATA_HOME:-$HOME/.local/share}/applications/herdr-app.desktop"
shim="$HOME/.local/lib/herdr-appid-shim/herdr-appid-shim.so"
if [ "$(uname -s)" = Linux ] && [ -f "$desktop" ] && command -v cc >/dev/null 2>&1 \
  && [ -f /usr/include/wayland-client-core.h ]; then
  mkdir -p "$(dirname "$shim")"
  cc -shared -fPIC -O2 -o "$shim" "$repo/scripts/appid-shim/herdr-appid-shim.c" -ldl -lwayland-client
  sed -i "s|^Exec=.*herdr-app\$|Exec=env LD_PRELOAD=$shim $HOME/.local/bin/herdr-app|" "$desktop"
  update-desktop-database "$(dirname "$desktop")" 2>/dev/null || true
fi
echo "Installed. Herdr now shows the main-focus layout; ctrl-shift-l switches layouts."
