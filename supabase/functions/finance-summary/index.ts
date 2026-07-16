import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Constant-time comparison so a wrong X-Api-Key can't be brute-forced via
// response-time differences.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// settings.value can be a JSON-encoded TEXT string or a native jsonb object
// depending on which code path wrote it — handle both, same as
// waitlist-status/send-waitlist-confirmation.
function parseSettingsValue(raw: unknown): Record<string, number> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, number>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
    } catch { return {} }
  }
  return {}
}

function centsFromDollars(dollars: number): number {
  return Math.round((dollars || 0) * 100)
}

// Trailing window: current calendar month + MONTHS_BACK prior, oldest first.
const MONTHS_BACK = 12

type MonthBucket = { year: number; key: string }

function buildMonths(today: Date): MonthBucket[] {
  const out: MonthBucket[] = []
  for (let i = MONTHS_BACK; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
    out.push({ year: d.getFullYear(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  }
  return out
}

// Budget categories that only exist as annual settings.annual_budget_{year}
// figures (no live computation) — field names and display labels mirror the
// admin Finance P&L table (js/admin/admin-finance.js aRow() calls).
const BUDGET_ONLY_CATEGORIES: { category: string; budgetField: string; actualField: string }[] = [
  { category: 'Payroll Taxes', budgetField: 'taxes', actualField: 'actualTaxes' },
  { category: 'Workers Comp', budgetField: 'workersComp', actualField: 'actualWorkersComp' },
  { category: 'Other Payroll Expenses', budgetField: 'payrollExp', actualField: 'actualPayrollExp' },
  { category: 'Other Expenses', budgetField: 'otherExp', actualField: 'actualOtherExp' },
]

const SALARY_PERIODS_PER_MONTH = 26 / 12 // biweekly (26/yr) prorated to a calendar month

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const expectedKey = Deno.env.get('FINANCE_API_KEY')
  const providedKey = req.headers.get('x-api-key')
  if (!expectedKey || !providedKey || !safeEqual(providedKey, expectedKey)) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const today = new Date()
    const months = buildMonths(today)
    const monthKeySet = new Set(months.map(m => m.key))
    const years = [...new Set(months.map(m => m.year))]
    const rangeStart = `${months[0].key}-01`

    const [cyclesRes, staffRes, hoursRes, clockRes, ...budgetResList] = await Promise.all([
      supabase.from('billing_cycles').select('id, month').in('month', [...monthKeySet]),
      supabase.from('staff').select('id, pay_type, hourly_rate, salary_biweekly, active, hire_date'),
      supabase.from('staff_hours').select('staff_id, work_date, hours_worked').gte('work_date', rangeStart),
      supabase.from('staff_clock_events').select('staff_id, work_date, clock_in, clock_out').gte('work_date', rangeStart),
      ...years.map(y => supabase.from('settings').select('value').eq('key', `annual_budget_${y}`).maybeSingle()),
    ])

    if (cyclesRes.error || staffRes.error || hoursRes.error || clockRes.error) {
      return json({ error: 'server_error' }, 500)
    }

    const cycleMonthById = new Map((cyclesRes.data || []).map((c: any) => [c.id, c.month as string]))
    const cycleIds = [...cycleMonthById.keys()]

    const invoicesRes = cycleIds.length
      ? await supabase.from('billing_invoices').select('cycle_id, final_amount').in('cycle_id', cycleIds)
      : { data: [] as any[], error: null }
    if (invoicesRes.error) return json({ error: 'server_error' }, 500)

    // --- Tuition Income actual: SUM(final_amount) across all families, grouped
    // by billing_cycles.month. Includes invoices of every status (draft through
    // paid) — a draft's final_amount already reflects the computed bill, and
    // this endpoint is a live trend snapshot, recomputed on every call. ---
    const tuitionActualByMonth: Record<string, number> = {}
    ;(invoicesRes.data || []).forEach((inv: any) => {
      const mk = cycleMonthById.get(inv.cycle_id)
      if (!mk) return
      tuitionActualByMonth[mk] = (tuitionActualByMonth[mk] || 0) + Number(inv.final_amount || 0)
    })

    // --- Payroll actual: staff_hours (manual entry) takes precedence over
    // staff_clock_events for the same (staff_id, work_date), mirroring the
    // tiering in _buildRoomPnlData() (admin-reports.js), plus a flat
    // biweekly-equivalent for salaried staff. This is a portfolio-wide monthly
    // approximation for trend purposes, not a payroll register — there's no
    // termination date tracked, only `active`, so a staff member who left
    // mid-window drops out of every month rather than just the months after
    // they left. ---
    const staffById = new Map((staffRes.data || []).map((s: any) => [s.id, s]))
    const manualDayKeys = new Set<string>()
    const payrollActualByMonth: Record<string, number> = {}

    ;(hoursRes.data || []).forEach((h: any) => {
      const staff = staffById.get(h.staff_id)
      const mk = String(h.work_date).slice(0, 7)
      manualDayKeys.add(`${h.staff_id}:${h.work_date}`)
      if (!staff || staff.pay_type !== 'hourly' || !monthKeySet.has(mk)) return
      payrollActualByMonth[mk] = (payrollActualByMonth[mk] || 0) + Number(h.hours_worked || 0) * Number(staff.hourly_rate || 0)
    })

    ;(clockRes.data || []).forEach((c: any) => {
      if (!c.clock_out || manualDayKeys.has(`${c.staff_id}:${c.work_date}`)) return
      const staff = staffById.get(c.staff_id)
      const mk = String(c.work_date).slice(0, 7)
      if (!staff || staff.pay_type !== 'hourly' || !monthKeySet.has(mk)) return
      const hrs = (new Date(c.clock_out).getTime() - new Date(c.clock_in).getTime()) / 3_600_000
      if (!(hrs > 0)) return
      payrollActualByMonth[mk] = (payrollActualByMonth[mk] || 0) + hrs * Number(staff.hourly_rate || 0)
    })

    ;(staffRes.data || []).forEach((s: any) => {
      if (s.pay_type !== 'salary' || !s.active) return
      months.forEach(m => {
        if (s.hire_date && m.key < String(s.hire_date).slice(0, 7)) return
        payrollActualByMonth[m.key] = (payrollActualByMonth[m.key] || 0) + Number(s.salary_biweekly || 0) * SALARY_PERIODS_PER_MONTH
      })
    })

    // --- Annual budget settings, divided by 12 for a monthly figure — the app
    // has no monthly-granular budget, only settings.annual_budget_{year}. ---
    const budgetByYear: Record<number, Record<string, number>> = {}
    years.forEach((y, i) => { budgetByYear[y] = parseSettingsValue((budgetResList[i] as any)?.data?.value) })

    const budget: { period: string; category: string; type: 'actual' | 'budget'; amount_cents: number }[] = []
    months.forEach(m => {
      const b = budgetByYear[m.year] || {}

      budget.push({ period: m.key, category: 'Tuition Income', type: 'actual', amount_cents: centsFromDollars(tuitionActualByMonth[m.key] || 0) })
      budget.push({ period: m.key, category: 'Tuition Income', type: 'budget', amount_cents: centsFromDollars((b.income || 0) / 12) })
      budget.push({ period: m.key, category: 'Payroll', type: 'actual', amount_cents: centsFromDollars(payrollActualByMonth[m.key] || 0) })
      budget.push({ period: m.key, category: 'Payroll', type: 'budget', amount_cents: centsFromDollars((b.wages || 0) / 12) })

      BUDGET_ONLY_CATEGORIES.forEach(({ category, budgetField, actualField }) => {
        budget.push({ period: m.key, category, type: 'budget', amount_cents: centsFromDollars((b[budgetField] || 0) / 12) })
        budget.push({ period: m.key, category, type: 'actual', amount_cents: centsFromDollars((b[actualField] || 0) / 12) })
      })
    })

    return json({
      updated_at: today.toISOString(),
      accounts: [], // this app has no bank/operating-account balance data anywhere
      budget,
    })
  } catch (err) {
    return json({ error: 'server_error', message: (err as Error).message }, 500)
  }
})
