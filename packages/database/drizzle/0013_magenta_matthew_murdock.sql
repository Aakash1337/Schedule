-- PostgreSQL permits multidimensional integer arrays even though the application contract does not.
-- Flatten legacy arrays in row-major order. Migration 0012 already guarantees range, uniqueness,
-- and disjointness, so flattening preserves every valid weekday and its traversal order.
UPDATE "routines"
SET
  "preferred_weekdays" = CASE
    WHEN cardinality("preferred_weekdays") = 0 OR array_ndims("preferred_weekdays") = 1
      THEN "preferred_weekdays"
    ELSE ARRAY(
      SELECT "weekday"
      FROM unnest("preferred_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
      ORDER BY "position"
    )
  END,
  "excluded_weekdays" = CASE
    WHEN cardinality("excluded_weekdays") = 0 OR array_ndims("excluded_weekdays") = 1
      THEN "excluded_weekdays"
    ELSE ARRAY(
      SELECT "weekday"
      FROM unnest("excluded_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
      ORDER BY "position"
    )
  END
WHERE
  (cardinality("preferred_weekdays") > 0 AND array_ndims("preferred_weekdays") <> 1)
  OR (cardinality("excluded_weekdays") > 0 AND array_ndims("excluded_weekdays") <> 1);--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_preferred_weekdays_one_dimensional" CHECK (cardinality("routines"."preferred_weekdays") = 0 OR array_ndims("routines"."preferred_weekdays") = 1);--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_excluded_weekdays_one_dimensional" CHECK (cardinality("routines"."excluded_weekdays") = 0 OR array_ndims("routines"."excluded_weekdays") = 1);
