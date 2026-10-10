// Stand's bit of native Mac code, loaded by main.js as a Node-API module. It's built by
// scripts/build-native.js with Apple's command line tools, for Apple silicon and Intel.
//
// preventActivation(handle) makes a click on that window leave Stand in the background, the
// way a click on a Spotlight-style panel does. Electron's "panel" windows only look
// non-activating to AppKit's own code, not to the window server, so a click on the floating
// bar still made Stand the active app and brought its window up. Returns whether the window
// now prevents activation.

#import <AppKit/AppKit.h>
#import <objc/message.h>
#include <stddef.h>
#include <stdint.h>

// The few Node-API calls used here, declared directly so the build needs no Node headers.
// Node-API is a stable C interface; these match js_native_api.h.
extern "C" {
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;  // 0 is napi_ok
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv,
                             napi_value* this_arg, void** data);
napi_status napi_get_buffer_info(napi_env env, napi_value value, void** data, size_t* length);
napi_status napi_get_boolean(napi_env env, bool value, napi_value* result);
napi_status napi_create_function(napi_env env, const char* utf8name, size_t length, napi_callback cb, void* data,
                                 napi_value* result);
napi_status napi_set_named_property(napi_env env, napi_value object, const char* utf8name, napi_value value);
}

/** The window behind the Buffer from Electron's getNativeWindowHandle(), which holds an NSView*. */
static NSWindow* WindowFrom(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 1) return nil;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != 0 || length < sizeof(void*)) return nil;
  NSView* view = (__bridge NSView*)(*(void**)data);
  return [view window];
}

static napi_value PreventActivation(napi_env env, napi_callback_info info) {
  bool done = false;
  NSWindow* window = WindowFrom(env, info);
  // What NSPanel uses for its non-activating style: it tags the window with the window server.
  SEL set = NSSelectorFromString(@"_setPreventsActivation:");
  SEL get = NSSelectorFromString(@"_preventsActivation");
  if (window && [window respondsToSelector:set]) {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(window, set, YES);
    done = [window respondsToSelector:get] ? ((BOOL (*)(id, SEL))objc_msgSend)(window, get) : true;
  }
  napi_value result = nullptr;
  napi_get_boolean(env, done, &result);
  return result;
}

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn = nullptr;
  if (napi_create_function(env, "preventActivation", SIZE_MAX, PreventActivation, nullptr, &fn) == 0)
    napi_set_named_property(env, exports, "preventActivation", fn);
  return exports;
}

extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
