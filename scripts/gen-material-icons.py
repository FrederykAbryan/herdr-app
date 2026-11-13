# Builds the Material Icon Theme subset for the herdr Files/Changes mods.
# Usage: npm pack material-icon-theme; tar xzf material-icon-theme-*.tgz -C /tmp/mit
#        python3 -I scripts/gen-material-icons.py /tmp/mit/package .
import json, os, shutil, sys
pkg, repo = sys.argv[1], sys.argv[2]
m = json.load(open(f"{pkg}/dist/material-icons.json"))
defs = m["iconDefinitions"]
def path(i): return f"{pkg}/icons/" + defs[i]["iconPath"].split("/")[-1]
low = lambda d: {k.lower(): v for k, v in d.items()}
names, exts = low(m["fileNames"]), low(m["fileExtensions"])
# Common names the theme leaves to VS Code language ids.
names.update({"pubspec.yaml": "dart", "pubspec.lock": "lock", "analysis_options.yaml": "dart",
              ".env": "tune", "makefile": "makefile" if "makefile" in defs else "settings"})
FOLDERS = """src source lib libs app apps api apis components component pages page views view layouts layout
public static assets asset images img icons fonts styles style css scss test tests __tests__ spec e2e mocks __mocks__ fixtures
utils util helpers helper hooks hook store stores redux state context contexts services service controllers controller
routes route router routers middleware middlewares models model schemas schema types typings interfaces db database
migrations drizzle prisma seeds config configs settings constants constant locales locale i18n lang langs translations
docs doc scripts script bin tools dist build out target node_modules vendor packages .github .vscode .idea .git .husky
.claude .cursor docker server client core shared common modules plugins android ios web linux windows macos
providers provider screens widgets features feature data models entities repositories repository dto guards
templates template content theme themes animations temp tmp logs log env environment environments examples
coverage storybook .storybook workflows github cache .cache resources res include src-tauri""".split()
folders, opened = {}, {}
fn, fx = low(m["folderNames"]), low(m["folderNamesExpanded"])
for f in FOLDERS:
    if f in fn: folders[f] = fn[f]; opened[f] = fx.get(f, fn[f] + "-open")
light = {}
for sect in ("fileNames", "fileExtensions"):
    for k, v in m["light"].get(sect, {}).items():
        base = (names if sect == "fileNames" else exts).get(k.lower())
        if base and base != v: light[base] = v
used = set(names.values()) | set(exts.values()) | set(folders.values()) | set(opened.values()) | set(light.values()) | {"file", "folder", "folder-open"}
used = {i for i in used if i in defs and os.path.exists(path(i))}
names = {k: v for k, v in names.items() if v in used}; exts = {k: v for k, v in exts.items() if v in used}
light = {k: v for k, v in light.items() if v in used and k in used}
out = f"{repo}/defaults/mods/files/mi"
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
for i in used: shutil.copy(path(i), f"{out}/{i}.svg")
shutil.copy(f"{pkg}/LICENSE", f"{out}/LICENSE")
data = ("// Generated from material-icon-theme %s (MIT, github.com/material-extensions/vscode-material-icon-theme)\n"
        "// by the build script; icons are mods/files/mi/<name>.svg. Don't edit by hand.\n"
        "export const NAMES = %s;\nexport const EXTS = %s;\nexport const FOLDERS = %s;\nexport const FOLDERS_OPEN = %s;\nexport const LIGHT = %s;\n") % (
    json.load(open(f"{pkg}/package.json"))["version"], *(json.dumps(x, separators=(",", ":"), sort_keys=True) for x in (names, exts, folders, opened, light)))
for mod in ("files", "changes"): open(f"{repo}/defaults/mods/{mod}/icon-map.js", "w").write(data)
print(len(used), "icons", sum(os.path.getsize(f"{out}/{f}") for f in os.listdir(out)) // 1024, "KB; map", len(data) // 1024, "KB;", len(folders), "folders")
