ALTER TABLE classes ADD COLUMN teacher_id uuid;
ALTER TABLE classes ADD CONSTRAINT classes_teacher_fk FOREIGN KEY (teacher_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE,
  ADD FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE classes RENAME COLUMN title TO name;
ALTER TABLE classes DROP COLUMN legacy_flag;
CREATE UNIQUE INDEX classes_code_idx ON classes (code) WHERE capacity IS NOT NULL;
CREATE INDEX users_lower_email_idx ON public.users USING btree (lower(email));
