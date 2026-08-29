-- Let a signed-in parent read the same handful of public settings keys that
-- anon already can.
--
-- The parent portal's Schedule tab estimates a month's cost from ROOMS, which
-- js/supabase.js seeds with build-time defaults and loadRateSettings() corrects
-- from the room_rates setting. Those defaults have drifted (Summer Camp is $50
-- live and $75 in the defaults), so the estimate was wrong wherever it showed.
--
-- The existing "public read allowed keys" policy names role anon only, and a
-- signed-in parent is authenticated — so the correction silently returned zero
-- rows for exactly the people looking at their own bill. The only other policy
-- on settings requires is_admin().
--
-- ⚠️ Same key allow-list as the anon policy, nothing added. These keys are
-- already public to anyone loading index.html with the anon key; this grants a
-- parent no more than a logged-out visitor already has. Writes are untouched —
-- the admin policy is still the only thing that permits one.
create policy "parent read allowed keys"
    on public.settings
    for select
    to authenticated
    using (key = any (array[
        'room_rates', 'room_capacity', 'staff_ratios', 'reg_window_override',
        'registration_fee', 'registration_fee_renewal_date', 'new_family_fee',
        'supply_fee_family_max', 'hide_summer_camp', 'enrollment_at_capacity',
        'offer_links', 'geofence', 'staff_directory'
    ]));
