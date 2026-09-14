-- Parent Account tab. Design: docs/design_handoff/README.md §10b.
--
-- The handoff's split is load-bearing and is implemented exactly:
--   direct parent writes -> contact phone, PIN, pickup list, notification prefs
--   requests to the office -> allergies, immunizations, room changes, withdrawal
--
-- ⚠️ EMAIL IS NOT DIRECTLY EDITABLE, and that is a deliberate departure from
-- the design. Under Option B the address IS the sign-in identity: it keys
-- parent_accounts -> auth.users. Letting a parent change families.parent_email
-- from the portal would leave the auth user pointing at the old address and
-- lock them out of the app they just used to do it. The Account tab shows the
-- address with an explanation and routes changes to the office. Revisit only
-- alongside a flow that moves the auth user too.

-- ── Who may collect a child ─────────────────────────────────
create table if not exists public.pickup_contacts (
    id            bigserial primary key,
    family_id     uuid not null references public.families(id) on delete cascade,
    name          text not null check (btrim(name) <> ''),
    relationship  text,
    note          text,              -- "Thursdays only", per the design
    created_at    timestamptz not null default now()
);
create index if not exists pickup_contacts_family_idx on public.pickup_contacts(family_id);

alter table public.pickup_contacts enable row level security;
revoke all on public.pickup_contacts from anon, authenticated;
revoke all on sequence public.pickup_contacts_id_seq from anon, authenticated;

-- Admin reads/writes through the ordinary predicate; parents reach it only
-- through the definer RPCs below, so there is no parent policy at all.
drop policy if exists "admin all pickup_contacts" on public.pickup_contacts;
create policy "admin all pickup_contacts" on public.pickup_contacts
    for all to authenticated using (is_admin()) with check (is_admin());
grant select, insert, update, delete on public.pickup_contacts to authenticated;

-- ── Notification preferences ────────────────────────────────
-- jsonb on families rather than five columns: the set will change as the push
-- work lands, and a column per toggle means a migration per toggle.
alter table public.families
  add column if not exists notification_prefs jsonb not null default '{}'::jsonb;

comment on column public.families.notification_prefs is
  'Per-family push toggles: moments, messages, billing, announcements, quiet_hours. '
  'Absent key = on (except quiet_hours, which defaults off) — see PT_NOTIF_DEFAULTS.';

-- ── Read: everything the Account tab needs, in one call ─────
create or replace function public.my_account()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_fam uuid; v_slot int; v_out jsonb;
begin
    select (my_parent_context()->>'family_id')::uuid,
           coalesce((my_parent_context()->>'parent_slot')::int, 1)
      into v_fam, v_slot;
    if v_fam is null then return 'null'::jsonb; end if;

    select jsonb_build_object(
        'family_id', f.id,
        'my_slot',   v_slot,
        'prefs',     f.notification_prefs,
        'parents', jsonb_build_array(
            jsonb_build_object('slot', 1, 'name', f.parent_name,
                               'email', f.parent_email, 'phone', f.parent_phone,
                               'has_pin', coalesce(f.has_pin, false)),
            jsonb_build_object('slot', 2, 'name', f.parent2_name,
                               'email', f.parent2_email, 'phone', f.parent2_phone,
                               'has_pin', coalesce(f.has_parent2_pin, false))
        ),
        'children', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', s.id, 'child_name', s.child_name, 'child_dob', s.child_dob,
                       'room_override', s.room_override, 'allergies', s.allergies,
                       'care_notes', s.care_notes, 'photo_release', s.photo_release,
                       'allergies_reviewed_at', s.allergies_reviewed_at,
                       'allergies_source', s.allergies_source)
                       order by s.child_name)
            from students s where s.family_id = f.id), '[]'::jsonb),
        'pickup', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', p.id, 'name', p.name,
                       'relationship', p.relationship, 'note', p.note)
                       order by p.name)
            from pickup_contacts p where p.family_id = f.id), '[]'::jsonb)
    ) into v_out
    from families f where f.id = v_fam;

    return coalesce(v_out, 'null'::jsonb);
end;
$$;

-- ── Writes ──────────────────────────────────────────────────
-- Each one derives the family from the session. None takes a family id, so
-- none can be aimed at another family.

create or replace function public.update_my_phone(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_fam uuid; v_slot int; v_clean text;
begin
    select (my_parent_context()->>'family_id')::uuid,
           coalesce((my_parent_context()->>'parent_slot')::int, 1)
      into v_fam, v_slot;
    if v_fam is null then raise exception 'not a parent' using errcode = '42501'; end if;

    v_clean := nullif(btrim(coalesce(p_phone, '')), '');
    if v_clean is not null and length(v_clean) > 32 then
        raise exception 'that phone number is too long';
    end if;

    -- Only the CALLER's own slot. Parent 2 cannot rewrite parent 1's number.
    if v_slot = 2 then
        update families set parent2_phone = v_clean where id = v_fam;
    else
        update families set parent_phone  = v_clean where id = v_fam;
    end if;
    return jsonb_build_object('phone', v_clean, 'slot', v_slot);
end;
$$;

create or replace function public.set_my_notification_prefs(p_prefs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_fam uuid;
begin
    v_fam := (my_parent_context()->>'family_id')::uuid;
    if v_fam is null then raise exception 'not a parent' using errcode = '42501'; end if;
    if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
        raise exception 'preferences must be an object';
    end if;
    update families set notification_prefs = p_prefs where id = v_fam;
    return p_prefs;
end;
$$;

create or replace function public.add_pickup_contact(
    p_name text, p_relationship text default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_fam uuid; v_id bigint;
begin
    v_fam := (my_parent_context()->>'family_id')::uuid;
    if v_fam is null then raise exception 'not a parent' using errcode = '42501'; end if;
    if coalesce(btrim(p_name), '') = '' then raise exception 'a name is required'; end if;

    -- A family with fifty names on the list is a list nobody checks at the door.
    if (select count(*) from pickup_contacts where family_id = v_fam) >= 12 then
        raise exception 'that is the most names we can hold — remove one first';
    end if;

    insert into pickup_contacts (family_id, name, relationship, note)
    values (v_fam, btrim(p_name), nullif(btrim(coalesce(p_relationship,'')),''),
            nullif(btrim(coalesce(p_note,'')),''))
    returning id into v_id;

    return jsonb_build_object('id', v_id, 'name', btrim(p_name),
                              'relationship', p_relationship, 'note', p_note);
end;
$$;

create or replace function public.remove_pickup_contact(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_fam uuid; v_n int;
begin
    v_fam := (my_parent_context()->>'family_id')::uuid;
    if v_fam is null then raise exception 'not a parent' using errcode = '42501'; end if;
    -- family_id in the WHERE is the authorization: another family's row simply
    -- does not match, so this deletes nothing rather than deleting theirs.
    delete from pickup_contacts where id = p_id and family_id = v_fam;
    get diagnostics v_n = row_count;
    return v_n > 0;
end;
$$;

revoke all on function public.my_account() from public;
revoke all on function public.update_my_phone(text) from public;
revoke all on function public.set_my_notification_prefs(jsonb) from public;
revoke all on function public.add_pickup_contact(text, text, text) from public;
revoke all on function public.remove_pickup_contact(bigint) from public;

grant execute on function public.my_account() to authenticated;
grant execute on function public.update_my_phone(text) to authenticated;
grant execute on function public.set_my_notification_prefs(jsonb) to authenticated;
grant execute on function public.add_pickup_contact(text, text, text) to authenticated;
grant execute on function public.remove_pickup_contact(bigint) to authenticated;
