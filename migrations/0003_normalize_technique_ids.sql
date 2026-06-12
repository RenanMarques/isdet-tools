-- Normalize technique stored values from display strings to stable IDs
UPDATE records SET data = json_set(data, '$.technique', 'sublimacao')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'Sublimação';

UPDATE records SET data = json_set(data, '$.technique', 'dtf')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'DTF';

UPDATE records SET data = json_set(data, '$.technique', 'serigrafia')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'Serigrafia';

UPDATE records SET data = json_set(data, '$.technique', 'vinil')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'Vinil';

UPDATE records SET data = json_set(data, '$.technique', 'plotter')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'Ilustração com Plotter de Risco';

UPDATE records SET data = json_set(data, '$.technique', 'stencil')
WHERE namespace = 'costs' AND json_extract(data, '$.technique') = 'Stencil';
