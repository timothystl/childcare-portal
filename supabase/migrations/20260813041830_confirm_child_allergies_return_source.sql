-- Return the source alongside the stamp. The portal needs it to stop asking
-- "is this right?" after a parent has answered; without it the confirm strip
-- re-rendered on every save and the parent was asked the same question forever.
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
        'reviewed_at', v_row.allergies_reviewed_at,
        'source',      v_row.allergies_source
    );
end;
$$;

revoke all on function public.confirm_child_allergies(uuid, jsonb, text) from public;
grant execute on function public.confirm_child_allergies(uuid, jsonb, text) to authenticated;
