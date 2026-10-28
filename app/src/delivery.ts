import { DIAG } from "./diag";

/* #454: explicit request-delivery evidence at the transport boundary.
   A rejected fetch after dispatch does NOT establish non-delivery:
   even a message saying "websocket did not open" can be stale.
   Never infer delivery certainty from exception text. */

export type DeliveryState = "definitely-not-delivered" | "delivered-response" | "delivery-unknown";
export type DeliveryTransport = "wisp" | "wisp-route" | "relay";

const provenance = new WeakMap<object, Exclude<DeliveryState, "delivered-response">>();

export type DeliveryOutcome =
  | { state: "definitely-not-delivered"; transport: DeliveryTransport; cause: unknown }
  | { state: "delivered-response"; transport: DeliveryTransport; response: Response }
  | { state: "delivery-unknown"; transport: DeliveryTransport; cause: unknown };

/** Error for a failed attempt with explicit, conservative provenance.
    The cause is retained for local diagnostics but never used as proof
    that upstream did or did not execute the request. */
export class TransportDeliveryError extends Error {
  override name = "TransportDeliveryError";
  readonly cause: unknown;

  constructor(
    readonly deliveryState: Exclude<DeliveryState, "delivered-response">,
    readonly transport: DeliveryTransport,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    provenance.set(this, deliveryState);
  }
}

/** Reclassify unknown, adapter-originated errors as delivery-unknown
    only AFTER the adapter has actually been invoked. */
export function afterDispatchError(
  transport: DeliveryTransport,
  err: unknown,
): TransportDeliveryError {
  if (err instanceof TransportDeliveryError && deliveryStateOf(err) === "delivery-unknown" && err.transport === transport) return err;
  return new TransportDeliveryError("delivery-unknown", transport, err);
}

/** The only proof of a delivered response is receipt of a Response. */
export function deliveredResponse(
  transport: DeliveryTransport,
  response: Response,
): DeliveryOutcome {
  return { state: "delivered-response", transport, response };
}

/** This may only be emitted before handing a request to any adapter.
    An error string or timeout cannot establish this state. */
export function beforeDispatchFailure(
  transport: DeliveryTransport,
  cause: unknown,
): TransportDeliveryError {
  return new TransportDeliveryError("definitely-not-delivered", transport, cause);
}

export function deliveryStateOf(err: unknown): Exclude<DeliveryState, "delivered-response"> {
  return err !== null && (typeof err === "object" || typeof err === "function")
    ? provenance.get(err) ?? "delivery-unknown" : "delivery-unknown";
}

/** Deliberately conservative. Caller cancellation and one-shot bodies
    are checked separately at transport retry call sites. */
export function deliveryAllowsReplay(
  state: DeliveryState,
  idempotent: boolean,
): boolean {
  if (state === "delivered-response") return false;
  return state === "definitely-not-delivered" || idempotent;
}


export type DeliveryResult = DeliveryOutcome;
export const deliveryState = deliveryStateOf;

function reportDelivery(state: DeliveryState, transport: DeliveryTransport, traceId?: string): void {
  DIAG.emit({ traceId, requestId: traceId, category: "TRANSPORT", severity: "info",
    stage: state === "delivered-response" ? "UPSTREAM_RESPONSE" : "UPSTREAM_REQUEST",
    deliveryState: state, deliveryTransport: transport,
    message: "request delivery: " + state + "; transport=" + transport });
}

export function deliveryFailure(transport: DeliveryTransport, cause: unknown,
  state: "definitely-not-delivered" | "delivery-unknown", traceId?: string): DeliveryResult {
  // Cancellation stays an honest AbortError. Its result can still describe
  // whether dispatch occurred, but it is never used to permit replay.
  const error = cause instanceof Error && cause.name === "AbortError" ? cause :
    state === "delivery-unknown" ? afterDispatchError(transport, cause) : beforeDispatchFailure(transport, cause);
  reportDelivery(state, transport, traceId);
  return { state, transport, cause: error };
}

export function deliverySuccess(transport: DeliveryTransport, response: Response, traceId?: string): DeliveryResult {
  reportDelivery("delivered-response", transport, traceId);
  return deliveredResponse(transport, response);
}

/** The actual adapter call is the conservative dispatch boundary. A failure
    afterwards remains unknown even if an adapter reuses a pre-dispatch error. */
export async function attemptDelivery(transport: DeliveryTransport, send: () => Promise<Response>, traceId?: string): Promise<DeliveryResult> {
  try { return deliverySuccess(transport, await send(), traceId); }
  catch (cause) { return deliveryFailure(transport, cause, "delivery-unknown", traceId); }
}

export function deliveryResponse(result: DeliveryResult): Response {
  if (result.state === "delivered-response") return result.response;
  throw result.cause;
}

/** Only use around initialization that cannot dispatch this target request. */
export async function prepareDelivery(transport: DeliveryTransport, ready: () => Promise<void>, traceId?: string): Promise<void> {
  try { await ready(); }
  catch (cause) { deliveryResponse(deliveryFailure(transport, cause, "definitely-not-delivered", traceId)); }
}
