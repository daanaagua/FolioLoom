export type KernelEventType =
  | "started"
  | "model"
  | "tool"
  | "validation"
  | "degraded"
  | "finished";

export interface KernelEvent {
  readonly sequence: number;
  readonly type: KernelEventType;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class MemoryEventLog {
  private readonly entries: KernelEvent[] = [];

  public append(
    type: KernelEventType,
    payload: Readonly<Record<string, unknown>>,
  ): KernelEvent {
    const event: KernelEvent = {
      sequence: this.entries.length + 1,
      type,
      timestamp: new Date().toISOString(),
      payload: { ...payload },
    };
    this.entries.push(event);
    return event;
  }

  public events(): readonly KernelEvent[] {
    return this.entries.map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }
}
