// The tab bar's Run button and its menu (mods/run-menu): a project's run commands, each started
// in a tab of its own. Kept identical in tabs/ and run-menu/ (a mod imports only from its folder).
//
// The project is recognised from its files, so each kind runs its own way: Laravel (artisan)
// serves with `php artisan serve` (its Vite assets are a second group), Node with package.json
// scripts and the lockfile's package manager, Flutter, Django, Cargo and Go with theirs.
//
// Shared "run.state" = { [project folder]: { last: command id, tabs: { command id: tab id } } }.
import { exec, readTextFile, shared, setShared, spaces, run } from "herdr";

export const RUN = "run.state";
const MARKERS = ["artisan", "composer.json", "package.json", "pubspec.yaml", "manage.py", "Cargo.toml", "go.mod",
  "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
// Lifecycle hooks aren't things you run: composer's pre-/post- events, npm's install/publish
// hooks and the pre/post companions of another script (but `preview` stays).
const composerHook = (n) => /^(pre|post)-/.test(n);
const NPM_HOOKS = new Set(["prepare", "prepublish", "prepublishOnly", "preinstall", "install", "postinstall", "preuninstall", "postuninstall",
  "prepack", "postpack", "preversion", "version", "postversion", "postpublish", "preshrinkwrap", "shrinkwrap", "postshrinkwrap"]);
const npmHook = (n, names) => NPM_HOOKS.has(n) || (/^(pre|post)/.test(n) && names.includes(n.replace(/^(pre|post)/, "")));

const json = async (path, on) => {
  const text = await readTextFile(path, { on }).catch(() => null);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};
const cmd = (group, id, label, argv) => ({ group, id, label, argv, text: argv.join(" ") });

// Which Node framework a package.json is, for the menu's heading.
function nodeKind(pkg) {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [dep, name] of [["next", "Next.js"], ["nuxt", "Nuxt"], ["expo", "Expo"], ["@sveltejs/kit", "SvelteKit"], ["astro", "Astro"],
    ["@nestjs/core", "NestJS"], ["@angular/core", "Angular"], ["react-native", "React Native"], ["electron", "Electron"], ["vite", "Vite"],
    ["express", "Express"], ["fastify", "Fastify"], ["hono", "Hono"]]) if (dep in deps) return name;
  return "Node";
}

