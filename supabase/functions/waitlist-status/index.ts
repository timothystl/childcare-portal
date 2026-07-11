import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_ORIGIN = 'https://mdo.timothystl.org'

const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// settings.value is a TEXT column holding a JSON-encoded string (despite an
// outdated CREATE TABLE comment elsewhere describing it as jsonb) — parse it
// the same way send-waitlist-confirmation/index.ts and the client-side
// loadWaitlistNotifySettings() do.
function parseSettingsValue(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

// ============================================================
// Ported from js/admin/admin-waitlist.js (wlpRunAllocation() and friends).
// Position and estimated-wait figures MUST agree with the admin Waitlist &
// Capacity Planner — this is a deliberate duplication, not drift. If the
// planner's algorithm changes, mirror the change here too.
// ============================================================

const TREND_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// Base ROOMS config (js/supabase.js) — capacity is overridden below from the
// `settings` table (key 'room_capacity') to match the live admin figures.
const BASE_ROOMS: Record<string, { label: string; capacity: number }> = {
  bear:   { label: '🐻 Bear Room',   capacity: 8 },
  bee:    { label: '🐝 Bee Room',    capacity: 16 },
  turtle: { label: '🐢 Turtle Room', capacity: 11 },
  goose:  { label: '🪿 Goose Room',  capacity: 12 },
  owl:    { label: '🦉 Owl Room',    capacity: 11 },
}
// Age-ascending order, same as getSortedRooms() with 'summer' excluded.
const ROOM_ORDER = ['bear', 'bee', 'turtle', 'goose', 'owl']

const PROMOTION_CHAIN: Record<string, { ageOutMonths: number; nextRoom: string | null }> = {
  bear:   { ageOutMonths: 12, nextRoom: 'bee' },
  bee:    { ageOutMonths: 24, nextRoom: 'turtle' },
  turtle: { ageOutMonths: 30, nextRoom: 'goose' },
  goose:  { ageOutMonths: 36, nextRoom: 'owl' },
  owl:    { ageOutMonths: 60, nextRoom: null },
}

type WaitlistApp = {
  id: number
  status: string
  parent_email: string
  child_name: string
  child_dob: string | null
  expected_due_date: string | null
  desired_start_date: string | null
  days_of_week: string | null
  day_type: string | null
  has_sibling: boolean | null
  applied_at: string
}

type RegDate = { care_date: string; waitlisted: boolean; day_type: string | null }
type Registration = {
  child_name: string
  child_dob: string | null
  room_id: string
  registration_dates: RegDate[] | null
}

// Derive room from a waitlist application record — mirrors wlDeriveRoom().
function wlDeriveRoom(app: WaitlistApp): string | null {
  const dobStr = app.child_dob || app.expected_due_date
  if (!dobStr || !app.desired_start_date) return null
  const dob = new Date(dobStr + 'T00:00:00')
  const start = new Date(app.desired_start_date + 'T00:00:00')
  const months = (start.getFullYear() - dob.getFullYear()) * 12 + (start.getMonth() - dob.getMonth())
  if (months < 12) return 'bear'
  if (months < 24) return 'bee'
  if (months < 30) return 'turtle'
  if (months < 36) return 'goose'
  return 'owl'
}

// Mirrors wlpAppDays().
function wlpAppDays(app: WaitlistApp): string[] {
  const named = (app.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean)
  return named.length ? named.filter(d => TREND_DAYS.includes(d)) : TREND_DAYS.slice()
}

// Mirrors wlpDesiredMonthIdx().
function wlpDesiredMonthIdx(app: WaitlistApp, today: Date): number {
  if (!app.desired_start_date) return 0
  const [y, m] = app.desired_start_date.split('-').map(Number)
  const diff = (y - today.getFullYear()) * 12 + (m - 1 - today.getMonth())
  return Math.max(0, Math.min(11, diff))
}

// Mirrors wlpSortByPriority() — sibling priority first, then longest-waiting.
function wlpSortByPriority<T extends { sibling: boolean; appliedAt: string }>(list: T[]): T[] {
  return list.slice().sort((a, b) => {
    const sibA = a.sibling ? 0 : 1, sibB = b.sibling ? 0 : 1
    if (sibA !== sibB) return sibA - sibB
    return new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime()
  })
}

// Mirrors wlpMonths() — 12-month rolling window starting this month.
function wlpMonths(today: Date) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1)
    return { idx: i, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}` }
  })
}

// Mirrors wlpCurrentWeekDates() — this week's Mon-Fri dates (YYYY-MM-DD).
function wlpCurrentWeekDates(today: Date): Record<string, string> {
  const diffToMon = (today.getDay() + 6) % 7
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - diffToMon)
  const out: Record<string, string> = {}
  TREND_DAYS.forEach((day, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    out[day] = d.toLocaleDateString('en-CA')
  })
  return out
}

// Mirrors wlpBaseBooked() — this week's live Mon-Fri bookings per room/day.
function wlpBaseBooked(registrations: Registration[], today: Date): Record<string, Record<string, number>> {
  const weekDates = wlpCurrentWeekDates(today)
  const dateToDay: Record<string, string> = {}
  Object.entries(weekDates).forEach(([day, date]) => { dateToDay[date] = day })

  const booked: Record<string, Record<string, number>> = {}
  ROOM_ORDER.forEach(id => { booked[id] = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 } })

  registrations.forEach(reg => {
    if (!booked[reg.room_id]) return
    ;(reg.registration_dates || []).forEach(d => {
      if (d.waitlisted || !d.care_date) return
      const day = dateToDay[d.care_date]
      if (day) booked[reg.room_id][day]++
    })
  })
  return booked
}

function trendDayName(dateStr: string): string | null {
  const idx = new Date(dateStr + 'T12:00:00').getDay() - 1
  return idx >= 0 && idx <= 4 ? TREND_DAYS[idx] : null
}

function weekdayDayTypeMap(reg: Registration): Record<string, string> {
  const map: Record<string, string> = {}
  ;(reg.registration_dates || []).forEach(d => {
    if (d.waitlisted || !d.care_date) return
    const day = trendDayName(d.care_date)
    if (day) map[day] = d.day_type === 'half' ? 'half' : 'full'
  })
  return map
}

// Mirrors _buildGraduationIndex().
function buildGraduationIndex(registrations: Registration[]) {
  const gradOut: Record<string, Record<string, { childName: string; weekdays: Record<string, string> }[]>> = {}
  const gradIn: Record<string, Record<string, { childName: string; weekdays: Record<string, string> }[]>> = {}
  const seen = new Set<string>()

  registrations.forEach(reg => {
    const chain = PROMOTION_CHAIN[reg.room_id]
    if (!chain || !reg.child_dob) return
    const key = `${reg.child_name}:${reg.room_id}`
    if (seen.has(key)) return
    seen.add(key)

    const weekdays = weekdayDayTypeMap(reg)
    if (!Object.keys(weekdays).length) return

    const dob = new Date(reg.child_dob)
    const graduates = new Date(dob.getFullYear(), dob.getMonth() + chain.ageOutMonths, 1)
    const moKey = `${graduates.getFullYear()}-${String(graduates.getMonth() + 1).padStart(2, '0')}`

    if (!gradOut[moKey]) gradOut[moKey] = {}
    if (!gradOut[moKey][reg.room_id]) gradOut[moKey][reg.room_id] = []
    gradOut[moKey][reg.room_id].push({ childName: reg.child_name, weekdays })

    if (chain.nextRoom) {
      if (!gradIn[moKey]) gradIn[moKey] = {}
      if (!gradIn[moKey][chain.nextRoom]) gradIn[moKey][chain.nextRoom] = []
      gradIn[moKey][chain.nextRoom].push({ childName: reg.child_name, weekdays })
    }
  })
  return { gradOut, gradIn }
}

// Mirrors wlpGradEvents() — reshapes the 'YYYY-MM'-keyed graduation index
// into { [roomId]: { [monthIdx]: [{days}] } } for the 12-month window.
function wlpGradEvents(registrations: Registration[], months: { idx: number; key: string }[]) {
  const { gradOut, gradIn } = buildGraduationIndex(registrations)
  const keyToIdx: Record<string, number> = {}
  months.forEach(m => { keyToIdx[m.key] = m.idx })

  const out: Record<string, Record<number, { days: string[] }[]>> = {}
  const into: Record<string, Record<number, { days: string[] }[]>> = {}
  ROOM_ORDER.forEach(id => { out[id] = {}; into[id] = {} })

  Object.entries(gradOut).forEach(([moKey, byRoom]) => {
    const idx = keyToIdx[moKey]
    if (idx == null) return
    Object.entries(byRoom).forEach(([roomId, kidsArr]) => {
      if (!out[roomId]) return
      out[roomId][idx] = kidsArr.map(k => ({ days: Object.keys(k.weekdays) }))
    })
  })
  Object.entries(gradIn).forEach(([moKey, byRoom]) => {
    const idx = keyToIdx[moKey]
    if (idx == null) return
    Object.entries(byRoom).forEach(([roomId, kidsArr]) => {
      if (!into[roomId]) return
      into[roomId][idx] = kidsArr.map(k => ({ days: Object.keys(k.weekdays) }))
    })
  })
  return { gradOut: out, gradIn: into }
}

// Mirrors wlpComputeGradGrid() — per-room 12-month grid of open slots/weekday.
function wlpComputeGradGrid(
  capacity: number,
  gradOutForRoom: Record<number, { days: string[] }[]>,
  gradInForRoom: Record<number, { days: string[] }[]>,
  baseBookedForRoom: Record<string, number>,
) {
  const booked = { ...baseBookedForRoom }
  const grid: Record<string, number>[] = []
  for (let m = 0; m < 12; m++) {
    ;(gradOutForRoom[m] || []).forEach(ev => ev.days.forEach(d => { booked[d] = Math.max(0, booked[d] - 1) }))
    ;(gradInForRoom[m] || []).forEach(ev => ev.days.forEach(d => { booked[d] = booked[d] + 1 }))
    const openDay: Record<string, number> = {}
    TREND_DAYS.forEach(d => { openDay[d] = Math.max(0, Math.min(capacity, capacity - booked[d])) })
    grid.push(openDay)
  }
  return grid
}

// Mirrors wlpRunAllocation() — the single source of truth the admin planner
// uses for "position" and "fit month". Returns fitMonthByKid + per-room
// priority-sorted queues so the caller can find this one family's numbers.
function runAllocation(apps: WaitlistApp[], registrations: Registration[], capacities: Record<string, number>, today: Date) {
  const months = wlpMonths(today)
  const baseBooked = wlpBaseBooked(registrations, today)
  const { gradOut, gradIn } = wlpGradEvents(registrations, months)

  const gradGridByRoom: Record<string, Record<string, number>[]> = {}
  ROOM_ORDER.forEach(id => {
    const cap = capacities[id] ?? BASE_ROOMS[id].capacity
    gradGridByRoom[id] = wlpComputeGradGrid(cap, gradOut[id], gradIn[id], baseBooked[id])
  })

  const activeApps = apps.filter(a => ['pending', 'offered', 'accepted'].includes(a.status))
  const kids = activeApps.map(a => ({
    id: a.id,
    room: wlDeriveRoom(a),
    days: wlpAppDays(a),
    desiredStartM: wlpDesiredMonthIdx(a, today),
    sibling: !!a.has_sibling,
    appliedAt: a.applied_at,
  })).filter(k => k.room && gradGridByRoom[k.room])

  const working: Record<string, Record<string, number>[]> = {}
  ROOM_ORDER.forEach(id => { working[id] = gradGridByRoom[id].map(day => ({ ...day })) })

  const fitMonthByKid: Record<number, number | null> = {}
  const queueByRoom: Record<string, typeof kids> = {}
  ROOM_ORDER.forEach(id => {
    const roomKids = wlpSortByPriority(kids.filter(k => k.room === id))
    queueByRoom[id] = roomKids
    roomKids.forEach(k => {
      const preGrid = working[id]
      let fitMonth: number | null = null
      for (let m = k.desiredStartM; m < 12; m++) {
        if (k.days.every(d => preGrid[m][d] >= 1)) { fitMonth = m; break }
      }
      fitMonthByKid[k.id] = fitMonth
      if (fitMonth !== null) {
        for (let mm = fitMonth; mm < 12; mm++) {
          k.days.forEach(d => { working[id][mm][d] = Math.max(0, working[id][mm][d] - 1) })
        }
      }
    })
  })

  return { fitMonthByKid, queueByRoom }
}

// Converts a fit-month index (0 = this month) into the soft, honest range
// copy the design calls for — never an exact date. Mirrors the guidance in
// the design handoff: "1-2 months" if the fit month is 1-2 months out.
function waitRangeLabel(fitMonth: number | null): string {
  if (fitMonth === null) return 'Beyond our 12-month forecast'
  if (fitMonth === 0) return 'This month'
  return `${fitMonth} – ${fitMonth + 1} months`
}

function formatDesiredStart(dateStr: string | null): string {
  if (!dateStr) return '—'
  const [y, m] = dateStr.split('-').map(Number)
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`
}

