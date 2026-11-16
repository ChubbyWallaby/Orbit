// Builds the first Voyage levels into src/game/voyage-levels.json, so nobody waits for the generator
// and the levels stay the same even when the generator changes later.
// Run: npx tsx scripts/build-voyage.ts [count]   (about 10 minutes for 60 levels)
import { writeFileSync } from 'node:fs';
import { buildVoyageLevel, orderChapters, PREBUILT, voyageSpec } from '../src/game/voyage';
import type { Generated } from '../src/game/generate';

const count = Number(process.argv[2] ?? PREBUILT);
const out: Generated[] = [];
for (let n = 1; n <= count; n++) {
  const t = Date.now();
  const g = buildVoyageLevel(n);
  out.push(g);
  const spec = voyageSpec(n);
  console.log(`#${n} ${spec.chapter} [${spec.features.join('+')}] ${spec.target}: ${g.solutions} solutions, ${Date.now() - t} ms`);
}
writeFileSync(new URL('../src/game/voyage-levels.json', import.meta.url), JSON.stringify(orderChapters(out)) + '\n');
console.log(`wrote ${out.length} levels`);
