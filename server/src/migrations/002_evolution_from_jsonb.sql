DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'catalog_creatures' AND column_name = 'evolution_from' AND data_type = 'text'
  ) THEN
    ALTER TABLE catalog_creatures ALTER COLUMN evolution_from TYPE jsonb USING (
      CASE
        WHEN evolution_from IS NULL THEN NULL
        WHEN evolution_from LIKE '{%}' THEN to_jsonb(string_to_array(replace(trim(both '{}' from evolution_from), '"', ''), ','))
        ELSE to_jsonb(evolution_from)
      END
    );
  END IF;
END $$;
