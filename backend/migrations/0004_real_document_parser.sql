-- Phase C2.1 adds versioned real-parser tasks and evidence while preserving
-- historical development tasks and fixture requirements.

ALTER TABLE parse_tasks
  DROP CONSTRAINT parse_tasks_type_check;

ALTER TABLE parse_tasks
  ADD CONSTRAINT parse_tasks_type_check
  CHECK (type IN ('development-document-parse', 'document-parse-v1'));

ALTER TABLE requirements
  DROP CONSTRAINT requirements_extraction_method_check;

ALTER TABLE requirements
  ADD COLUMN confidence numeric(5,4);

ALTER TABLE requirements
  ADD CONSTRAINT requirements_extraction_method_check
  CHECK (extraction_method IN ('development-fixture', 'deterministic-rules-v1')),
  ADD CONSTRAINT requirements_confidence_ck
  CHECK (
    (
      extraction_method = 'development-fixture'
      AND confidence IS NULL
    )
    OR (
      extraction_method = 'deterministic-rules-v1'
      AND confidence IS NOT NULL
      AND confidence BETWEEN 0 AND 1
    )
  ),
  ADD CONSTRAINT requirements_evidence_kind_locator_v1_ck
  CHECK (
    (
      extraction_method = 'development-fixture'
      AND (source_locator ->> 'kind' = 'development-fixture') IS TRUE
    )
    OR (
      extraction_method = 'deterministic-rules-v1'
      AND (source_locator ->> 'kind' IN ('pdf', 'docx', 'txt')) IS TRUE
      AND (source_locator -> 'version' = '1'::jsonb) IS TRUE
    )
  );
