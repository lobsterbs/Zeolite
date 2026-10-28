import { swc } from "./siteid";
/** One-shot page control query. Cancellation never invokes the callback.
    Transfer does not release the local endpoint; settle closes both. */
export function controlQuery(message: unknown, reply: (data: any) => void, timeout = 5000): () => void {
  const ch = new MessageChannel();
  let done = false;
  const finish = (data?: unknown, notify = true) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ch.port1.onmessage = null;
    ch.port1.close(); ch.port2.close();
    if (notify) reply(data);
  };
  const timer = setTimeout(finish, timeout);
  ch.port1.onmessage = e => finish(e.data);
  try {
    const ctl = swc();
    if (!ctl) throw new Error();
    ctl.postMessage(message, [ch.port2]);
  } catch { queueMicrotask(() => finish()); }
  return () => finish(undefined, false);
}
