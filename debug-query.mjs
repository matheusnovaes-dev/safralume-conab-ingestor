import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const desde = new Date();
desde.setDate(desde.getDate() - 180);

const { data, error } = await supabase
  .from("precos")
  .select("uf, data_referencia, preco, produto, updated_at")
  .ilike("produto", "%soja%")
  .in("uf", ["AP", "BA", "MT", "PR", "GO"])
  .gte("data_referencia", desde.toISOString().slice(0, 10))
  .order("data_referencia", { ascending: true });

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(`Total rows: ${data.length}`);
console.log(`Distinct produto strings: ${[...new Set(data.map((r) => r.produto))].join(" | ")}`);
console.log(`Distinct data_referencia count: ${new Set(data.map((r) => r.data_referencia)).size}`);

const byUf = new Map();
for (const r of data) {
  if (!byUf.has(r.uf)) byUf.set(r.uf, []);
  byUf.get(r.uf).push(r);
}
for (const [uf, rows] of byUf) {
  console.log(`\n${uf} (${rows.length} rows):`);
  for (const r of rows) {
    console.log(`  ${r.data_referencia}  R$${r.preco}  updated_at=${r.updated_at}`);
  }
}