async function inspect(dir, on) {
  const r = await exec("sh", ["-c", `for f in ${MARKERS.join(" ")}; do [ -e "$f" ] && echo "$f"; done; true`], { cwd: dir, on }).catch(() => null);
  const has = new Set((r?.stdout ?? "").split("\n").filter(Boolean));
  const commands = [], kinds = [];
  let first = null;

  if (has.has("artisan")) {
    const composer = (await json(`${dir}/composer.json`, on)) ?? {};
    const req = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
    const scripts = Object.keys(composer.scripts ?? {}).filter((n) => !composerHook(n));
    kinds.push("Laravel");
    // Laravel 11+'s `composer run dev` starts the server, queue, logs and Vite together.
    if (scripts.includes("dev")) commands.push(cmd("Laravel", "composer:dev", "Dev", ["composer", "run", "dev"]));
    commands.push(cmd("Laravel", "artisan:serve", "Serve", ["php", "artisan", "serve"]));
    if ("laravel/octane" in req) commands.push(cmd("Laravel", "artisan:octane", "Octane", ["php", "artisan", "octane:start", "--watch"]));
    if ("laravel/reverb" in req) commands.push(cmd("Laravel", "artisan:reverb", "Reverb", ["php", "artisan", "reverb:start", "--debug"]));
    if ("laravel/horizon" in req) commands.push(cmd("Laravel", "artisan:horizon", "Horizon", ["php", "artisan", "horizon"]));
    else commands.push(cmd("Laravel", "artisan:queue", "Queue", ["php", "artisan", "queue:work"]));
    commands.push(cmd("Laravel", "artisan:schedule", "Schedule", ["php", "artisan", "schedule:work"]));
    commands.push(cmd("Laravel", "artisan:migrate", "Migrate", ["php", "artisan", "migrate"]));
    commands.push(cmd("Laravel", "artisan:tinker", "Tinker", ["php", "artisan", "tinker"]));
    commands.push(cmd("Laravel", "artisan:clear", "Clear caches", ["php", "artisan", "optimize:clear"]));
    for (const n of scripts.filter((n) => n !== "dev")) commands.push(cmd("Composer", `composer:${n}`, n, ["composer", "run", n]));
    first = commands[0].id;
  } else if (has.has("composer.json")) {
    const composer = (await json(`${dir}/composer.json`, on)) ?? {};
    const scripts = Object.keys(composer.scripts ?? {}).filter((n) => !composerHook(n));
    if (scripts.length) kinds.push("PHP");
    for (const n of scripts) commands.push(cmd("Composer", `composer:${n}`, n, ["composer", "run", n]));
  }

  if (has.has("manage.py")) {
    kinds.push("Django");
    commands.push(cmd("Django", "django:runserver", "Runserver", ["python", "manage.py", "runserver"]));
    commands.push(cmd("Django", "django:migrate", "Migrate", ["python", "manage.py", "migrate"]));
    commands.push(cmd("Django", "django:shell", "Shell", ["python", "manage.py", "shell"]));
    first ??= "django:runserver";
  }

  if (has.has("pubspec.yaml")) {
    kinds.push("Flutter");
    commands.push(cmd("Flutter", "flutter:run", "Run", ["flutter", "run"]));
    commands.push(cmd("Flutter", "flutter:release", "Run release", ["flutter", "run", "--release"]));
    commands.push(cmd("Flutter", "flutter:test", "Test", ["flutter", "test"]));
    commands.push(cmd("Flutter", "flutter:get", "Pub get", ["flutter", "pub", "get"]));
    commands.push(cmd("Flutter", "flutter:clean", "Clean", ["flutter", "clean"]));
    first ??= "flutter:run";
  }

  if (has.has("Cargo.toml")) {
    kinds.push("Rust");
    for (const [n, a] of [["Run", ["cargo", "run"]], ["Build", ["cargo", "build"]], ["Test", ["cargo", "test"]]]) commands.push(cmd("Cargo", `cargo:${n}`, n, a));
    first ??= "cargo:Run";
  }
  if (has.has("go.mod")) {
    kinds.push("Go");
    for (const [n, a] of [["Run", ["go", "run", "."]], ["Build", ["go", "build", "./..."]], ["Test", ["go", "test", "./..."]]]) commands.push(cmd("Go", `go:${n}`, n, a));
    first ??= "go:Run";
  }

  if (has.has("package.json")) {
    const pkg = (await json(`${dir}/package.json`, on)) ?? {};
    const names = Object.keys(pkg.scripts ?? {});
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([n]) => !npmHook(n, names));
    if (scripts.length) {
      const pm = has.has("pnpm-lock.yaml") ? "pnpm" : has.has("yarn.lock") ? "yarn" : has.has("bun.lockb") || has.has("bun.lock") ? "bun" : "npm";
      // In a Laravel app package.json is only its assets: say so.
      const group = kinds.includes("Laravel") ? `Vite assets · ${pm}` : `${nodeKind(pkg)} · ${pm}`;
      if (!kinds.length) kinds.push(nodeKind(pkg));
      for (const [n, v] of scripts) commands.push({ ...cmd(group, `npm:${n}`, n, [pm, "run", n]), text: `${pm} run ${n}`, detail: String(v) });
      first ??= ["dev", "start", "serve", "develop"].map((n) => `npm:${n}`).find((id) => commands.some((c) => c.id === id)) ?? `npm:${scripts[0][0]}`;
    }
  }

  if (!commands.length) return null;
  return { dir, on, kind: kinds.join(" + "), commands, first: first ?? commands[0].id };
}

// The project around `cwd`: the folder itself if it is one, else the repo's top.
export async function discover(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on })
    .then((r) => (r.code === 0 ? r.stdout.trim() : null)).catch(() => null);
  for (const dir of [...new Set([cwd, top].filter(Boolean))]) {
    const info = await inspect(dir, on);
    if (info) return info;
  }
  return null;
}

const entry = (dir) => (shared(RUN) ?? {})[dir] ?? { last: null, tabs: {} };
const put = (dir, e) => setShared(RUN, { ...(shared(RUN) ?? {}), [dir]: e });
export const byId = (info, id) => info.commands.find((c) => c.id === id) ?? null;

// The command the button runs: the last one started here, else the project kind's main one.
export function current(info) {
  const last = entry(info.dir).last;
  return byId(info, last) ?? byId(info, info.first) ?? info.commands[0];
}

// The open tab a command runs in, or null.
export function runningTab(info, c) {
  const id = entry(info.dir).tabs?.[c.id];
  return id && spaces().some((s) => s.tabs.some((t) => t.id === id)) ? id : null;
}

// Starts a command in a new tab named after it (restarting it if it's running) and shows it.
// The tab's shell stays open when the command ends, so its output can still be read.
export async function start(info, c, space) {
  const live = runningTab(info, c);
  if (live) run("tab.close", { id: live, confirmed: true });
  const args = { name: c.label.toLowerCase(), folder: info.dir, argv: c.argv };
  if (space) args.space = space;
  // Through the CLI: it prints the new tab's id, which run() doesn't return.
  const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]).catch(() => null);
  let tab = null;
  try { tab = JSON.parse(r?.stdout ?? "").tab ?? null; } catch {}
  const e = entry(info.dir);
  put(info.dir, { last: c.id, tabs: { ...(e.tabs ?? {}), [c.id]: tab } });
  return tab;
}

// Stops a command: closes its tab, which ends the terminal and everything it started.
export function stop(info, c) {
  const id = runningTab(info, c);
  if (id) run("tab.close", { id, confirmed: true });
}

export function show(info, c) {
  const id = runningTab(info, c);
  if (id) run("tab.select", { id });
}
