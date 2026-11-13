#!/bin/sh
# Installs this fork's panels into a released Herdr app as personal mods, without building
# the app. Herdr must be running (the clones are made through `herdr-app do`).
#
#   changes   -> changes-focus   Changes panel: session focus, staging, tree, generate, diffs
#   agents    -> agents-view     Agents sidebar: group / sort / hide idle
#   tabs      -> tabs-plus       Tab bar: grid layouts and full screen
#   pane-grid -> pane-grid       the grid menu (new)
#   diff-view -> diff-view       side-by-side compare, opened from the Changes panel (new)
#   workspace-status -> workspace-status-plus   status bar: click the branch to switch / create one
#
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
sed 's|^const ICONS = "mods/changes";|const ICONS = "mods/changes-focus";|' "$src/changes/main.js" > "$home/mods/changes-focus/main.js"
cp "$src"/changes/scm-*.svg "$src/changes/CODICONS-LICENSE" "$home/mods/changes-focus/"

clone agents agents-view
sed 's|^const SELF = "agents";|const SELF = "agents-view";|' "$src/agents/main.js" > "$home/mods/agents-view/main.js"

clone tabs tabs-plus
sed 's|mods/tabs/|mods/tabs-plus/|g' "$src/tabs/main.js" > "$home/mods/tabs-plus/main.js"
cp "$src"/tabs/scm-*.svg "$src/tabs/CODICONS-LICENSE" "$home/mods/tabs-plus/"

mkdir -p "$home/mods/pane-grid"
cp "$src/pane-grid/main.js" "$src/pane-grid/mod.json" "$home/mods/pane-grid/"

mkdir -p "$home/mods/diff-view"
cp "$src"/diff-view/* "$home/mods/diff-view/"

clone workspace-status workspace-status-plus
sed 's|^const SELF = "workspace-status";|const SELF = "workspace-status-plus";|' "$src/workspace-status/main.js" > "$home/mods/workspace-status-plus/main.js"

for m in changes-focus agents-view tabs-plus pane-grid diff-view workspace-status-plus; do herdr-app check "$home/mods/$m"; done

# The layout: clone main once, then point its blocks at the personal mods.
[ -f "$home/layouts/main-focus.json" ] || herdr-app do layout.clone '{"name":"main","as":"main-focus"}' >/dev/null
python3 -I - "$home/layouts/main-focus.json" <<'EOF'
import json, sys
path = sys.argv[1]
swap = {"changes": "changes-focus", "agents": "agents-view", "tabs": "tabs-plus", "workspace-status": "workspace-status-plus"}
layout = json.load(open(path))
def walk(node):
    if isinstance(node, dict):
        content = node.get("content")
        if isinstance(content, dict) and content.get("mod") in swap:
            content["mod"] = swap[content["mod"]]
        for value in node.values(): walk(value)
    elif isinstance(node, list):
        for value in node: walk(value)
walk(layout)
json.dump(layout, open(path, "w"), indent=2)
EOF
herdr-app do layout.switch '{"name":"main-focus"}' >/dev/null
echo "Installed. Herdr now shows the main-focus layout; ctrl-shift-l switches layouts."
