import { Prisma } from "@prisma/client";

type TimeEntry = {
  id: string;
  user_id: string;
  shipment_id: string | null;
  checked_in_at: Date;
  checked_out_at: Date | null;
  duration_minutes: number | null;
  notes: string | null;
};

export function durationMinutes(entry: Pick<TimeEntry, "checked_in_at" | "checked_out_at" | "duration_minutes">, now = new Date()) {
  if (entry.duration_minutes != null) return entry.duration_minutes;
  const end = entry.checked_out_at ?? now;
  return Math.max(Math.round((end.getTime() - entry.checked_in_at.getTime()) / 60000), 0);
}

export function serializeTimeEntry(entry: TimeEntry, now = new Date()) {
  const active = !entry.checked_out_at;
  const minutes = durationMinutes(entry, now);

  return {
    ...entry,
    staffId: entry.user_id,
    staff_id: entry.user_id,
    userId: entry.user_id,
    user_id: entry.user_id,
    shipmentId: entry.shipment_id,
    shipment_id: entry.shipment_id,
    checkInAt: entry.checked_in_at,
    check_in_at: entry.checked_in_at,
    checkedInAt: entry.checked_in_at,
    checked_in_at: entry.checked_in_at,
    clockInAt: entry.checked_in_at,
    clock_in_at: entry.checked_in_at,
    checkOutAt: entry.checked_out_at,
    check_out_at: entry.checked_out_at,
    checkedOutAt: entry.checked_out_at,
    checked_out_at: entry.checked_out_at,
    clockOutAt: entry.checked_out_at,
    clock_out_at: entry.checked_out_at,
    durationMinutes: minutes,
    duration_minutes: minutes,
    status: active ? "active" : "completed",
  };
}

export function timeEntrySelect() {
  return {
    id: true,
    user_id: true,
    shipment_id: true,
    checked_in_at: true,
    checked_out_at: true,
    duration_minutes: true,
    notes: true,
  } satisfies Prisma.staff_check_insSelect;
}
