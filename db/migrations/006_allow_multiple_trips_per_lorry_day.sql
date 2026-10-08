-- A lorry may run several trips for the same driver on the same day, so no
-- unique index or constraint may exist on exactly (trip_date, driver_id,
-- vehicle_id). None of migrations 001-005 creates one; this drops any that was
-- added by hand to an existing database, and does nothing otherwise.
DO $$
DECLARE
  blocker RECORD;
BEGIN
  FOR blocker IN
    SELECT ix.indexrelid::regclass::text AS index_name, con.conname AS constraint_name
    FROM pg_index ix
    LEFT JOIN pg_constraint con
      ON con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid
    WHERE ix.indrelid = 'delivery_trips'::regclass
      AND ix.indisunique
      AND NOT ix.indisprimary
      AND (
        SELECT array_agg(att.attname::text ORDER BY att.attname)
        FROM pg_attribute att
        WHERE att.attrelid = ix.indrelid
          AND att.attnum = ANY (ix.indkey::int2[])
      ) = ARRAY['driver_id', 'trip_date', 'vehicle_id']
  LOOP
    IF blocker.constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE delivery_trips DROP CONSTRAINT %I', blocker.constraint_name);
    ELSE
      EXECUTE format('DROP INDEX %s', blocker.index_name);
    END IF;
  END LOOP;
END;
$$;
