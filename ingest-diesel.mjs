import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const LISTAGEM_URL =
  "https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas";

// Nome oficial (maiúsculo, sem sigla) -> UF. A planilha da ANP usa o nome
// completo do estado, não a sigla que o resto do app usa.
const NOME_PARA_UF = {
  ACRE: "AC",
  ALAGOAS: "AL",
  AMAPA: "AP",
  AMAZONAS: "AM",
  BAHIA: "BA",
  CEARA: "CE",
  "DISTRITO FEDERAL": "DF",
  "ESPIRITO SANTO": "ES",
  GOIAS: "GO",
  MARANHAO: "MA",
  "MATO GROSSO": "MT",
  "MATO GROSSO DO SUL": "MS",
  "MINAS GERAIS": "MG",
  PARA: "PA",
  PARAIBA: "PB",
  PARANA: "PR",
  PERNAMBUCO: "PE",
  PIAUI: "PI",
  "RIO DE JANEIRO": "RJ",
  "RIO GRANDE DO NORTE": "RN",
  "RIO GRANDE DO SUL": "RS",
  RONDONIA: "RO",
  RORAIMA: "RR",
  "SANTA CATARINA": "SC",
  "SAO PAULO": "SP",
  SERGIPE: "SE",
  TOCANTINS: "TO",
};

const PRODUTOS_DIESEL = new Set(["OLEO DIESEL", "OLEO DIESEL S10"]);

async function buscarUrlResumoMaisRecente() {
  const res = await fetch(LISTAGEM_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Listagem retornou ${res.status}`);
  const html = await res.text();

  const matches = [...html.matchAll(/href="([^"]*resumo_semanal_lpc_[^"]+\.xlsx)"/gi)];
  if (matches.length === 0) throw new Error("Nenhum link de resumo semanal encontrado.");

  return matches[0][1];
}

// Datas do Excel são um número serial (dias desde 1899-12-30).
function serialParaISO(serial) {
  const ms = Date.UTC(1899, 11, 30) + Number(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function run() {
  const url = await buscarUrlResumoMaisRecente();
  console.log("Resumo semanal mais recente:", url);

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Planilha retornou ${res.status}`);
  const buffer = await res.arrayBuffer();

  const wb = XLSX.read(buffer, { type: "array" });
  // "TIPO RELATÓRIO: ESTADOS" é sempre a 3a aba (Capitais, Municípios,
  // Estados, Regiões, Brasil, nessa ordem — confirmado inspecionando o
  // arquivo real antes de escrever este script).
  const sheetName = wb.SheetNames[2];
  const sheet = wb.Sheets[sheetName];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 6 });

  const rows = [];
  for (const linha of linhas) {
    const [dataInicial, dataFinal, , estado, produto, , , precoMedio] = linha;
    if (!PRODUTOS_DIESEL.has(produto)) continue;
    const uf = NOME_PARA_UF[estado];
    if (!uf) {
      console.log(`  ! Estado não mapeado: "${estado}"`);
      continue;
    }
    rows.push({
      uf,
      produto,
      preco_medio: Number(precoMedio),
      data_inicial: serialParaISO(dataInicial),
      data_final: serialParaISO(dataFinal),
      fonte: "ANP",
    });
  }

  if (rows.length === 0) {
    console.log("Nenhuma linha de diesel extraída. Abortando sem gravar.");
    return;
  }

  console.log(`${rows.length} linhas de diesel extraídas (esperado: até 27 UFs × 2 produtos = 54).`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.slice(0, 4), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("diesel_precos")
    .upsert(rows, { onConflict: "uf,produto,data_final" });

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
