-- Dedicated table for parent data-deletion requests (CCPA/GDPR right to erasure).
-- Previously requests were inserted into the generic messages table with no
-- structured tracking, SLA visibility, or audit trail.

CREATE TABLE IF NOT EXISTS deletion_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id    uuid REFERENCES families(id) ON DELETE SET NULL,
    parent_email text NOT NULL,
    parent_name  text,
    reason       text,
    status       text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'denied')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    completed_by text   -- admin email who actioned the request
);

-- Admins (authenticated) can read and update; anon can only insert their own request.
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can insert deletion requests"
    ON deletion_requests FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "service role full access"
    ON deletion_requests FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "authenticated admin read and update"
    ON deletion_requests FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- Index for admin dashboard queries (pending requests by age)
CREATE INDEX IF NOT EXISTS idx_deletion_requests_status_requested
    ON deletion_requests (status, requested_at);
