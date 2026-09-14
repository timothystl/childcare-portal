-- Parents confirm their own child's allergies, and it COUNTS — no office
-- sign-off. The parent is the authority on their own child, and their answer is
-- fresher than a ProCare export written at enrollment. Requiring staff to
-- countersign 150 submissions would rebuild the bottleneck this removes.
--
-- Provenance is recorded because "who said so" matters on a safety record: the
-- director should be able to see at a glance which children were confirmed by a
-- parent and which the office transcribed.

alter table public.students
  add column if not exists allergies_source text
    check (allergies_source in ('parent', 'office'));

comment on column public.students.allergies_source is
  'Who last confirmed the allergy field: parent (via portal) or office. NULL '
  'alongside a NULL allergies_reviewed_at means nobody has.';

-- ── The write ───────────────────────────────────────────────
-- SECURITY DEFINER because parents hold no UPDATE on students and must not.
-- parent_owns_student() is the whole authorization: a parent can only ever
-- reach a child in their own family, and the student id is checked, never
-- trusted.
create or replace function public.confirm_child_allergies(
    p_student_id uuid,
    p_allergies  jsonb,
    p_care_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row students;
begin
    if not parent_owns_student(p_student_id) then
        raise exception 'not your child' using errcode = '42501';
    end if;

    -- Shape is enforced by students_allergies_shape too, but failing here gives
    -- the portal a message it can show instead of a constraint violation.
    if p_allergies is null or jsonb_typeof(p_allergies) <> 'array' then
        raise exception 'allergies must be a list';
    end if;
    if not allergies_shape_ok(p_allergies) then
        raise exception 'each allergy needs a label and a severity of severe, sensitivity or note';
    end if;

    update students
       set allergies             = p_allergies,
           care_notes            = nullif(btrim(coalesce(p_care_notes, '')), ''),
           allergies_reviewed_at = now(),
           allergies_source      = 'parent'
     where id = p_student_id
     returning * into v_row;

    return jsonb_build_object(
        'student_id',  v_row.id,
        'child_name',  v_row.child_name,
        'allergies',   v_row.allergies,
        'care_notes',  v_row.care_notes,
        'reviewed_at', v_row.allergies_reviewed_at
    );
end;
$$;

revoke all on function public.confirm_child_allergies(uuid, jsonb, text) from public;
grant execute on function public.confirm_child_allergies(uuid, jsonb, text) to authenticated;
