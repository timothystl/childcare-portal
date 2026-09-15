-- Market analysis: comparable-provider tracking for the admin "Market Analysis" tab.
-- Replaces the one-off static board-briefing HTML with an editable table + a
-- small settings blob for the handful of citation-style figures (hero stats,
-- infant-cost comparison, wage ladder, board recommendations) that aren't
-- per-provider data.
--
-- Not auto-applied — run by hand in the Supabase SQL Editor (see CLAUDE.md).
-- Admin-only tool: no anon access, unlike CACFP's public menu page.

create table if not exists market_providers (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  provider_type     text        not null check (provider_type in ('tlc','church','profit','public')),
  ages_text         text        not null default '',
  -- 0-11 positioning-quadrant scores (illustrative index, not provider-reported):
  -- x = scheduling flexibility (fixed full-week .. day-by-day),
  -- y = age range served (preschool-only .. birth-through-pre-K).
  flexibility_score numeric     not null default 0,
  age_range_score   numeric     not null default 0,
  reg_fee_low       numeric,
  reg_fee_high      numeric,
  rate_low          numeric,
  rate_high         numeric,
  rate_unit         text        not null default 'week',
  flexible_text     text        not null default '',
  notes             text        not null default '',
  is_own_program    boolean     not null default false,
  active            boolean     not null default true,
  sort_order        integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists market_providers_sort_idx on market_providers(sort_order);

alter table market_providers enable row level security;
create policy "admin_all_market_providers" on market_providers
  for all to authenticated using (true) with check (true);

-- ============================================================
-- Seed data — migrated from the board-briefing HTML (2026 research pass).
-- Positioning scores are illustrative; several for-profit rates are
-- unpublished/estimated — see each row's notes. Safe to re-run: skipped if
-- a row with the same name already exists.
-- ============================================================
insert into market_providers
  (name, provider_type, ages_text, flexibility_score, age_range_score, reg_fee_low, reg_fee_high, rate_low, rate_high, flexible_text, notes, is_own_program, sort_order)
select * from (values
  ('Timothy Lutheran MDO', 'tlc', 'Birth – preschool', 9.7, 9.6, 100::numeric, 100::numeric, null::numeric, null::numeric, 'Yes — unique', 'Full/half day, day-by-day. Current registration fee $100; board considering $125–$175.', true, 0),
  ('HopeMark Preschool', 'church', '3–5 yrs', 6, 3, 100, 100, null, null, 'Partial (preschool only)', 'Half-day, tailorable days. Weekly rate not published — call to confirm.', false, 1),
  ('Tower Grove Christian', 'church', '3 mo – 5 yrs', 2, 9, 100, 100, 134, 189, 'No', '$580–$820/mo', false, 2),
  ('St. Margaret of Scotland', 'church', '3–5 yrs', 1, 3, 300, 300, 172, 172, 'No (full-day only)', '$8,950/yr (1 child)', false, 3),
  ('SouthSide ECC', 'church', '6 wks – 5 yrs', 2, 9, null, null, 229, 395, 'No', '', false, 4),
  ('Cornerstone Center', 'church', '6 wks – 13 yrs', 2, 9, null, null, 0, 25, 'No', 'Subsidy-eligible / sliding scale, ≤$25/wk typical', false, 5),
  ('Southminster MDO', 'church', 'preschool', 5, 3, 75, 75, 30, 30, 'Partial (per-day)', '$30/day', false, 6),
  ('Webster Groves Presby ECC', 'church', '1–6 yrs', 3, 6, null, null, 47, 84, 'No (fixed weekly)', '$205–$365/mo', false, 7),
  ('Faith ECC (Kids Day Out)', 'church', '2–5 yrs', 4, 4, 115, 115, 27, 107, 'Partial (choose days)', '$115–$465/mo', false, 8),
  ('Sacred Heart MDO', 'church', '—', 2, 5, 100, 100, 69, 81, 'No', '$300–$350/mo', false, 9),
  ('Sojourn East MDO', 'church', '1–5 yrs', 2, 6, 125, 125, 46, 46, 'No', '$200/mo', false, 10),
  ('Christ Memorial Lutheran CCC', 'church', '8 wks – 5 yrs', 3, 10, 250, 250, 155, 387, 'Partial (choose 2, 3, or 5 days/wk)', '$672–$1,675/mo by age & days/wk; registration fee is per family', false, 11),
  ('Kirkwood ECC', 'public', '2 yrs – K', 2, 5, null, null, 86, 403, 'No', '$86–$403/wk (half-day to full-day)', false, 12),
  ('Mary Margaret Day Care', 'profit', '6 wks – 12 yrs', 4, 10, null, null, null, null, 'Partial (part-time offered)', 'Unpublished — call to confirm', false, 13),
  ('Kingshighway Hills', 'profit', '24 mo – 12 yrs', 2, 8, null, null, null, null, 'No', 'Unpublished — call to confirm', false, 14),
  ('Hampton KinderCare', 'profit', '6 wks – 12 yrs', 3, 10, 100, 100, 300, 400, 'Partial (part-time offered)', 'Est. $300–$400/wk (infant); registration fee ~$100 (estimated)', false, 15),
  ('The Berry Patch', 'profit', '6 wks – 5 yrs', 1, 8, null, null, 380, 535, 'No (none under 24 mo)', '', false, 16),
  ('Primrose Schools', 'profit', 'infant – K', 3, 10, 400, 400, 143, 373, 'Partial (some locations)', '$620–$1,618/mo', false, 17),
  ('La Petite Academy', 'profit', 'infant – school age', 5, 9, 125, 145, 145, 465, 'Partial (Flex Care cards)', '$145–$465/wk', false, 18)
) as seed(name, provider_type, ages_text, flexibility_score, age_range_score, reg_fee_low, reg_fee_high, rate_low, rate_high, flexible_text, notes, is_own_program, sort_order)
where not exists (select 1 from market_providers mp where mp.name = seed.name);

-- ============================================================
-- Context settings — hero stats, infant-cost comparison, wage ladder, and
-- board recommendations. Small and infrequently edited, so it follows the
-- existing settings key/value pattern rather than getting its own table.
-- ============================================================
insert into settings (key, value)
values ('market_analysis_context', $$
{
  "heroStats": [
    { "num": "34", "suffix": "/100", "label": "licensed slots per 100 St. Louis children under 5 with working parents — vs. 73 nationally" },
    { "num": "18", "suffix": "/467", "label": "city daycares offering part-time or drop-in scheduling of any kind" },
    { "num": "2", "suffix": "×", "label": "infant care costs providers more than preschool care to deliver ($13,600 vs $6,600/yr, MO)" },
    { "num": "0", "suffix": "", "label": "named competitors matching Timothy's flexible, birth-to-pre-K, day-by-day model" }
  ],
  "infantCost": {
    "infantAnnual": 13600,
    "preschoolAnnual": 6600,
    "source": "Federal Reserve Bank of St. Louis, \"The Economics of Child Care\" (Gascon & Hernández Kent, May 2025). Annual cost of providing care, Missouri."
  },
  "wageLadder": [
    { "role": "Entry aide", "low": 15, "high": 16 },
    { "role": "Childcare worker", "low": 15.5, "high": 15.8 },
    { "role": "Preschool teacher", "low": 16.7, "high": 16.8 },
    { "role": "Lead teacher", "low": 15.4, "high": 19.7 },
    { "role": "Assistant director", "low": 24, "high": 25 }
  ],
  "minWage": 15,
  "wageSource": "Ranges blended from Indeed, ZipRecruiter, Glassdoor (St. Louis metro / Missouri, 2026). Dashed line marks the $15.00 MO minimum wage floor.",
  "positioningNote": "Positioning scores are an illustrative index built from each provider's published scheduling terms and age range — not a precise or provider-reported metric.",
  "recommendations": [
    { "title": "Lead with the gap, not the price", "body": "No named competitor matches Timothy's combination of flexibility and full age range — that's the story, and it justifies fair pricing without reading as opportunistic." },
    { "title": "Registration fee: $100 → $125–$175", "body": "Still below Faith ECC ($115), Sojourn East ($125), St. Margaret ($300), and Primrose ($400). A family cap protects larger households." },
    { "title": "Tier by age, not flat", "body": "Infant care costs roughly double to provide. A modest infant-specific premium is the most defensible lever — and funds the wages that keep infant staffing stable." },
    { "title": "Pay toward $17–$20 for lead roles", "body": "At $15 minimum wage, entry and experienced pay have compressed. Retention in the scarcest, highest-demand tier depends on closing that gap." }
  ],
  "footerNote": "Built from board research on St. Louis-area childcare comparables (2026). Several for-profit rates are unpublished and estimated from chain/regional data — confirm by phone before citing externally. Positioning scores are illustrative, not provider-reported metrics."
}
$$)
on conflict (key) do nothing;
