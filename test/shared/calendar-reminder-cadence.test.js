const assert = require('node:assert/strict')
const test = require('node:test')

test('calendar-reminder-cadence', async (t) => {
  const { isCalendarReminderDue, daysSince, START_DAY, FOLLOWUP_DAYS, REMINDER_CAP } =
    await import('../../supabase/functions/_shared/calendar-reminder-cadence.ts')

  await t.test('nothing goes out before the 15th, even for a never-reminded family', () => {
    assert.equal(isCalendarReminderDue(14, null, 0), false)
    assert.equal(isCalendarReminderDue(1, null, 0), false)
  })

  await t.test('a never-reminded family is due on or after the 15th', () => {
    assert.equal(isCalendarReminderDue(START_DAY, null, 0), true)
    assert.equal(isCalendarReminderDue(28, null, 0), true)
  })

  await t.test('a follow-up waits a full week from the last send', () => {
    const now = new Date('2026-09-22T14:00:00Z')
    const sixDaysAgo = new Date('2026-09-16T14:00:00Z').toISOString()
    const sevenDaysAgo = new Date('2026-09-15T14:00:00Z').toISOString()
    assert.equal(isCalendarReminderDue(22, sixDaysAgo, 1, now), false)
    assert.equal(isCalendarReminderDue(22, sevenDaysAgo, 1, now), true)
  })

  await t.test('stops once REMINDER_CAP reminders have gone out this month, regardless of elapsed time', () => {
    const now = new Date('2026-09-29T14:00:00Z')
    const longAgo = new Date('2026-09-01T14:00:00Z').toISOString()
    assert.equal(isCalendarReminderDue(29, longAgo, REMINDER_CAP, now), false)
    assert.equal(isCalendarReminderDue(29, longAgo, REMINDER_CAP - 1, now), true)
  })

  await t.test('daysSince treats a null timestamp as infinitely long ago', () => {
    assert.equal(daysSince(null), Infinity)
  })

  await t.test('constants match the documented weekly-starting-the-15th, capped-at-3 policy', () => {
    assert.equal(START_DAY, 15)
    assert.equal(FOLLOWUP_DAYS, 7)
    assert.equal(REMINDER_CAP, 3)
  })
})
