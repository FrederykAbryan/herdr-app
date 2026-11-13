// File and folder icons, VS Code style, shared by the Files and Changes panels (each mod keeps
// a copy of this file and of icon-map.js: mods import only from their own folder). The icons
// are Material Icon Theme's full-color SVGs (mi/*.svg, MIT, see mi/LICENSE), kept in the Files
// mod's folder and passed in as `base` ("mods/files", or a personal clone's path).
import { image } from "gpui-kit";
import { settings } from "herdr";
import { NAMES, EXTS, FOLDERS, FOLDERS_OPEN, LIGHT } from "./icon-map.js";

// The icon a file gets, as VS Code picks it: its whole name, else its longest known
// extension ("app.spec.ts" tries "spec.ts", then "ts"), else a plain page.
export function fileType(name) {
  const lower = name.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  if (lower.startsWith(".env")) return NAMES[".env"];
  if (lower.startsWith("dockerfile")) return NAMES.dockerfile ?? "docker";
  for (let at = lower.indexOf("."); at >= 0; at = lower.indexOf(".", at + 1)) {
    const ext = lower.slice(at + 1);
    if (ext && EXTS[ext]) return EXTS[ext];
  }
  return "file";
}

const tone = (icon) => (!settings().dark && LIGHT[icon]) || icon;
const pic = (base, icon, size) => image(`${base}/mi/${tone(icon)}.svg`).size(size).flex_none();

// A file's icon. `t` (the theme) is unused now that icons bring their own colors; kept so
// callers stay the same.
export function typeIcon(base, name, _t, size = 15) {
  return pic(base, fileType(name), size);
}

// A folder, shut or open; known folder names (src, components, .github, ...) get their own.
// `name` may be a compacted tree path ("src/components"): its last part decides.
export function folderIcon(base, open, name = "", size = 16) {
  const key = name.split("/").pop().toLowerCase();
  const icon = (open ? FOLDERS_OPEN[key] : FOLDERS[key]) ?? (open ? "folder-open" : "folder");
  return pic(base, icon, size);
}
