import { swc } from "./siteid";
/** One-shot page control query. Cancellation never invokes the callback.
    Transfer does not release the local endpoint; settle closes both. */
export function controlQuery(message: unknown, reply: (data: any) => void, timeout = 5000): () => void {
  const ch = new MessageChannel();
  let done = false;
  let posted = false;
  let serviceWorker: ServiceWorkerContainer | null = null;
  const onControllerChange = () => {
    const ctl = swc();
    if (ctl) send(ctl);
  };
  const finish = (data?: unknown, notify = true) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    ch.port1.onmessage = null;
    ch.port1.close();
    ch.port2.close();
    if (notify) reply(data);
  };
  const send = (ctl?: ServiceWorker | null) => {
    if (done || posted) return;
    if (!ctl) {
      finish();
      return;
    }
    try {
      posted = true;
      ctl.postMessage(message, [ch.port2]);
    } catch {
      finish();
    }
  };
  const timer = setTimeout(finish, timeout);
  ch.port1.onmessage = (e) => finish(e.data);
  const ctl = swc();
  if (ctl) {
    send(ctl);
  } else {
    serviceWorker = navigator.serviceWorker ?? null;
    if (!serviceWorker) {
      queueMicrotask(() => finish());
    } else {
      serviceWorker.addEventListener("controllerchange", onControllerChange);
      void serviceWorker.ready.then(
        (reg) => send(serviceWorker?.controller ?? reg.active ?? reg.waiting ?? reg.installing),
        () => finish(),
      );
    }
  }
  return () => finish(undefined, false);
}
