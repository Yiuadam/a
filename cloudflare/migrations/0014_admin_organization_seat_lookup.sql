PRAGMA foreign_keys = ON;

-- Admin directory/detail reads start from an auth user id. The original live
-- allocation index starts with organization_id, which otherwise forces a
-- growing allocation scan for every bounded admin page.
CREATE INDEX organization_seat_allocations_active_user_idx
  ON organization_seat_allocations(user_id, organization_id)
  WHERE status IN ('reserved', 'active');
