-- D1 is authoritative for usernames after learner-data cutover. Keep the
-- server validation as friendly feedback, and enforce the same invariant at
-- the database boundary so a future script or code path cannot bypass it.

CREATE TRIGGER IF NOT EXISTS usernames_validate_insert
BEFORE INSERT ON usernames
FOR EACH ROW
WHEN length(NEW.username) NOT BETWEEN 3 AND 30
  OR NEW.username <> lower(NEW.username)
  OR substr(NEW.username, 1, 1) NOT GLOB '[a-z0-9]'
  OR NEW.username GLOB '*[^a-z0-9._-]*'
  OR EXISTS (
    SELECT 1 FROM reserved_usernames r
     WHERE r.username = NEW.username COLLATE NOCASE
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or reserved username');
END;

CREATE TRIGGER IF NOT EXISTS usernames_validate_update
BEFORE UPDATE OF username ON usernames
FOR EACH ROW
WHEN length(NEW.username) NOT BETWEEN 3 AND 30
  OR NEW.username <> lower(NEW.username)
  OR substr(NEW.username, 1, 1) NOT GLOB '[a-z0-9]'
  OR NEW.username GLOB '*[^a-z0-9._-]*'
  OR EXISTS (
    SELECT 1 FROM reserved_usernames r
     WHERE r.username = NEW.username COLLATE NOCASE
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or reserved username');
END;
