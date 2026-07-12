CREATE FUNCTION "schedule_integer_array_is_unique"("values" integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    cardinality("values") = (
      SELECT count(DISTINCT "value")
      FROM unnest("values") AS "items"("value")
    ),
    true
  );
$$;--> statement-breakpoint
WITH "normalized" AS (
  SELECT
    "routines"."id",
    COALESCE(
      (
        SELECT array_agg("preferred"."weekday" ORDER BY "preferred"."first_position")
        FROM (
          SELECT "weekday", min("position") AS "first_position"
          FROM unnest("routines"."preferred_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
          WHERE "weekday" BETWEEN 0 AND 6
          GROUP BY "weekday"
        ) AS "preferred"
      ),
      ARRAY[]::integer[]
    ) AS "preferred_weekdays",
    COALESCE(
      (
        SELECT array_agg("excluded"."weekday" ORDER BY "excluded"."first_position")
        FROM (
          SELECT "weekday", min("position") AS "first_position"
          FROM unnest("routines"."excluded_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
          WHERE "weekday" BETWEEN 0 AND 6
          GROUP BY "weekday"
        ) AS "excluded"
      ),
      ARRAY[]::integer[]
    ) AS "excluded_weekdays"
  FROM "routines"
)
UPDATE "routines"
SET
  "preferred_weekdays" = ARRAY(
    SELECT "weekday"
    FROM unnest("normalized"."preferred_weekdays") WITH ORDINALITY AS "items"("weekday", "position")
    WHERE NOT ("weekday" = ANY("normalized"."excluded_weekdays"))
    ORDER BY "position"
  ),
  "excluded_weekdays" = "normalized"."excluded_weekdays"
FROM "normalized"
WHERE "routines"."id" = "normalized"."id";--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_preferred_weekdays_valid" CHECK ("routines"."preferred_weekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::integer[]);--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_preferred_weekdays_unique" CHECK (schedule_integer_array_is_unique("routines"."preferred_weekdays"));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_excluded_weekdays_valid" CHECK ("routines"."excluded_weekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::integer[]);--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_excluded_weekdays_unique" CHECK (schedule_integer_array_is_unique("routines"."excluded_weekdays"));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_weekdays_disjoint" CHECK (NOT ("routines"."preferred_weekdays" && "routines"."excluded_weekdays"));
