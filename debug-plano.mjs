import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: coops, error: coopErr } = await supabase
  .from("cooperativas")
  .select("id, nome, created_at")
  .ilike("nome", "%teste%");

if (coopErr) { console.error(coopErr); process.exit(1); }
console.log("Cooperativas encontradas:", JSON.stringify(coops, null, 2));

for (const coop of coops) {
  const { data: assinatura, error } = await supabase
    .from("assinaturas")
    .select("*")
    .eq("cooperativa_id", coop.id);
  console.log(`\nAssinatura(s) de "${coop.nome}" (${coop.id}):`, JSON.stringify(assinatura, null, 2), error ?? "");
}
