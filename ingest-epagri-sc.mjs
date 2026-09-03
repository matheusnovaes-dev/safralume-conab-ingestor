import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const UF = "SC";
const FONTE = "EPAGRI/CEPA-SC";
const PAGINA_LISTAGEM = "https://cepa.epagri.sc.gov.br/index.php/mercado-agricola/";

// A planilha mensal ("Preços Recebidos pelo Produtor") tem o ano no nome do
// arquivo (ex: preco_recebido_produtor_2026.xls) e muda todo ano — por isso
// descobrimos o link de verdade raspando a página em vez de fixar a URL.
// A semanal (Historico_precos_semanal.xlsx) tem nome fixo, sem ano.
async function descobrirUrls() {
  const res = await fetch(PAGINA_LISTAGEM, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Falha ao abrir a página de listagem: HTTP ${res.status}`);
  const html = await res.text();

  const mensal = html.match(
    /href="(https:\/\/docweb\.epagri\.sc\.gov\.br\/website_cepa\/precos\/preco_recebido_produtor_\d{4}\.xlsx?)"/i,
  )?.[1];
  const semanal = html.match(
    /href="(https:\/\/docweb\.epagri\.sc\.gov\.br\/website_cepa\/precos\/Historico_precos_semanal\.xlsx)"/i,
  )?.[1];

  if (!mensal) throw new Error("Link da planilha mensal (preco_recebido_produtor_AAAA.xls) não encontrado.");
  if (!semanal) throw new Error("Link da planilha semanal (Historico_precos_semanal.xlsx) não encontrado.");
  return { mensal, semanal };
}

async function baixarPlanilha(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return XLSX.read(buf, { type: "array" });
}

// --- Dataset mensal: grãos e pecuária, uma coluna (ou várias, uma por
// região) por produto. Confirmado via ws["!merges"] que boi gordo/frango/
// feijão têm MAIS de uma coluna (séries regionais paralelas, não uma coluna
// só) — cada entrada aqui é uma coluna real da planilha.
//
// Merge com produto já existente do Conab só quando a unidade/base é
// exatamente a mesma (soja/milho sc 60kg, boi gordo arroba = mesma base do
// "BOI GORDO (15 kg)" do Conab, suíno/frango vivo em kg com o mesmo rótulo
// de sistema). O resto vira variante própria "(EPAGRI-SC)", igual já
// fizemos com DERAL/PR e Emater/RS.
const COLUNAS_MENSAL = {
  2: { produto: "MILHO EM GRÃOS (60 kg)", unidade: "60 kg", regiao: "Oeste" },
  3: { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg", regiao: "Oeste" },
  4: { produto: "FEIJÃO COMUM PRETO (60 kg)", unidade: "60 kg", regiao: "Oeste" },
  5: { produto: "FEIJÃO COMUM PRETO (60 kg)", unidade: "60 kg", regiao: "Planalto Norte" },
  6: { produto: "FEIJÃO CARIOCA (EPAGRI-SC) (60 kg)", unidade: "60 kg", regiao: "Oeste" },
  7: { produto: "FEIJÃO CARIOCA (EPAGRI-SC) (60 kg)", unidade: "60 kg", regiao: "Meio Oeste" },
  8: { produto: "ARROZ IRRIGADO EM CASCA (EPAGRI-SC) (50 kg)", unidade: "50 kg", regiao: "" },
  9: { produto: "TRIGO SUPERIOR PH78 (EPAGRI-SC) (60 kg)", unidade: "60 kg", regiao: "" },
  10: { produto: "CEBOLA PERA CLASSE 3 A 5 (EPAGRI-SC) (20 kg)", unidade: "20 kg", regiao: "Alto Vale do Itajaí" },
  11: { produto: "BATATA NÃO LAVADA ESPECIAL E PRIMEIRA (EPAGRI-SC) (50 kg)", unidade: "50 kg", regiao: "" },
  12: { produto: "ALHO TIPO 5 (EPAGRI-SC) (kg)", unidade: "kg", regiao: "Meio Oeste" },
  13: { produto: "FARINHA DE MANDIOCA GROSSA (EPAGRI-SC) (50 kg)", unidade: "50 kg", regiao: "Litoral Sul" },
  14: { produto: "MANDIOCA (EPAGRI-SC) (t)", unidade: "t", regiao: "" },
  15: { produto: "TOMATE LONGA VIDA AA (EPAGRI-SC) (20-23 kg)", unidade: "20-23 kg", regiao: "Grande Florianópolis" },
  16: { produto: "BANANA CATURRA (EPAGRI-SC) (20 kg)", unidade: "20 kg", regiao: "Litoral Norte" },
  17: { produto: "BANANA PRATA (EPAGRI-SC) (20 kg)", unidade: "20 kg", regiao: "Litoral Sul" },
  18: { produto: "MARACUJÁ GRANDE (EPAGRI-SC) (11 kg)", unidade: "11 kg", regiao: "Litoral Sul" },
  19: { produto: "FUMO TO2 (EPAGRI-SC) (kg)", unidade: "kg", regiao: "" },
  20: { produto: "SUÍNO VIVO SISTEMA INDEPENDENTE (kg)", unidade: "kg", regiao: "Oeste" },
  21: { produto: "SUÍNO VIVO SISTEMA INTEGRADO (kg)", unidade: "kg", regiao: "Oeste" },
  22: { produto: "FRANGO VIVO (kg)", unidade: "kg", regiao: "Meio Oeste" },
  23: { produto: "FRANGO VIVO (kg)", unidade: "kg", regiao: "Oeste" },
  24: { produto: "BOI GORDO (15 kg)", unidade: "15 kg", regiao: "Oeste" },
  25: { produto: "BOI GORDO (15 kg)", unidade: "15 kg", regiao: "Alto Vale do Itajaí" },
  26: { produto: "BOI GORDO (15 kg)", unidade: "15 kg", regiao: "Planalto Sul" },
  27: { produto: "LEITE POSTO PLATAFORMA INDÚSTRIA (EPAGRI-SC) (l)", unidade: "l", regiao: "" },
  28: { produto: "LEITE POSTO PROPRIEDADE (EPAGRI-SC) (l)", unidade: "l", regiao: "" },
};

const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

async function coletarMensal(url) {
  const wb = await baixarPlanilha(url);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const rows = [];
  let ano = null;
  for (const linha of linhas) {
    // O ano vem ora como número, ora como texto (2009 e 2023-2026 são
    // number; 2010-2022 vêm como string "2010" etc na planilha original) —
    // sem esse parseInt o rastreamento de ano trava no primeiro valor
    // numérico e ignora os 13 anos seguintes gravados como texto.
    const anoCandidato = typeof linha[0] === "number" ? linha[0] : parseInt(linha[0], 10);
    if (Number.isInteger(anoCandidato) && anoCandidato > 1990 && anoCandidato < 2100) ano = anoCandidato;
    const mesIdx = MESES_ABREV.indexOf(String(linha[1] ?? "").toLowerCase().slice(0, 3));
    if (mesIdx === -1 || ano == null) continue;

    const dataReferencia = `${ano}-${String(mesIdx + 1).padStart(2, "0")}-01`;
    for (const [colStr, mapeado] of Object.entries(COLUNAS_MENSAL)) {
      const valor = linha[Number(colStr)];
      if (typeof valor !== "number" || Number.isNaN(valor)) continue;
      rows.push({
        produto: mapeado.produto,
        uf: UF,
        regiao: mapeado.regiao,
        nivel_comercializacao: "PRODUTOR",
        preco: valor,
        unidade: mapeado.unidade,
        data_referencia: dataReferencia,
        fonte: FONTE,
      });
    }
  }
  console.log(`Mensal: ${rows.length} linha(s) coletada(s).`);
  return rows;
}

// --- Dataset semanal: hortifrúti, grãos secundários, pecuária diversa,
// pesca/aquicultura, silvicultura — tudo sem equivalente no Conab, então
// tudo vira variante própria "(EPAGRI-SC)". Formato já é uma tabela longa
// (uma linha por produto+praça+data), sem necessidade de mapear colunas.
function normalizarMes(mes) {
  const semAcento = mes
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const nomes = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ];
  const idx = nomes.indexOf(semAcento);
  return idx === -1 ? null : idx + 1;
}

function splitProdutoUnidade(bruto) {
  const idx = bruto.lastIndexOf(" - ");
  if (idx === -1) return null;
  return { nome: bruto.slice(0, idx).trim(), unidade: bruto.slice(idx + 3).trim() };
}

async function coletarSemanal(url) {
  const wb = await baixarPlanilha(url);
  const ws = wb.Sheets["Preco_semanal_produtor_2020-26"] ?? wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const rows = [];
  for (const linha of linhas) {
    const ano = linha[0];
    const mesTexto = linha[1];
    const dia = linha[2];
    const produtoBruto = linha[3];
    const praca = linha[4];
    const comum = linha[6];

    if (typeof ano !== "number" || typeof dia !== "number") continue;
    if (typeof produtoBruto !== "string" || typeof praca !== "string") continue;
    if (typeof comum !== "number" || Number.isNaN(comum)) continue;

    const mes = normalizarMes(String(mesTexto ?? ""));
    if (!mes) continue;
    const partes = splitProdutoUnidade(produtoBruto);
    if (!partes) continue;

    rows.push({
      produto: `${partes.nome.toLocaleUpperCase("pt-BR")} (EPAGRI-SC) (${partes.unidade.toLocaleLowerCase("pt-BR")})`,
      uf: UF,
      regiao: praca.trim(),
      nivel_comercializacao: "PRODUTOR",
      preco: comum,
      unidade: partes.unidade.toLocaleLowerCase("pt-BR"),
      data_referencia: `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`,
      fonte: FONTE,
    });
  }
  console.log(`Semanal: ${rows.length} linha(s) coletada(s).`);
  return rows;
}

async function gravar(rows, rotulo) {
  if (rows.length === 0) {
    console.log(`Nenhuma linha de ${rotulo} pra gravar.`);
    return;
  }

  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.produto}|${row.uf}|${row.regiao}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];
  console.log(
    `${dedupedRows.length} linha(s) de ${rotulo} prontas pra gravar (${rows.length} coletadas, ${rows.length - dedupedRows.length} duplicadas removidas).`,
  );

  if (DRY_RUN) {
    console.log(`DRY RUN (${rotulo}) — amostra de 5 linhas:`);
    console.log(JSON.stringify(dedupedRows.slice(0, 5), null, 2));
    return;
  }

  const CHUNK = 1000;
  let gravadas = 0;
  for (let i = 0; i < dedupedRows.length; i += CHUNK) {
    const chunk = dedupedRows.slice(i, i + CHUNK);
    const { error } = await supabase.from("precos").upsert(chunk, {
      onConflict: "produto,uf,regiao,data_referencia",
    });
    if (error) {
      console.error(`Erro ao gravar lote ${i}-${i + chunk.length} (${rotulo}):`, error);
      process.exit(1);
    }
    gravadas += chunk.length;
  }
  console.log(`OK (${rotulo}). Linhas gravadas: ${gravadas}`);
}

async function run() {
  const { mensal, semanal } = await descobrirUrls();
  console.log("Mensal:", mensal);
  console.log("Semanal:", semanal);

  const linhasMensal = await coletarMensal(mensal);
  await gravar(linhasMensal, "mensal");

  const linhasSemanal = await coletarSemanal(semanal);
  await gravar(linhasSemanal, "semanal");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
