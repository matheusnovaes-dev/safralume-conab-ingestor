import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Janela de 10 dias corridos: cobre fins de semana/feriados sem precisar de
// lógica de dia útil — a API do BCB só retorna dias em que realmente houve
// cotação, e o upsert por `data` cuida de não duplicar.
const DIAS_JANELA = 10;

function formatarDataBCB(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}-${dd}-${date.getFullYear()}`;
}

async function buscarCotacoes() {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - DIAS_JANELA);

  const url =
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
    `?@dataInicial='${formatarDataBCB(inicio)}'&@dataFinalCotacao='${formatarDataBCB(hoje)}'&$format=json`;

  console.log("Buscando PTAX:", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`BCB retornou ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.value ?? [];
}

async function run() {
  const cotacoes = await buscarCotacoes();
  if (cotacoes.length === 0) {
    console.log("Nenhuma cotação retornada. Abortando sem gravar.");
    return;
  }

  const rows = cotacoes.map((c) => ({
    data: c.dataHoraCotacao.slice(0, 10),
    cotacao_compra: c.cotacaoCompra,
    cotacao_venda: c.cotacaoVenda,
    fonte: "BCB/PTAX",
  }));

  console.log(`${rows.length} cotações coletadas.`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.slice(-3), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase.from("cambio").upsert(rows, { onConflict: "data" });

  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", rows.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
