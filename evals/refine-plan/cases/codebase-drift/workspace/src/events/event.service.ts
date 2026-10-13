import { db } from "../db";

export interface RecordedEvent {
  id: string;
  type: string;
  payload: unknown;
  recordedAt: Date;
}

export class EventService {
  async record(type: string, payload: unknown): Promise<RecordedEvent> {
    return db.events.insert({ type, payload });
  }
}
