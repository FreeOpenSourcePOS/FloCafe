-- Non-destructive migration: convert integer table IDs to strings
-- Safe to run multiple times (idempotent)

UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer';
