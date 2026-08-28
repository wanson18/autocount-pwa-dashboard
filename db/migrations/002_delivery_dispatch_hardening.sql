LOCK TABLE delivery_assignments, delivery_assignment_items IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  contaminated_count BIGINT;
  contaminated_item_ids TEXT;
  contaminated_assignment_ids TEXT;
BEGIN
  SELECT count(*)
  INTO contaminated_count
  FROM delivery_assignment_items
  WHERE quantity::text IN ('NaN', 'Infinity', '-Infinity');

  IF contaminated_count > 0 THEN
    SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '')
    INTO contaminated_item_ids
    FROM (
      SELECT id
      FROM delivery_assignment_items
      WHERE quantity::text IN ('NaN', 'Infinity', '-Infinity')
      ORDER BY id
      LIMIT 20
    ) AS contaminated_items;

    SELECT coalesce(string_agg(assignment_id::text, ',' ORDER BY assignment_id), '')
    INTO contaminated_assignment_ids
    FROM (
      SELECT DISTINCT assignment_id
      FROM delivery_assignment_items
      WHERE quantity::text IN ('NaN', 'Infinity', '-Infinity')
      ORDER BY assignment_id
      LIMIT 20
    ) AS contaminated_assignments;

    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'DELIVERY_DISPATCH_HARDENING_BLOCKED: found %s non-finite delivery_assignment_items row(s); item_ids=%s; assignment_ids=%s; run the read-only preflight before explicit audited remediation',
        contaminated_count,
        contaminated_item_ids,
        contaminated_assignment_ids
      ),
      HINT = 'Run npm run migrate:preflight, then follow the documented explicit remediation workflow.';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'delivery_assignment_items'::regclass
      AND conname = 'delivery_assignment_items_positive_finite_quantity_check'
  ) THEN
    ALTER TABLE delivery_assignment_items
      ADD CONSTRAINT delivery_assignment_items_positive_finite_quantity_check
      CHECK (
        quantity > 0
        AND quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_delivery_assignment_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.company_key IS DISTINCT FROM OLD.company_key
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.doc_no IS DISTINCT FROM OLD.doc_no
    OR NEW.doc_date IS DISTINCT FROM OLD.doc_date
    OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
    OR NEW.invoice_header IS DISTINCT FROM OLD.invoice_header
  THEN
    RAISE EXCEPTION 'delivery assignment invoice snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_assignment_snapshot_immutable
  ON delivery_assignments;
CREATE TRIGGER delivery_assignment_snapshot_immutable
  BEFORE UPDATE OR DELETE ON delivery_assignments
  FOR EACH ROW EXECUTE FUNCTION prevent_delivery_assignment_snapshot_mutation();
