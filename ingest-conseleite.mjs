import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Valor de referência do leite dos Conseleites estaduais (conselhos de
// produtores e indústrias), em R$/litro: é o preço do leite ENTREGUE no mês
// indicado, pago no mês seguinte. O mês corrente vem como projeção ("Ago*") e
// depois vira valor definitivo; o upsert sobrescreve a projeção quando isso
// acontece. Só entram os estados que não têm fonte oficial mais fresca já
// ingerida: PR tem o DERAL (semanal) e SC a EPAGRI (mensal).
//
// A fonte de leitura é a tabela pública do MilkPoint (o robots.txt deles
// permite /preco-do-leite/ pra crawlers em geral; os sites dos conselhos só
// publicam esse valor como imagem). Fonte do dado: cada Conseleite.
const ESTADOS = ["MG", "RS", "MT"];
const urlDoEstado = (uf) => `https://www.milkpoint.com.br/preco-do-leite/conseleite/${uf.toLowerCase()}/`;

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const PRECO_MIN = 0.8;
const PRECO_MAX = 6;

// Linha de mês: "Ago* / 2026" (asterisco = projeção) vira { data: "2026-08-01", projecao: true }; null se não for mês.
export function lerMes(texto) {
  const m = texto.trim().match(/^([A-Za-zçÇ]{3})(\*?)\/(\d{4})$/);
  if (!m) return null;
  const mes = MESES[m[1].toLowerCase()];
  if (!mes) return null;
  return { data: `${m[3]}-${String(mes).padStart(2, "0")}-01`, projecao: m[2] === "*" };
}

/** "R$ 2,9299" ou "R$2,4754" -> 2.9299; null se fora de uma faixa plausível de R$/litro. */
export function lerValor(texto) {
  const m = texto.replace(/\s+/g, " ").match(/R\$\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n >= PRECO_MIN && n <= PRECO_MAX ? n : null;
}

/** Linhas [mês, valor] da primeira tabela da página. */
export function extrairLinhas(html) {
  const tabela = html.match(/<table[\s\S]*?<\/table>/i)?.[0];
  if (!tabela) return [];
  const limpar = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
  const linhas = [];
  for (const tr of tabela.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const celulas = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(limpar);
    if (celulas.length < 2) continue;
    const mes = lerMes(celulas[0]);
    const valor = lerValor(celulas[1]);
    if (mes && valor != null) linhas.push({ ...mes, valor });
  }
  return linhas;
}

async function coletarEstado(uf) {
  const res = await fetch(urlDoEstado(uf), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${uf}: HTTP ${res.status}`);
  const linhas = extrairLinhas(await res.text());
  if (linhas.length < 6) throw new Error(`${uf}: só ${linhas.length} linha(s) válidas na tabela (layout mudou?)`);
  return linhas.map((l) => ({
    produto: `LEITE (CONSELEITE-${uf}) (l)`,
    uf,
    regiao: "",
    nivel_comercializacao: "PRODUTOR",
    preco: l.valor,
    unidade: "l",
    data_referencia: l.data,
    fonte: l.projecao ? `Conseleite-${uf} (projeção)` : `Conseleite-${uf}`,
  }));
}

async function run() {
  const rows = [];
  const falhas = [];
  for (const uf of ESTADOS) {
    try {
      const linhas = await coletarEstado(uf);
      const maisRecente = linhas.reduce((a, b) => (a.data_referencia >= b.data_referencia ? a : b));
      console.log(`${uf}: ${linhas.length} mês(es); mais recente ${maisRecente.data_referencia} = R$${maisRecente.preco} (${maisRecente.fonte}).`);
      rows.push(...linhas);
    } catch (err) {
      console.error(`Falha em ${uf}:`, err.message);
      falhas.push(uf);
    }
  }
  if (rows.length === 0) {
    console.error("Nenhum estado coletado.");
    process.exit(1);
  }
  if (DRY_RUN) {
    console.log(`DRY RUN — ${rows.length} linha(s). Amostra:`);
    console.log(JSON.stringify(rows.slice(0, 2), null, 2));
    return;
  }
  const { error } = await supabase
    .from("precos")
    .upsert(rows, { onConflict: "produto,uf,regiao,data_referencia" });
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log(`OK. Linhas gravadas: ${rows.length}.`);
  // Estado que falhou não derruba o que deu certo, mas o job fica vermelho
  // pra alguém ver que o layout do site mudou.
  if (falhas.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
