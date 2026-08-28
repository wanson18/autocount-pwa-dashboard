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
        AND quantity <> 'NaN'::numeric
        AND quantity <> 'Infinity'::numeric
        AND quantity <> '-Infinity'::numeric
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
