/* #454: explicit request-delivery evidence at the transport boundary.
   A rejected fetch after dispatch does NOT establish non-delivery:
   even a message saying "websocket did not open" can be stale.
   Never infer delivery certainty from exception text. */

export type DeliveryState = "definitely-not-delivered" | "delivered-response" | "delivery-unknown";
export type DeliveryTransport = "wisp" | "wisp-route" | "relay";

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
  }
}

/** Reclassify unknown, adapter-originated errors as delivery-unknown
    only AFTER the adapter has actually been invoked. */
export function afterDispatchError(
  transport: DeliveryTransport,
  err: unknown,
): TransportDeliveryError {
  if (err instanceof TransportDeliveryError) return err;
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
  return err instanceof TransportDeliveryError ? err.deliveryState : "delivery-unknown";
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
