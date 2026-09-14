/**
 * Calendar provider boundary. PROVISIONAL — finalized in Phase 3.
 * No adapters exist in Phase 0.
 */

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface CalendarProvider {
  readonly name: string;
  findAvailableSlots(range: TimeSlot, durationMinutes: number): Promise<TimeSlot[]>;
}
