// Médias mensais por estado desde o começo da série (uma página por produto × UF), para a leitura de sazonalidade do sinal de venda.
// Mesmas regras de coleta da coleta-b: Chrome comum, um pedido por vez com pausa de pessoa, para no primeiro sinal de bloqueio
// (401/403/429/503/desafio) sem insistir nem contornar. Endereço e rotas vêm da configuração privada (bucket coleta-b, ou COLETA_B_CONFIG).
//
// Uso:  HISTORICO_PRODUTOS=soja-em-grao-sc-60kg,milho-seco-sc-60kg HISTORICO_UFS=MT,GO node historico-mensal.mjs
//       HISTORICO_ARQUIVO=pagina.html node historico-mensal.mjs   (só interpreta um HTML já baixado, sem rede)
// Saída: historico-mensal.json (e, com SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY e GRAVAR=1, upsert na tabela historico_mensal).
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MARCAS_DE_BLOQUEIO = /just a moment|cf-chl|captcha|attention required|access denied|enable javascript and cookies|too many requests/i;
const MESES = { Jan: 1, Fev: 2, Mar: 3, Abr: 4, Mai: 5, Jun: 6, Jul: 7, Ago: 8, Set: 9, Out: 10, Nov: 11, Dez: 12 };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const entre = (a, b) => a + Math.random() * (b - a);

/** Células da matriz ano × mês: <td title="Jan/2016: R$ 66,76">. Devolve [{ano, mes, valor}]. Mês sem dado ("·") não aparece. */
export function lerMatriz(html) {
  const linhas = [];
  for (const m of html.matchAll(/title="([A-Za-zç]{3})\/(\d{4}): R\$\s*([\d.]+,\d+)"/g)) {
    const mes = MESES[m[1]];
    if (!mes) continue;
    linhas.push({ ano: Number(m[2]), mes, valor: Number(m[3].replace(/\./g, "").replace(",", ".")) });
  }
  // a mesma célula pode aparecer também na lista abaixo da matriz: uma linha por ano/mês
  const vistos = new Map();
  for (const l of linhas) vistos.set(`${l.ano}-${l.mes}`, l);
  return [...vistos.values()].sort((a, b) => a.ano - b.ano || a.mes - b.mes);
}

async function carregarConfig() {
  if (process.env.COLETA_B_CONFIG) return JSON.parse(process.env.COLETA_B_CONFIG);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.storage.from("coleta-b").download("config/fonte-b.json");
  if (error) throw new Error(`configuração da coleta não encontrada: ${error.message}`);
  return JSON.parse(await data.text());
}

async function baixar(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9", accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  if ([401, 403, 429, 503].includes(r.status)) throw new Error(`Bloqueio detectado (HTTP ${r.status}). Coleta interrompida de propósito.`);
  const html = await r.text();
  if (MARCAS_DE_BLOQUEIO.test(html.slice(0, 4000))) throw new Error("Bloqueio detectado (desafio de robô). Coleta interrompida de propósito.");
  return { status: r.status, html };
}

async function main() {
  if (process.env.HISTORICO_ARQUIVO) {
    const serie = lerMatriz(readFileSync(process.env.HISTORICO_ARQUIVO, "utf8"));
    console.log(serie.length, "meses; primeiro", serie[0], "último", serie.at(-1));
    return;
  }
  const cfg = await carregarConfig();
  if (!cfg.base || !cfg.rotaHistorico) throw new Error("configuração sem base/rotaHistorico");
  const produtos = (process.env.HISTORICO_PRODUTOS ?? "soja-em-grao-sc-60kg,milho-seco-sc-60kg,boi-gordo-15kg").split(",").map((x) => x.trim()).filter(Boolean);
  const ufs = (process.env.HISTORICO_UFS ?? "MT,GO,PR,MS,RS,MG,BA,SP,SC,TO,MA,PI").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const pares = produtos.flatMap((p) => ufs.map((u) => [p, u])).map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const saida = [];
  const sem = [];
  for (const [i, [produto, uf]] of pares.entries()) {
    const url = `${cfg.base}${cfg.rotaHistorico}${uf}/${produto}`;
    const { status, html } = await baixar(url);
    const serie = status === 200 ? lerMatriz(html) : [];
    if (serie.length === 0) sem.push(`${produto}/${uf} (HTTP ${status})`);
    for (const s of serie) saida.push({ produto, uf: uf.toUpperCase(), ...s });
    console.log(`${i + 1}/${pares.length} ${produto} ${uf.toUpperCase()}: ${serie.length} meses`);
    if (i < pares.length - 1) await esperar(entre(6500, 13_000)); // ritmo de pessoa
  }
  writeFileSync("historico-mensal.json", JSON.stringify({ quando: new Date().toISOString(), semDados: sem, linhas: saida }));
  console.log(`${saida.length} linhas; sem dado: ${sem.length ? sem.join(", ") : "nenhum"}`);
  if (process.env.GRAVAR === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    for (let i = 0; i < saida.length; i += 500) {
      const { error } = await supabase.from("historico_mensal").upsert(saida.slice(i, i + 500), { onConflict: "produto,uf,ano,mes" });
      if (error) throw new Error(`gravação falhou: ${error.message}`);
    }
    console.log("gravado em historico_mensal");
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("historico-mensal.mjs")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
