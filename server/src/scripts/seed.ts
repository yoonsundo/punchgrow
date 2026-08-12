import { readFile } from 'node:fs/promises';
import { pool, transaction } from '../db.js';

interface CatalogRow {
  id: string; koName: string; enName: string; lineageId: string; category: string; stage: number; rarity: string;
  bodyForm: string; tone: string; identity: string; lore: string; shapeDNA: string[]; palette: object;
  sharedMotifs: string[]; evolutionFrom: string | string[] | null; imagePath: string;
}

const path = process.env.CATALOG_PATH ?? new URL('../../../production/catalog/creatures.json', import.meta.url).pathname;
const catalog = JSON.parse(await readFile(path, 'utf8')) as CatalogRow[];
if (catalog.length !== 256) throw new Error(`expected 256 catalog rows, received ${catalog.length}`);

try {
  await transaction(async (client) => {
    for (const item of catalog) {
      await client.query(`
        INSERT INTO catalog_creatures
          (id, ko_name, en_name, lineage_id, category, stage, rarity, body_form, tone, identity_text, lore, shape_dna, palette, shared_motifs, evolution_from, image_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16)
        ON CONFLICT (id) DO UPDATE SET
          ko_name=EXCLUDED.ko_name, en_name=EXCLUDED.en_name, lineage_id=EXCLUDED.lineage_id,
          category=EXCLUDED.category, stage=EXCLUDED.stage, rarity=EXCLUDED.rarity, body_form=EXCLUDED.body_form,
          tone=EXCLUDED.tone, identity_text=EXCLUDED.identity_text, lore=EXCLUDED.lore, shape_dna=EXCLUDED.shape_dna,
          palette=EXCLUDED.palette, shared_motifs=EXCLUDED.shared_motifs, evolution_from=EXCLUDED.evolution_from, image_path=EXCLUDED.image_path`,
        [item.id,item.koName,item.enName,item.lineageId,item.category,item.stage,item.rarity,item.bodyForm,item.tone,item.identity,item.lore,
          JSON.stringify(item.shapeDNA),JSON.stringify(item.palette),JSON.stringify(item.sharedMotifs),JSON.stringify(item.evolutionFrom),item.imagePath],
      );
    }
  });
  console.log(`seeded ${catalog.length} creatures`);
} finally {
  await pool.end();
}
