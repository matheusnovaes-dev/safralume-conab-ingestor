import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Checador independente — antes disso, alerta de preço só era checado DENTRO
// de ingest.mjs/ingest-deral-pr.mjs, amarrado ao batch daquele run
// específico. Achado real: EPAGRI/CEPA-SC, IEA-SP, BBM e Emater/RS (todos
// adicionados na mesma sessão) nunca chamavam checkAlertas — um alerta pra
// produto/UF que só existe numa dessas fontes nunca disparava, mesmo com o
// preço cruzando o limite de verdade. Esse script consulta `precos` direto
// (não depende de nenhum ingest específico ter rodado por último), cobrindo
// qualquer fonte atual ou futura automaticamente.
//
// Só olha regiao='' (preço único do estado) de propósito — mesma lógica já
// usada no dashboard e no bot: alerta baseado numa região arbitrária dentro
// do estado seria tão errado quanto escolher uma região arbitrária pra
// mostrar preço. Produto/UF que só tem dado regional (ex: soja em MG/SP)
// não gera alerta ainda — precisaria de uma decisão de produto sobre como
// tratar isso (alerta por região?), fica pra outra hora.
async function run() {
  if (DRY_RUN) {
    console.log("Sem credenciais reais não dá pra simular — esse script só lê/escreve no banco.");
    return;
  }
  const { data: alertas, error } = await supabase
    .from("alertas_preco")
    .select("id, cultura, uf, limite, direcao")
    .eq("ativo", true)
    .is("disparado_em", null);

  if (error) {
    console.error("Erro ao buscar alertas:", error);
    process.exit(1);
  }
  if (!alertas || alertas.length === 0) {
    console.log("Nenhum alerta ativo pra checar.");
    return;
  }

  console.log(`Checando ${alertas.length} alerta(s) ativo(s)...`);
  let disparados = 0;
  for (const alerta of alertas) {
    const { data: precoRows, error: precoError } = await supabase
      .from("precos")
      .select("produto, preco, data_referencia")
      .ilike("produto", `%${alerta.cultura}%`)
      .eq("uf", alerta.uf)
      .eq("regiao", "")
      .order("data_referencia", { ascending: false })
      .limit(1);

    if (precoError) {
      console.error(`  erro buscando preço pro alerta ${alerta.id}:`, precoError);
      continue;
    }
    const preco = precoRows?.[0];
    if (!preco) continue;

    const disparou =
      alerta.direcao === "acima" ? preco.preco >= alerta.limite : preco.preco <= alerta.limite;

    if (disparou) {
      console.log(
        `  -> Alerta ${alerta.id} disparado: ${alerta.cultura}/${alerta.uf} ${alerta.direcao} de ${alerta.limite} (preço atual: ${preco.preco}, ${preco.produto}, ${preco.data_referencia})`,
      );
      disparados++;
      if (!DRY_RUN) {
        await supabase
          .from("alertas_preco")
          .update({ disparado_em: new Date().toISOString() })
          .eq("id", alerta.id);
      }
    }
  }
  console.log(`OK. ${disparados} alerta(s) disparado(s) nessa rodada.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