function formatDays(daysOfWeek: string | null): string {
  const named = (daysOfWeek || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!named.length) return 'Mon – Fri'
  return named.join(', ')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email } = await req.json()
    if (!email || typeof email !== 'string') return json({ found: false })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Always run the full pipeline regardless of whether the email matches
    // anything, so a "not found" response costs the same DB work/time as a
    // "found" one — the shape and timing must not leak whether an email
    // exists in the system (see design-handoff security note).
    const [appsRes, regsRes, capRes] = await Promise.all([
      supabase.from('waitlist_applications').select(
        'id, status, parent_email, child_name, child_dob, expected_due_date, desired_start_date, days_of_week, day_type, has_sibling, applied_at',
      ),
      supabase.from('registrations').select(
        'child_name, child_dob, room_id, registration_dates ( care_date, waitlisted, day_type )',
      ),
      supabase.from('settings').select('value').eq('key', 'room_capacity').maybeSingle(),
    ])

    if (appsRes.error || regsRes.error) return json({ found: false })

    const apps: WaitlistApp[] = appsRes.data || []
    const registrations: Registration[] = regsRes.data || []
    const parsedCapacities = parseSettingsValue(capRes.data?.value)
    const capacities: Record<string, number> = Array.isArray(parsedCapacities) ? {} : (parsedCapacities as Record<string, number>)

    const normalizedEmail = email.trim().toLowerCase()
    const activeStatuses = ['pending', 'offered', 'accepted']
    const match = apps.find(a => (a.parent_email || '').trim().toLowerCase() === normalizedEmail && activeStatuses.includes(a.status))

    const today = new Date()
    const { fitMonthByKid, queueByRoom } = runAllocation(apps, registrations, capacities, today)

    if (!match) return json({ found: false })

    const roomId = wlDeriveRoom(match)
    if (!roomId) return json({ found: false })

    const queue = queueByRoom[roomId] || []
    const position = queue.findIndex(k => k.id === match.id) + 1
    if (position <= 0) return json({ found: false })

    const totalInLine = queue.length
    const fitMonth = fitMonthByKid[match.id] ?? null

    return json({
      found: true,
      childName: match.child_name,
      roomLabel: BASE_ROOMS[roomId].label,
      position,
      totalInLine,
      waitRange: waitRangeLabel(fitMonth),
      hasSibling: !!match.has_sibling,
      desiredStart: formatDesiredStart(match.desired_start_date),
      days: formatDays(match.days_of_week),
      schedule: match.day_type === 'half' ? 'Half day' : 'Full day',
    })
  } catch (err) {
    return json({ found: false, error: 'server_error', message: (err as Error).message }, 500)
  }
})
