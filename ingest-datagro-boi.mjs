import { createClient } from "@supabase/supabase-js";

import { UA_PADRAO, atrasoInicial, buscarComCuidado, jaCaptadoHa } from "./coleta-educada.mjs";

// Indicador do Boi DATAGRO por estado (R$/@): o mesmo JSON que a página pública indicadordoboi.com.br consulta para mostrar os
// valores do dia. Uso autorizado por escrito pela Datagro (e-mail ao Matheus, 2026-10-22: "informações factuais públicas,
// incluindo indicadores e valores de mercado, poderá ocorrer na plataforma Safralume, inclusive em ferramentas digitais,
// calculadoras e funcionalidades voltadas aos produtores rurais"). Limites do mesmo e-mail: sem reproduzir relatórios, bases
// protegidas ou conteúdo exclusivo; por isso NÃO baixa a série histórica comercial, só o valor do dia, e toda resposta cita a fonte.
// Ver dados/autorizacoes_uso_de_dados_2026-10-22.md.
//
// SP fica de fora de propósito: o IEA-SP já traz o boi gordo de SP por praça, todo dia, e o painel prefere esse detalhe.

const DRY = process.env.DRY === "1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes.");
  process.exit(2);
}
const supabase = DRY ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = UA_PADRAO;
const HORAS_SEM_REPETIR = 3; // o indicador sai uma vez por dia: duas rodadas seguidas não precisam bater de novo
const CLIENTE = "a81574eb-06c1-11ed-bcba-02ebefa3b928"; // identificador público que a própria página do indicador envia
const UFS = ["GO", "MS", "MG", "PA", "RO", "TO", "BA", "MT"];
const URL_API = `https://precos.api.datagro.com/quadros/?ativos=${UFS.map((u) => `D_PEPR_${u}_BR`).join(",")}&idioma=pt-br&cliente=${CLIENTE}`;

export function linhasDoJson(json) {
  const linhas = [];
  for (const a of json?.ativos ?? []) {
    const d = a?.dados;
    const m = /^D_PEPR_([A-Z]{2})_BR$/.exec(d?.cod ?? "");
    const preco = Number(d?.ult);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(d?.dia ?? "") || !Number.isFinite(preco) || preco < 100 || preco > 1000) continue;
    linhas.push({
      produto: "BOI GORDO (15 kg)",
      uf: m[1],
      regiao: "",
      nivel_comercializacao: "PRODUTOR",
      preco,
      unidade: "15 kg",
      data_referencia: d.dia,
      fonte: "Datagro",
    });
  }
  return linhas;
}

async function run() {
  if (await jaCaptadoHa(supabase, { fonte: "Datagro", horas: HORAS_SEM_REPETIR })) {
    return console.log(`Datagro já coletada nas últimas ${HORAS_SEM_REPETIR} h: nada a pedir.`);
  }
  await atrasoInicial();
  const { texto } = await buscarComCuidado(URL_API, { ua: UA, headers: { Accept: "application/json" } });
  const linhas = linhasDoJson(JSON.parse(texto));
  if (linhas.length < 5) throw new Error(`Datagro: só ${linhas.length} estado(s) válidos (formato mudou?)`);
  console.log(linhas.map((l) => `${l.uf} ${l.data_referencia} R$${l.preco}`).join(" | "));
  if (DRY) return console.log("DRY: nada gravado.");
  const { error } = await supabase.from("precos").upsert(linhas, { onConflict: "produto,uf,regiao,data_referencia" });
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", linhas.length);
}

if (!process.env.DATAGRO_SEM_EXECUTAR) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
