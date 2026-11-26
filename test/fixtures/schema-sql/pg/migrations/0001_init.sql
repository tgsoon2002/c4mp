-- Initial schema. A semicolon in a comment; must not split.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TYPE public.user_role AS ENUM ('admin', 'teacher', 'student');

CREATE TABLE "users" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  full_name text,
  role user_role NOT NULL DEFAULT 'student',
  manager_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.classes (
  id uuid PRIMARY KEY,
  code varchar(20) NOT NULL,
  title text NOT NULL,
  capacity integer CHECK (capacity > 0),
  legacy_flag boolean
);

CREATE TABLE enrollments (
  class_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (class_id, user_id),
  CONSTRAINT enrollments_status_check CHECK (status IN ('active', 'dropped'))
);

CREATE TABLE billing.invoices (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tags text[] NOT NULL DEFAULT '{}'
);
