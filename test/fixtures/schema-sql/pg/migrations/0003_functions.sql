BEGIN;
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now(); -- inner semicolons stay inside the body
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE users ADD COLUMN updated_at timestamptz;
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TYPE user_role ADD VALUE 'guest';
/* a block comment with a ; inside */
ALTER TABLE classes ALTER COLUMN name SET NOT NULL;
ALTER TABLE classes ALTER COLUMN capacity TYPE bigint;
ALTER TABLE classes ALTER COLUMN capacity SET DEFAULT 30;
INSERT INTO users (email) VALUES ('a;b@example.com');
CREATE TABLE scratch (id int);
DROP TABLE scratch;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghost ADD COLUMN x int;
COMMIT;
