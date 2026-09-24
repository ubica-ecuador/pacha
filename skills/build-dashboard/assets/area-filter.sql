-- Point in polygon for the area drawn on a Kepler map, in plain SQL: no
-- spatial extension, which in the browser would cost a 23 MB download.
-- $quakeArea holds the drawn shape as WKT (EPSG:4326), or '' when nothing is
-- drawn. Kepler draws one ring (a polygon or a rectangle), which is all this
-- handles. The test is ray casting: count how many edges a ray going east
-- from the point crosses; odd means inside.
--
-- Use: add the CTE to the query's WITH list, cross join `area`, and AND the
-- predicate into the WHERE clause. The row needs `longitude` and `latitude`.
-- @cte
area AS (
  SELECT
    list_filter(n, lambda v, i: i % 2 = 1) AS xs,
    list_filter(n, lambda v, i: i % 2 = 0) AS ys
  FROM (SELECT CAST(regexp_extract_all($quakeArea, '-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?') AS DOUBLE[]) AS n)
)
-- @predicate
(len(area.xs) = 0 OR list_sum(list_transform(range(1, len(area.xs)), lambda i:
  CASE WHEN (area.ys[i] > latitude) <> (area.ys[i + 1] > latitude)
        AND longitude < (area.xs[i + 1] - area.xs[i]) * (latitude - area.ys[i]) / (area.ys[i + 1] - area.ys[i]) + area.xs[i]
       THEN 1 ELSE 0 END)) % 2 = 1)
