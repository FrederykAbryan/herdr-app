// File-type icons, VS Code style, shared by the Files and Changes panels (each mod keeps a
// copy of this file: mods import only from their own folder). The glyphs are ft-*.svg in the
// Files mod's folder, passed in as `base` ("mods/files", or a personal clone's path).
import { div, svg } from "gpui-kit";

// A colored letter badge, or a colored glyph (ft-*.svg).
// { badge, bg, fg } or { glyph, color }; first match wins: whole name, then extension.
const BADGE = (badge, bg, fg = "#ffffff") => ({ badge, bg, fg }), GLYPH = (glyph, color) => ({ glyph, color });
const BY_NAME = {
  "package.json": GLYPH("package", "#e8274b"), "package-lock.json": GLYPH("lock", "#e8274b"), "bun.lock": GLYPH("lock", "#f9f1e1"),
  "pnpm-lock.yaml": GLYPH("lock", "#f69220"), "yarn.lock": GLYPH("lock", "#2c8ebb"), "cargo.lock": GLYPH("lock", "#dea584"),
  "composer.lock": GLYPH("lock", "#8892be"), "pubspec.lock": GLYPH("lock", "#40c4ff"), "pubspec.yaml": GLYPH("package", "#40c4ff"),
  "cargo.toml": GLYPH("package", "#dea584"), "composer.json": GLYPH("package", "#8892be"),
  "dockerfile": GLYPH("whale", "#2496ed"), "docker-compose.yml": GLYPH("whale", "#2496ed"), "docker-compose.yaml": GLYPH("whale", "#2496ed"),
  "compose.yml": GLYPH("whale", "#2496ed"), "compose.yaml": GLYPH("whale", "#2496ed"), ".dockerignore": GLYPH("whale", "#5f7a8a"),
  ".gitignore": GLYPH("git", "#f14e32"), ".gitattributes": GLYPH("git", "#f14e32"), ".gitmodules": GLYPH("git", "#f14e32"), ".gitkeep": GLYPH("git", "#f14e32"),
  "license": GLYPH("key", "#e5c07b"), "license.md": GLYPH("key", "#e5c07b"), "license.txt": GLYPH("key", "#e5c07b"),
  "readme.md": GLYPH("info", "#42a5f5"), "readme": GLYPH("info", "#42a5f5"), "makefile": GLYPH("terminal", "#e37933"),
  "tsconfig.json": BADGE("TS", "#3178c6"), "jsconfig.json": BADGE("JS", "#f0db4f", "#1b1b1b"),
  ".editorconfig": GLYPH("gear", "#9aa5b1"), ".prettierrc": GLYPH("gear", "#56b3b4"), ".eslintrc": GLYPH("gear", "#8080f2"),
};
const BY_EXT = {
  ts: BADGE("TS", "#3178c6"), mts: BADGE("TS", "#3178c6"), cts: BADGE("TS", "#3178c6"), tsx: GLYPH("atom", "#3178c6"), jsx: GLYPH("atom", "#61dafb"),
  js: BADGE("JS", "#f0db4f", "#1b1b1b"), mjs: BADGE("JS", "#f0db4f", "#1b1b1b"), cjs: BADGE("JS", "#f0db4f", "#1b1b1b"),
  json: GLYPH("braces", "#f0c94a"), jsonc: GLYPH("braces", "#f0c94a"), json5: GLYPH("braces", "#f0c94a"),
  html: GLYPH("code", "#e44d26"), htm: GLYPH("code", "#e44d26"), xml: GLYPH("code", "#f1662a"), vue: BADGE("V", "#41b883"), svelte: BADGE("S", "#ff3e00"), astro: BADGE("A", "#ff5d01"),
  css: GLYPH("hash", "#42a5f5"), scss: GLYPH("hash", "#f06292"), sass: GLYPH("hash", "#f06292"), less: GLYPH("hash", "#5b7bd5"),
  md: BADGE("M", "#42a5f5"), mdx: BADGE("MX", "#f9ac00", "#1b1b1b"),
  py: BADGE("PY", "#3776ab"), rb: BADGE("RB", "#cc342d"), php: BADGE("PHP", "#777bb4"), go: BADGE("GO", "#00add8"), rs: BADGE("RS", "#dea584", "#1b1b1b"),
  java: BADGE("J", "#e76f00"), kt: BADGE("K", "#7f52ff"), kts: BADGE("K", "#7f52ff"), swift: BADGE("SW", "#f05138"), dart: BADGE("DT", "#0175c2"),
  c: BADGE("C", "#5c6bc0"), h: BADGE("H", "#7e57c2"), cpp: BADGE("C++", "#00599c"), hpp: BADGE("H", "#7e57c2"), cs: BADGE("C#", "#68217a"),
  lua: BADGE("LU", "#000080"), r: BADGE("R", "#276dc3"), ex: BADGE("EX", "#6e4a7e"), exs: BADGE("EX", "#6e4a7e"), zig: BADGE("Z", "#f7a41d", "#1b1b1b"),
  sh: GLYPH("terminal", "#89e051"), bash: GLYPH("terminal", "#89e051"), zsh: GLYPH("terminal", "#89e051"), fish: GLYPH("terminal", "#89e051"),
  ps1: GLYPH("terminal", "#5391fe"), bat: GLYPH("terminal", "#c1f12e"), cmd: GLYPH("terminal", "#c1f12e"),
  sql: GLYPH("db", "#e38c00"), prisma: GLYPH("db", "#5a67d8"), graphql: BADGE("GQ", "#e535ab"), gql: BADGE("GQ", "#e535ab"),
  yml: GLYPH("gear", "#cb6ce6"), yaml: GLYPH("gear", "#cb6ce6"), toml: GLYPH("gear", "#9c4221"), ini: GLYPH("gear", "#9aa5b1"), conf: GLYPH("gear", "#9aa5b1"),
  cfg: GLYPH("gear", "#9aa5b1"), properties: GLYPH("gear", "#9aa5b1"), env: GLYPH("gear", "#f5d547"), lock: GLYPH("lock", "#9aa5b1"),
  png: GLYPH("image", "#26a69a"), jpg: GLYPH("image", "#26a69a"), jpeg: GLYPH("image", "#26a69a"), gif: GLYPH("image", "#26a69a"), webp: GLYPH("image", "#26a69a"),
  bmp: GLYPH("image", "#26a69a"), ico: GLYPH("image", "#f5d547"), svg: GLYPH("image", "#ffb13b"), avif: GLYPH("image", "#26a69a"),
  pdf: GLYPH("pdf", "#e53935"), txt: GLYPH("text", "#9aa5b1"), log: GLYPH("text", "#8d6e63"), csv: GLYPH("text", "#43a047"),
  zip: GLYPH("archive", "#afb42b"), gz: GLYPH("archive", "#afb42b"), tar: GLYPH("archive", "#afb42b"), tgz: GLYPH("archive", "#afb42b"), "7z": GLYPH("archive", "#afb42b"), rar: GLYPH("archive", "#afb42b"),
  pem: GLYPH("key", "#e5c07b"), key: GLYPH("key", "#e5c07b"), crt: GLYPH("key", "#e5c07b"),
};
export const FOLDER = "#dcb67a";
export function fileType(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env") || lower.endsWith(".env")) return BY_EXT.env;
  if (lower.startsWith("dockerfile")) return BY_NAME.dockerfile;
  if (lower.startsWith(".eslintrc") || lower.startsWith(".prettierrc")) return BY_NAME[lower.startsWith(".e") ? ".eslintrc" : ".prettierrc"];
  if (lower.startsWith("readme")) return BY_NAME.readme;
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return BY_EXT[ext] ?? null;
}

// A file's icon: its type's badge or glyph, else a plain page.
export function typeIcon(base, name, t, size = 15) {
  const type = fileType(name);
  if (!type) return svg(`${base}/file.svg`).size(size).flex_none().text_color(t.muted);
  if (type.glyph) return svg(`${base}/ft-${type.glyph}.svg`).size(size).flex_none().text_color(type.color);
  const n = type.badge.length;
  return div().w(size + 1).h(size - 1).flex_none().flex().items_center().justify_center().rounded(3).bg(type.bg).text_color(type.fg)
    .text_size(n > 2 ? 6 : n > 1 ? 7.5 : 9).font_semibold().line_height(`${size - 1}px`).child(type.badge);
}

// A folder, shut or open.
export function folderIcon(base, open, size = 16) {
  return svg(`${base}/ft-folder${open ? "-open" : ""}.svg`).size(size).flex_none().text_color(FOLDER);
}
