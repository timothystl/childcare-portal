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
// Ported from js/admin/admin-waitlist.js (wlpRunAllocation() and friends) and
// js/supabase.js (room age helpers). Position and estimated-wait figures MUST
// agree with the admin Waitlist & Capacity Planner — this is a deliberate
// duplication, not drift. If the planner's algorithm changes, mirror it here.
//
// Age ranges + capacities are read live from the `settings` table (keys
// 'room_rates' and 'room_capacity') and merged over the defaults below, exactly
// like loadRateSettings()/getSortedRooms() do client-side — the parent numbers
// must not fall behind an admin edit. In particular, when two rooms share an
// age window (e.g. Turtle and Owl both 24–36mo) they are pooled and demand
// overflows from the earlier-sorted room into its twin, matching wlpRoomGroups.
// ============================================================

const TREND_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// Base ROOMS config (js/supabase.js) — label, default capacity, default age
// window. Live 'room_rates'/'room_capacity' settings override the ages and
// capacities at request time (see buildRooms). Declaration order here is the
// tiebreak for two rooms that end up sharing a minimum age, matching the ROOMS
// array order getSortedRooms() falls back to.
const BASE_ROOMS: Record<string, { label: string; capacity: number; ageMinMonths: number | null; ageMaxMonths: number | null }> = {
  bear:   { label: '🐻 Bear Room',   capacity: 8,  ageMinMonths: 0,  ageMaxMonths: 12 },
  bee:    { label: '🐝 Bee Room',    capacity: 16, ageMinMonths: 12, ageMaxMonths: 24 },
  turtle: { label: '🐢 Turtle Room', capacity: 11, ageMinMonths: 24, ageMaxMonths: 30 },
  goose:  { label: '🪿 Goose Room',  capacity: 12, ageMinMonths: 30, ageMaxMonths: 36 },
  owl:    { label: '🦉 Owl Room',    capacity: 11, ageMinMonths: 36, ageMaxMonths: null },
}
const ROOM_DECL_ORDER = ['bear', 'bee', 'turtle', 'goose', 'owl']

type RoomCfg = { id: string; label: string; capacity: number; ageMinMonths: number | null; ageMaxMonths: number | null }

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

type Kid = {
  id: number
  room: string | null
  days: string[]
  desiredStartM: number
  sibling: boolean
  appliedAt: string
}

// Merge live age ranges + capacities over the defaults, then return the rooms
// age-sorted (getSortedRooms(): ageMinMonths ascending, declaration order as
// tiebreak, null-age rooms last). 'summer' is excluded — same as wlpRooms().
function buildRooms(capacities: Record<string, unknown>, rates: Record<string, unknown>): RoomCfg[] {
  const rooms: RoomCfg[] = ROOM_DECL_ORDER.map(id => {
    const base = BASE_ROOMS[id]
    const r = (rates[id] && typeof rates[id] === 'object') ? rates[id] as Record<string, unknown> : {}
    return {
      id,
      label: base.label,
      capacity: typeof capacities[id] === 'number' ? capacities[id] as number : base.capacity,
      ageMinMonths: ('ageMinMonths' in r) ? (r.ageMinMonths as number | null) : base.ageMinMonths,
      ageMaxMonths: ('ageMaxMonths' in r) ? (r.ageMaxMonths as number | null) : base.ageMaxMonths,
    }
  })
  return rooms
    .map((room, i) => ({ room, i }))
    .sort((a, b) => {
      const aMin = a.room.ageMinMonths, bMin = b.room.ageMinMonths
      if (aMin == null && bMin == null) return a.i - b.i
      if (aMin == null) return 1
      if (bMin == null) return -1
      if (aMin !== bMin) return aMin - bMin
      return a.i - b.i
    })
    .map(x => x.room)
}

// Mirrors calcAgeMonths() — whole completed months, day-of-month aware (a child
// born the 15th is still N months until the 15th, not the 1st).
function calcAgeMonths(dobStr: string, ref: Date): number {
  const birth = new Date(dobStr + 'T00:00:00')
  let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth())
  if (ref.getDate() < birth.getDate()) months--
  return months
}

// Mirrors roomIdForAgeMonths() — first room (age-ascending) whose window holds
// the age; ageMaxMonths is exclusive. Stable over an already age-sorted list,
// so two rooms sharing a minimum age resolve to the earlier-declared one.
function roomIdForAgeMonths(months: number | null, orderedRooms: RoomCfg[]): string | null {
  if (months == null || months < 0) return null
  for (const room of orderedRooms) {
    if (room.ageMinMonths == null) continue
    if (months >= room.ageMinMonths && (room.ageMaxMonths == null || months < room.ageMaxMonths)) return room.id
  }
  return null
}

// Mirrors wlDeriveRoom() — age at desired_start_date, bucketed against the live
// (admin-editable) age ranges.
function wlDeriveRoom(app: WaitlistApp, orderedRooms: RoomCfg[]): string | null {
  const dobStr = app.child_dob || app.expected_due_date
  if (!dobStr || !app.desired_start_date) return null
  const start = new Date(app.desired_start_date + 'T00:00:00')
  return roomIdForAgeMonths(calcAgeMonths(dobStr, start), orderedRooms)
}

