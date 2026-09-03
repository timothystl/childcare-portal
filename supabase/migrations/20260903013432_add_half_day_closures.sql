alter table public.closures
  add column half_day boolean not null default false;

comment on column public.closures.half_day is
  'true = the center is open a partial day (e.g. "Close at 1 pm") and parents may still book a half day; false = a normal full-day closure with no care available.';
