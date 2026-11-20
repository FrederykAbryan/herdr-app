// LD_PRELOAD shim for a released herdr-app (GPUI) on GNOME Wayland. Builds from this
// fork already have the fix (vendor/gpui-pre-linux wayland/window.rs, 39f022d); this is
// for running the official build without a rebuild.
//
// GPUI calls xdg_surface.get_toplevel, then builds its wgpu renderer, and only
// ~76 ms later sends xdg_toplevel.set_app_id. In between, gnome-shell can't
// match the window to herdr-app.desktop and shows the generic gear icon.
// This shim sends set_app_id in the same request batch as get_toplevel.
//
// herdr-app dlopen()s libwayland-client and dlsym()s from that handle, so plain
// symbol interposition isn't enough: dlopen("libwayland-client.so*") is
// redirected to this library, which re-exports libwayland-client (DT_NEEDED)
// and overrides the two constructor calls.
//
// Build: gcc -shared -fPIC -O2 -o herdr-appid-shim.so herdr-appid-shim.c -ldl -lwayland-client
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <wayland-client-core.h>

#define XDG_SURFACE_GET_TOPLEVEL 1
#define XDG_TOPLEVEL_SET_APP_ID 3

static const char *app_id = "herdr-app";
static char self_path[4096];

typedef void *(*dlopen_fn)(const char *, int);
typedef struct wl_proxy *(*ctor_v_fn)(struct wl_proxy *, uint32_t, union wl_argument *,
                                      const struct wl_interface *, uint32_t);
typedef struct wl_proxy *(*ctor_fn)(struct wl_proxy *, uint32_t, union wl_argument *,
                                    const struct wl_interface *);
typedef void (*marshal_array_fn)(struct wl_proxy *, uint32_t, union wl_argument *);

__attribute__((constructor)) static void init(void) {
    const char *env = getenv("HERDR_APP_ID");
    if (env && *env) app_id = strdup(env);
    Dl_info info;
    if (dladdr((void *)init, &info) && info.dli_fname)
        strncpy(self_path, info.dli_fname, sizeof self_path - 1);
}

void *dlopen(const char *file, int flags) {
    static dlopen_fn real;
    if (!real) real = (dlopen_fn)dlsym(RTLD_NEXT, "dlopen");
    if (file && self_path[0] && strstr(file, "libwayland-client.so")) {
        // herdr-app re-execs itself at startup, so the env must survive until
        // the window opens. From here on, keep it out of what the app spawns
        // (herdr-core, which in turn starts shells and agents).
        unsetenv("LD_PRELOAD");
        unsetenv("HERDR_APP_ID");
        return real(self_path, flags);
    }
    return real(file, flags);
}

static void maybe_set_app_id(struct wl_proxy *parent, uint32_t opcode, struct wl_proxy *made) {
    if (!made || opcode != XDG_SURFACE_GET_TOPLEVEL) return;
    const char *cls = wl_proxy_get_class(parent);
    if (!cls || strcmp(cls, "xdg_surface") != 0) return;
    static marshal_array_fn marshal;
    if (!marshal) marshal = (marshal_array_fn)dlsym(RTLD_NEXT, "wl_proxy_marshal_array");
    if (!marshal) return;
    union wl_argument args[1];
    args[0].s = app_id;
    marshal(made, XDG_TOPLEVEL_SET_APP_ID, args);
}

struct wl_proxy *wl_proxy_marshal_array_constructor_versioned(
        struct wl_proxy *proxy, uint32_t opcode, union wl_argument *args,
        const struct wl_interface *iface, uint32_t version) {
    static ctor_v_fn real;
    if (!real) real = (ctor_v_fn)dlsym(RTLD_NEXT, "wl_proxy_marshal_array_constructor_versioned");
    struct wl_proxy *made = real(proxy, opcode, args, iface, version);
    maybe_set_app_id(proxy, opcode, made);
    return made;
}

struct wl_proxy *wl_proxy_marshal_array_constructor(
        struct wl_proxy *proxy, uint32_t opcode, union wl_argument *args,
        const struct wl_interface *iface) {
    static ctor_fn real;
    if (!real) real = (ctor_fn)dlsym(RTLD_NEXT, "wl_proxy_marshal_array_constructor");
    struct wl_proxy *made = real(proxy, opcode, args, iface);
    maybe_set_app_id(proxy, opcode, made);
    return made;
}
