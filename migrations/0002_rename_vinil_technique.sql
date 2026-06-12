-- Rename "Vinil Termocolante" → "Vinil" in all costs records (supplies and sessions)
UPDATE records
SET    data = json_set(data, '$.technique', 'Vinil')
WHERE  namespace = 'costs'
  AND  json_extract(data, '$.technique') = 'Vinil Termocolante';