// Mirrors wlpRoomGroups() — rooms sharing an identical age window are co-equal
// (kids overflow between them); a unique window is a group of one. Order is
// preserved so overflow fills the earlier-sorted room first.
function roomGroupsFor(orderedRooms: RoomCfg[]): RoomCfg[][] {
  const byKey = new Map<string, RoomCfg[]>()
  orderedRooms.forEach(r => {
    const key = `${r.ageMinMonths}:${r.ageMaxMonths}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(r)
  })
  return [...byKey.values()]
}

// Mirrors wlpPromotionChain() — derived from the live age order, never
// hardcoded (an edited age range must re-point graduations automatically). The
// last room in age order has no destination (aging out = leaving the program).
function buildPromotionChain(orderedRooms: RoomCfg[]): Record<string, { ageOutMonths: number | null; nextRoom: string | null }> {
  const chain: Record<string, { ageOutMonths: number | null; nextRoom: string | null }> = {}
  const ordered = orderedRooms.filter(r => r.ageMinMonths != null)
  ordered.forEach((room, i) => {
    chain[room.id] = { ageOutMonths: room.ageMaxMonths, nextRoom: ordered[i + 1]?.id || null }
  })
  return chain
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
function wlpBaseBooked(registrations: Registration[], rooms: RoomCfg[], today: Date): Record<string, Record<string, number>> {
  const weekDates = wlpCurrentWeekDates(today)
  const dateToDay: Record<string, string> = {}
  Object.entries(weekDates).forEach(([day, date]) => { dateToDay[date] = day })

  const booked: Record<string, Record<string, number>> = {}
  rooms.forEach(r => { booked[r.id] = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 } })

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

// Mirrors _buildGraduationIndex(), using the live-derived promotion chain.
function buildGraduationIndex(registrations: Registration[], promotionChain: Record<string, { ageOutMonths: number | null; nextRoom: string | null }>) {
  const gradOut: Record<string, Record<string, { childName: string; weekdays: Record<string, string> }[]>> = {}
  const gradIn: Record<string, Record<string, { childName: string; weekdays: Record<string, string> }[]>> = {}
  const seen = new Set<string>()

  registrations.forEach(reg => {
    const chain = promotionChain[reg.room_id]
    if (!chain || !reg.child_dob) return
    const key = `${reg.child_name}:${reg.room_id}`
    if (seen.has(key)) return
    seen.add(key)

    const weekdays = weekdayDayTypeMap(reg)
    if (!Object.keys(weekdays).length) return

    const dob = new Date(reg.child_dob)
    // ageOutMonths is null for the last room in age order; matching the client,
    // that lands the graduation in the birth month (a past key that the
    // 12-month window drops) — i.e. the final room never graduates in-window.
    const graduates = new Date(dob.getFullYear(), dob.getMonth() + (chain.ageOutMonths ?? 0), 1)
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
function wlpGradEvents(registrations: Registration[], rooms: RoomCfg[], promotionChain: Record<string, { ageOutMonths: number | null; nextRoom: string | null }>, months: { idx: number; key: string }[]) {
  const { gradOut, gradIn } = buildGraduationIndex(registrations, promotionChain)
  const keyToIdx: Record<string, number> = {}
  months.forEach(m => { keyToIdx[m.key] = m.idx })

  const out: Record<string, Record<number, { days: string[] }[]>> = {}
  const into: Record<string, Record<number, { days: string[] }[]>> = {}
  rooms.forEach(r => { out[r.id] = {}; into[r.id] = {} })

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

// Earliest fitting month for a kid across a pooled room group: try each
// co-equal room in order (fill the first, overflow to the next), and within a
// room the earliest month all requested weekdays are open. Mirrors the pooled
// competitive seating in wlpRunAllocation().
function seatKidInGroup(group: RoomCfg[], working: Record<string, Record<string, number>[]>, k: Kid): { fitMonth: number | null; seatRoomId: string | null } {
  for (const r of group) {
    for (let m = k.desiredStartM; m < 12; m++) {
      if (k.days.every(d => working[r.id][m][d] >= 1)) return { fitMonth: m, seatRoomId: r.id }
    }
  }
  return { fitMonth: null, seatRoomId: null }
}

// Mirrors wlpRunAllocation() — the single source of truth the admin planner
// uses for "position" and "fit month". Seats kids by priority within each
// pooled age-window group, overflowing between co-equal rooms. Returns
// fitMonthByKid plus, for every room, the shared priority-ordered queue of its
// whole pool (so a family's position reflects the combined line for their age,
// not just one of two identical rooms).
function runAllocation(apps: WaitlistApp[], registrations: Registration[], rooms: RoomCfg[], promotionChain: Record<string, { ageOutMonths: number | null; nextRoom: string | null }>, today: Date) {
  const months = wlpMonths(today)
  const baseBooked = wlpBaseBooked(registrations, rooms, today)
  const { gradOut, gradIn } = wlpGradEvents(registrations, rooms, promotionChain, months)

  const gradGridByRoom: Record<string, Record<string, number>[]> = {}
  rooms.forEach(r => {
    gradGridByRoom[r.id] = wlpComputeGradGrid(r.capacity, gradOut[r.id], gradIn[r.id], baseBooked[r.id])
  })

  const activeApps = apps.filter(a => ['pending', 'offered', 'accepted'].includes(a.status))
  const kids: Kid[] = activeApps.map(a => ({
    id: a.id,
    room: wlDeriveRoom(a, rooms),
    days: wlpAppDays(a),
    desiredStartM: wlpDesiredMonthIdx(a, today),
    sibling: !!a.has_sibling,
    appliedAt: a.applied_at,
  })).filter(k => k.room && gradGridByRoom[k.room!])

  const working: Record<string, Record<string, number>[]> = {}
  rooms.forEach(r => { working[r.id] = gradGridByRoom[r.id].map(day => ({ ...day })) })

  const fitMonthByKid: Record<number, number | null> = {}
  const queueByRoom: Record<string, Kid[]> = {}

  roomGroupsFor(rooms).forEach(group => {
    const groupKids = wlpSortByPriority(kids.filter(k => group.some(r => r.id === k.room)))
    // Every room in the pool shares this one queue — the family's position is
    // their rank in the whole age group, regardless of which twin they derive.
    group.forEach(r => { queueByRoom[r.id] = groupKids })
    groupKids.forEach(k => {
      const { fitMonth, seatRoomId } = seatKidInGroup(group, working, k)
      fitMonthByKid[k.id] = fitMonth
      if (fitMonth !== null && seatRoomId) {
        for (let mm = fitMonth; mm < 12; mm++) {
          k.days.forEach(d => { working[seatRoomId][mm][d] = Math.max(0, working[seatRoomId][mm][d] - 1) })
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

// Label for a pooled age group — a single room's label, or the co-equal rooms
// joined ("🐢 Turtle / 🦉 Owl Room") so the family sees both rooms they're in
// line for rather than an arbitrary one of two identical rooms.
function groupLabelFor(roomId: string, rooms: RoomCfg[]): string {
  const room = rooms.find(r => r.id === roomId)
  if (!room) return BASE_ROOMS[roomId]?.label ?? roomId
  const group = rooms.filter(r => r.ageMinMonths === room.ageMinMonths && r.ageMaxMonths === room.ageMaxMonths)
  if (group.length <= 1) return room.label
  // "🐢 Turtle / 🦉 Owl Room" — keep each emoji+name, drop the repeated "Room".
  const names = group.map(r => r.label.replace(/\s+Room$/, ''))
  return `${names.join(' / ')} Room`
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
    const [appsRes, regsRes, capRes, ratesRes] = await Promise.all([
      supabase.from('waitlist_applications').select(
        'id, status, parent_email, child_name, child_dob, expected_due_date, desired_start_date, days_of_week, day_type, has_sibling, applied_at',
      ),
      supabase.from('registrations').select(
        'child_name, child_dob, room_id, registration_dates ( care_date, waitlisted, day_type )',
      ),
      supabase.from('settings').select('value').eq('key', 'room_capacity').maybeSingle(),
      supabase.from('settings').select('value').eq('key', 'room_rates').maybeSingle(),
    ])

    if (appsRes.error || regsRes.error) return json({ found: false })

    const apps: WaitlistApp[] = appsRes.data || []
    const registrations: Registration[] = regsRes.data || []
    const parsedCapacities = parseSettingsValue(capRes.data?.value)
    const capacities: Record<string, unknown> = Array.isArray(parsedCapacities) ? {} : parsedCapacities
    const parsedRates = parseSettingsValue(ratesRes.data?.value)
    const rates: Record<string, unknown> = Array.isArray(parsedRates) ? {} : parsedRates

    const rooms = buildRooms(capacities, rates)
    const promotionChain = buildPromotionChain(rooms)

    const normalizedEmail = email.trim().toLowerCase()
    const activeStatuses = ['pending', 'offered', 'accepted']
    const match = apps.find(a => (a.parent_email || '').trim().toLowerCase() === normalizedEmail && activeStatuses.includes(a.status))

    const today = new Date()
    const { fitMonthByKid, queueByRoom } = runAllocation(apps, registrations, rooms, promotionChain, today)

    if (!match) return json({ found: false })

    const roomId = wlDeriveRoom(match, rooms)
    if (!roomId) return json({ found: false })

    const queue = queueByRoom[roomId] || []
    const position = queue.findIndex(k => k.id === match.id) + 1
    if (position <= 0) return json({ found: false })

    const totalInLine = queue.length
    const fitMonth = fitMonthByKid[match.id] ?? null

    return json({
      found: true,
      childName: match.child_name,
      roomLabel: groupLabelFor(roomId, rooms),
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
