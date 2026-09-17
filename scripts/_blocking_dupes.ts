import { db } from '../src/db';
import { sql } from 'drizzle-orm';
import { blockingKey } from '../src/lib/normalize';

interface Row {
  id: string;
  name: string;
  kind: string;
  totalReceived: string;
  totalGiven: string;
}

async function main() {
  const rows = (await db.execute(sql`
    SELECT id, name, kind, total_received AS "totalReceived", total_given AS "totalGiven"
    FROM entities
    WHERE kind != 'individual'
      AND total_received + total_given >= 1000
  `)) as unknown as Row[];

  console.log(`pool: ${rows.length} entities`);

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = blockingKey(r.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const dupeGroups = [...groups.entries()].filter(([, rs]) => rs.length >= 2);

  const scored = dupeGroups.map(([key, rs]) => {
    const total = rs.reduce((s, r) => s + Number(r.totalReceived) + Number(r.totalGiven), 0);
    return { key, rs: rs.sort((a, b) => Number(b.totalReceived) + Number(b.totalGiven) - (Number(a.totalReceived) + Number(a.totalGiven))), total };
  });
  scored.sort((a, b) => b.total - a.total);

  console.log(`${scored.length} blocking-key groups with >=2 entities\n`);

  for (const g of scored) {
    console.log(`--- key="${g.key}"  combined=$${g.total.toLocaleString()}`);
    for (const r of g.rs) {
      const money = Number(r.totalReceived) + Number(r.totalGiven);
      console.log(`  ${r.name}  (${r.kind})  $${money.toLocaleString()}  ${r.id}`);
    }
  }

  process.exit(0);
}
main();
