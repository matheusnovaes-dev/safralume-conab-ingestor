import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { produtoresComAcesso, soComAcesso } from "./acesso-conta.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// SIMULATE=1 lê tudo mas não grava nada (usado pra testar a regra contra o banco real).
const SIMULATE = process.env.SIMULATE === "1";
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Mesmo padrão de check-alertas-preco.mjs, só que câmbio é um valor nacional
// só (sem cultura/uf) — basta a cotação de venda mais recente da tabela
// `cambio`. Pedido do Matheus 2026-10-12, 4º tipo de alerta (preço/câmbio/
// clima/leilão).
export async function checarAlertasCambio(supabase, { simulate = false } = {}) {
  let { data: alertas, error } = await supabase
    .from("alertas_cambio")
    .select("id, produtor_id, limite, direcao")
    .eq("ativo", true)
    .is("disparado_em", null);

  if (error) {
    console.error("Erro ao buscar alertas de câmbio:", error);
    return { erro: true, disparados: [] };
  }
  if (!alertas || alertas.length === 0) {
    console.log("Nenhum alerta de câmbio ativo pra checar.");
    return { erro: false, disparados: [] };
  }
  alertas = soComAcesso(alertas, await produtoresComAcesso(supabase), "alertas de câmbio");

  const { data: cambioAtual, error: erroCambio } = await supabase
    .from("cambio")
    .select("data, cotacao_venda")
    .order("data", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroCambio || !cambioAtual) {
    console.error("Erro ao buscar cotação atual do dólar:", erroCambio);
    return { erro: true, disparados: [] };
  }

  console.log(
    `Checando ${alertas.length} alerta(s) de câmbio ativo(s). Cotação atual: R$${cambioAtual.cotacao_venda} (${cambioAtual.data}).`,
  );
  const disparados = [];
  for (const alerta of alertas) {
    const disparou =
      alerta.direcao === "acima"
        ? cambioAtual.cotacao_venda >= alerta.limite
        : cambioAtual.cotacao_venda <= alerta.limite;

    if (disparou) {
      console.log(
        `  -> Alerta ${alerta.id} disparado: câmbio ${alerta.direcao} de ${alerta.limite} (cotação atual: ${cambioAtual.cotacao_venda})`,
      );
      disparados.push({ id: alerta.id, cambioAtual });
      if (!simulate) {
        await supabase
          .from("alertas_cambio")
          .update({ disparado_em: new Date().toISOString() })
          .eq("id", alerta.id);
      }
    } else if (simulate) {
      console.log(
        `  .. Alerta ${alerta.id} NÃO disparou: câmbio ${alerta.direcao} de ${alerta.limite} (cotação atual: ${cambioAtual.cotacao_venda})`,
      );
    }
  }
  console.log(`OK. ${disparados.length} alerta(s) de câmbio disparado(s) nessa rodada.`);
  return { erro: false, disparados };
}

async function run() {
  if (DRY_RUN) {
    console.log("Sem credenciais reais não dá pra simular — esse script só lê/escreve no banco.");
    return;
  }
  const { erro } = await checarAlertasCambio(supabase, { simulate: SIMULATE });
  if (erro) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
