/** Events the app sends the host besides logs (live frames). The client sets the sink while connected. */

export type EventSink = (event: string, data: unknown) => void;

let sink: EventSink | null = null;

export function setEventSink(next: EventSink | null): void {
  sink = next;
}

/** Whether a host is connected to receive events. */
export function hasEventSink(): boolean {
  return sink !== null;
}

/** Sends an event to the connected host; does nothing while disconnected. Never throws. */
export function emitEvent(event: string, data: unknown): void {
  const target = sink;
  if (!target) return;
  try {
    target(event, data);
  } catch {
    // a broken socket must never reach the app
  }
}
