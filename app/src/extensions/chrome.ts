/* Only adapt known asynchronous methods: event registration and
   synchronous methods also accept functions and must pass unchanged. */
const CALLBACK_METHODS = new Set([
  "runtime.sendMessage",
  "runtime.getPlatformInfo",
  "runtime.getBrowserInfo",
  "tabs.get", "tabs.getCurrent", "tabs.query", "tabs.create", "tabs.update", "tabs.remove", "tabs.sendMessage",
  "windows.get", "windows.getCurrent", "windows.getLastFocused", "windows.getAll",
  "scripting.executeScript", "scripting.insertCSS",
  "contextMenus.remove", "contextMenus.removeAll", "menus.remove", "menus.removeAll",
  "downloads.download", "downloads.search",
  "i18n.getAcceptLanguages",
  "permissions.contains", "permissions.getAll", "permissions.request", "permissions.remove",
  "notifications.create", "notifications.update", "notifications.clear", "notifications.getAll",
  "cookies.get", "cookies.getAll", "cookies.set", "cookies.remove",
  "alarms.get", "alarms.getAll", "alarms.clear", "alarms.clearAll",
  "management.getSelf", "management.get", "management.getAll", "management.setEnabled", "management.uninstall", "management.uninstallSelf",
  ...["local", "sync", "session"].flatMap((area) =>
    ["get", "set", "remove", "clear", "getBytesInUse"].map((method) => "storage." + area + "." + method)),
]);

export function chromeApi(browser: Record<string, unknown>): Record<string, unknown> {
  let lastError: { message: string } | undefined;
  const copies = new WeakMap<object, Record<string, unknown>>();
  const copy = (source: Record<string, unknown>, path = ""): Record<string, unknown> => {
    const previous = copies.get(source);
    if (previous) return previous;
    const out: Record<string, unknown> = {};
    copies.set(source, out);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
      const methodPath = path ? path + "." + key : key;
      if (typeof descriptor.value === "function" && CALLBACK_METHODS.has(methodPath)) {
        const method = descriptor.value as (...args: unknown[]) => unknown;
        descriptor.value = (...args: unknown[]) => {
          const callback = args[args.length - 1];
          if (typeof callback !== "function") return method.apply(source, args);
          args.pop();
          const respond = (value: unknown, failed = false, error?: unknown): void => {
            /* Extension exceptions must not reject the engine's Promise. */
            queueMicrotask(() => {
              const saved = lastError;
              lastError = !failed ? undefined : { message: error instanceof Error ? error.message : String(error) };
              try {
                if (value === undefined) callback();
                else callback(value);
              } finally {
                lastError = saved;
              }
            });
          };
          try {
            Promise.resolve(method.apply(source, args)).then(
              (value) => respond(value),
              (error: unknown) => respond(undefined, true, error),
            );
          } catch (error) {
            respond(undefined, true, error);
          }
          return undefined;
        };
      } else if (descriptor.value && typeof descriptor.value === "object" &&
        Object.getPrototypeOf(descriptor.value) === Object.prototype) {
        descriptor.value = copy(descriptor.value as Record<string, unknown>, methodPath);
      }
      Object.defineProperty(out, key, descriptor);
    }
    return out;
  };
  const chrome = copy(browser);
  Object.defineProperty(chrome.runtime, "lastError", { enumerable: true, get: () => lastError });
  return chrome;
}
