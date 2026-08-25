import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const COOP_ID = "c8bd4009-e324-43f1-970d-1ca48e4e85f6";

const { data: assinaturas, error } = await supabase
  .from("assinaturas")
  .select("*")
  .eq("cooperativa_id", COOP_ID);
console.log("assinaturas para Cooperativo teste:", JSON.stringify(assinaturas, null, 2), error ?? "");

const { data: membros, error: mErr } = await supabase
  .from("cooperativa_membros")
  .select("*")
  .eq("cooperativa_id", COOP_ID);
console.log("\nmembros dessa cooperativa:", JSON.stringify(membros, null, 2), mErr ?? "");
