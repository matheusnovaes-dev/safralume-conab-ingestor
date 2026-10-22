import { createClient } from "@supabase/supabase-js";

import { atrasoInicial, buscarComCuidado, datasJaGravadas, diasSemDado, esperarComVariacao, isoParaBR } from "./coleta-educada.mjs";

// IEA-SP, preços DIÁRIOS no mercado ATACADISTA (Grande São Paulo: CEAGESP e outros): BancoDeDados/PrecosDiarios/Atacado.
// É referência de atacado, NÃO o preço que o produtor recebe: vai para a tabela própria `precos_atacado` (ver
// rural-heart-project/supabase/precos-atacado.sql) e o bot cita como "referência de atacado". Mesmo comportamento da série
// diária de recebidos: a página só devolve o dia da data INICIAL, então consulta dia a dia. Uso autorizado pelo IEA em 2026-10-22.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes.");
  process.exit(2);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const URL_PAGINA = "https://infoiea.agricultura.sp.gov.br/BancoDeDados/PrecosDiarios/Atacado";
const FONTE = "IEA-SP (atacado)";
const PRACA = "RMSP (atacado)";
const DIAS = Number(process.env.IEA_DIAS ?? 8);

// Códigos da página (valor dos checkboxes `prod`), só o que interessa a produtor: hortaliças, feijão, frango, ovos e suíno.
// Commodities (soja, milho, trigo, arroz) ficam de fora: já têm fonte melhor (BBM, Conab).
const PRODUTOS = [7, 1004, 162, 1001, 40, 44, 96, 145, 146, 147, 148, 149, 150, 102];

const limpar = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const numero = (s) => {
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const paraISO = (br) => br.split("/").reverse().join("-");

export function extrairLinhas(html) {
  const linhas = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const c = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(limpar);
    if (c.length < 9 || !/^\d{2}\/\d{2}\/\d{4}$/.test(c[4] ?? "")) continue;
    const [origem, produto, descricao, unidade, data, min, medio, max, mercado] = c;
    const preco = numero(medio);
    if (preco == null || preco <= 0) continue;
    linhas.push({
      produto: produto.toUpperCase(),
      descricao,
      uf: "SP",
      praca: PRACA,
      preco,
      preco_min: numero(min),
      preco_max: numero(max),
      unidade,
      tendencia: mercado || null,
      data_referencia: paraISO(data),
      fonte: FONTE,
      _origem: origem,
    });
  }
  return linhas;
}

async function abrirPagina() {
  const { texto: html, res } = await buscarComCuidado(URL_PAGINA, { ua: UA });
  const token = html.match(/__RequestVerificationToken" type="hidden" value="([^"]*)"/)?.[1];
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!token) throw new Error("IEA atacado: token de sessão não encontrado (layout mudou?)");
  return { token, cookie };
}

async function consultarDia(sessao, dia) {
  const p = new URLSearchParams();
  p.append("__RequestVerificationToken", sessao.token);
  for (const c of PRODUTOS) p.append("prod", String(c));
  p.append("startDate", dia);
  p.append("endDate", dia);
  const { texto } = await buscarComCuidado(URL_PAGINA, {
    metodo: "POST",
    ua: UA,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessao.cookie,
    },
    corpo: p.toString(),
  });
  return extrairLinhas(texto);
}

async function run() {
  await atrasoInicial();
  // Só os dias úteis que ainda não estão em precos_atacado (um pedido por dia, todos os produtos juntos).
  const jaTem = await datasJaGravadas(supabase, { tabela: "precos_atacado", fonte: FONTE, dias: DIAS + 2 });
  const pendentes = process.env.FORCAR === "1" ? diasSemDado(DIAS, new Set()) : diasSemDado(DIAS, jaTem);
  if (pendentes.length === 0) return console.log("IEA atacado: nenhum dia útil pendente.");
  const sessao = await abrirPagina();
  const todas = [];
  const dias = [];
  for (const iso of pendentes) {
    const dia = isoParaBR(iso);
    const linhas = await consultarDia(sessao, dia);
    await esperarComVariacao(400, 300);
    if (linhas.length === 0) continue; // feriado ou ainda não publicado
    dias.push(dia);
    todas.push(...linhas);
  }
  console.log(`Dias pendentes: ${pendentes.length}; com preço: ${dias.join(", ") || "nenhum"}. ${todas.length} linha(s).`);
  if (todas.length === 0) {
    // Nada novo é normal (feriado, ainda não publicado). Só é falha se a tabela está vazia nos últimos dias.
    if (jaTem.size === 0) {
      console.error("IEA atacado: nenhuma linha extraída e a tabela está sem dados recentes.");
      process.exit(1);
    }
    return console.log("Nada novo para gravar.");
  }
  const unicas = new Map();
  for (const l of todas) {
    const { _origem, ...linha } = l;
    unicas.set(`${l.produto}|${l.descricao}|${l.data_referencia}`, linha);
  }
  const rows = [...unicas.values()];
  const { error } = await supabase
    .from("precos_atacado")
    .upsert(rows, { onConflict: "produto,descricao,uf,praca,data_referencia" });
  if (error) {
    console.error("Erro ao gravar em precos_atacado (a tabela existe? rode supabase/precos-atacado.sql):", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", rows.length);
}

if (!process.env.IEA_ATACADO_SEM_EXECUTAR) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
