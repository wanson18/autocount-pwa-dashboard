-- Extend the Task 4 durable request table for transactional trip/assignment
-- mutations without rewriting any already-applied migration.
ALTER TABLE dispatch_resource_idempotency
  DROP CONSTRAINT IF EXISTS dispatch_resource_idempotency_operation_check;

ALTER TABLE dispatch_resource_idempotency
  ADD CONSTRAINT dispatch_mutation_idempotency_operation_check
  CHECK (operation IN (
    'driver.create', 'driver.update', 'lorry.create', 'lorry.update',
    'trip.create', 'trip.update',
    'assignment.create', 'assignment.move', 'assignment.remove', 'assignment.status'
  ));

ALTER TABLE dispatch_resource_idempotency
  DROP CONSTRAINT IF EXISTS dispatch_resource_idempotency_resource_type_check;

ALTER TABLE dispatch_resource_idempotency
  ADD CONSTRAINT dispatch_mutation_idempotency_resource_type_check
  CHECK (resource_type IN ('driver', 'lorry', 'trip', 'assignment'));
