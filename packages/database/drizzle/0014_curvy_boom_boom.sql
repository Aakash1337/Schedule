ALTER TABLE "routines" DROP CONSTRAINT "routines_preferred_weekdays_one_dimensional";--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_excluded_weekdays_one_dimensional";--> statement-breakpoint
UPDATE "routines"
SET
  "preferred_weekdays" = CASE
    WHEN cardinality("preferred_weekdays") = 0 OR (array_ndims("preferred_weekdays") = 1 AND array_lower("preferred_weekdays", 1) = 1)
      THEN "preferred_weekdays"
    ELSE ARRAY(
      SELECT "weekday"
      FROM unnest("preferred_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
      ORDER BY "position"
    )
  END,
  "excluded_weekdays" = CASE
    WHEN cardinality("excluded_weekdays") = 0 OR (array_ndims("excluded_weekdays") = 1 AND array_lower("excluded_weekdays", 1) = 1)
      THEN "excluded_weekdays"
    ELSE ARRAY(
      SELECT "weekday"
      FROM unnest("excluded_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
      ORDER BY "position"
    )
  END
WHERE
  (cardinality("preferred_weekdays") > 0 AND (array_ndims("preferred_weekdays") <> 1 OR array_lower("preferred_weekdays", 1) <> 1))
  OR (cardinality("excluded_weekdays") > 0 AND (array_ndims("excluded_weekdays") <> 1 OR array_lower("excluded_weekdays", 1) <> 1));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_preferred_weekdays_one_dimensional" CHECK (cardinality("routines"."preferred_weekdays") = 0 OR (array_ndims("routines"."preferred_weekdays") = 1 AND array_lower("routines"."preferred_weekdays", 1) = 1));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_excluded_weekdays_one_dimensional" CHECK (cardinality("routines"."excluded_weekdays") = 0 OR (array_ndims("routines"."excluded_weekdays") = 1 AND array_lower("routines"."excluded_weekdays", 1) = 1));
