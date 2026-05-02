-- Paste in Supabase SQL Editor
-- Données = RAW dans src/canonicalCountries.ts (zones ar/af/as/eu = |AR|/|AF|/|AS|/|EU| après normalisation).
-- Tu peux stocker la clé comme |AR| ou ar (même normalisation → ar).

INSERT INTO public.canonical_countries (match_key, display_name, sort_order)
VALUES
  ('ar', 'Arabe', 0),
  ('af', 'Afrique', 1),
  ('as', 'Asie', 2),
  ('eu', 'Europe', 3),
  
ON CONFLICT (match_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order;
