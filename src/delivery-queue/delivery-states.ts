/**
 * The C02 delivery states, alone, so a process that loads TypeScript with type
 * stripping only (the Node orchestrator, through the metric registry) can read
 * them without loading the queue.
 */
export const DELIVERY_STATES = ["queued", "leased", "delivered", "cancelled", "dead_letter", "outcome_unknown"] as const;

export type DurableDeliveryState = typeof DELIVERY_STATES[number];
