// ============================================================
// calendar-reminder-cadence — pure scheduling rule for
// send-calendar-reminders, split out so the "nothing before the 15th,
// weekly follow-ups, capped at 3" policy can be unit tested without a
// live database, a clock, or a Resend call.
// ============================================================

export const START_DAY = 15;
export const FOLLOWUP_DAYS = 7;
export const REMINDER_CAP = 3;

export function daysSince(iso: string | null, now: Date = new Date()): number {
    if (!iso) return Infinity;
    return (now.getTime() - new Date(iso).getTime()) / 86400000;
}

/**
 * Whether a family still missing this month's calendar should be reminded
 * today. Mirrors send-waitlist-reminders' first-reminder/follow-up/cap
 * shape, but the "first reminder" gate is a fixed day of month (the 15th)
 * rather than a relative delay, and the cap/count reset every month since
 * calendar_reminder_log is keyed by (family_id, month_key).
 */
export function isCalendarReminderDue(
    dayOfMonth: number,
    lastSentAt: string | null,
    sendCount: number,
    now: Date = new Date(),
): boolean {
    if (dayOfMonth < START_DAY) return false;
    if (sendCount >= REMINDER_CAP) return false;
    if (!lastSentAt) return true;
    return daysSince(lastSentAt, now) >= FOLLOWUP_DAYS;
}
