import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { buscarPrecoAtual } from "./preco-fonte.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// SIMULATE=1 lê tudo mas não grava nada (usado pra testar a regra contra o banco real).
const SIMULATE = process.env.SIMULATE === "1";
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
// Preço usado: o do estado (regiao='') quando está em dia; quando ele está
// defasado (Conab de MT ficou 4 semanas parada) ou não existe (soja em
// MG/SP só tem praça), a MÉDIA das praças do dia mais recente — mesma regra
// do painel e do bot (preco-fonte.mjs). Antes só olhava o estado, então o
// alerta de MT/GO decidia em cima de um preço de semanas atrás e alerta de
// produto só-regional nunca disparava.
export async function checarAlertas(supabase, { simulate = false } = {}) {
  const { data: alertas, error } = await supabase
    .from("alertas_preco")
    .select("id, cultura, uf, limite, direcao")
    .eq("ativo", true)
    .is("disparado_em", null);

  if (error) {
    console.error("Erro ao buscar alertas:", error);
    return { erro: true, disparados: [] };
  }
  if (!alertas || alertas.length === 0) {
    console.log("Nenhum alerta ativo pra checar.");
    return { erro: false, disparados: [] };
  }

  console.log(`Checando ${alertas.length} alerta(s) ativo(s)...`);
  const disparados = [];
  for (const alerta of alertas) {
    // Fonte mais recente (ver preco-fonte.mjs): preço único do estado quando
    // está em dia; senão a média das praças do dia mais recente.
    let preco;
    try {
      preco = await buscarPrecoAtual(supabase, alerta.cultura, alerta.uf);
    } catch (err) {
      console.error(`  erro buscando preço pro alerta ${alerta.id}:`, err);
      continue;
    }
    if (!preco) continue;

    const disparou =
      alerta.direcao === "acima" ? preco.preco >= alerta.limite : preco.preco <= alerta.limite;

    if (disparou) {
      console.log(
        `  -> Alerta ${alerta.id} disparado: ${alerta.cultura}/${alerta.uf} ${alerta.direcao} de ${alerta.limite} (preço atual: ${preco.preco}, ${preco.produto}, ${preco.data_referencia}, ${preco.origem})`,
      );
      disparados.push({ id: alerta.id, preco });
      if (!simulate) {
        await supabase
          .from("alertas_preco")
          .update({ disparado_em: new Date().toISOString() })
          .eq("id", alerta.id);
      }
    } else if (simulate) {
      console.log(
        `  .. Alerta ${alerta.id} NÃO disparou: ${alerta.cultura}/${alerta.uf} ${alerta.direcao} de ${alerta.limite} (preço atual: ${preco.preco}, ${preco.data_referencia}, ${preco.origem})`,
      );
    }
  }
  console.log(`OK. ${disparados.length} alerta(s) disparado(s) nessa rodada.`);
  return { erro: false, disparados };
}

async function run() {
  if (DRY_RUN) {
    console.log("Sem credenciais reais não dá pra simular — esse script só lê/escreve no banco.");
    return;
  }
  const { erro } = await checarAlertas(supabase, { simulate: SIMULATE });
  if (erro) process.exit(1);
}

// Só roda sozinho quando executado direto (o ingest da Conab importa
// checarAlertas sem disparar a rodada inteira).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
