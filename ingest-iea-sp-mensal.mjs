import { createClient } from "@supabase/supabase-js";

import { UA_PADRAO, atrasoInicial, buscarComCuidado, esperarComVariacao, jaCaptadoHa } from "./coleta-educada.mjs";

// IEA-SP, série MENSAL de "Preços Médios Recebidos pelos Agricultores" (estado de SP). É outra base que a diária
// (ingest-iea-sp.mjs): ASP.NET WebForms (nia1/precos_medios.aspx), tem cana de açúcar, leite, suíno, ovos e dezenas de
// hortifrutis que a série diária não traz. Defasagem de uns 4 meses (em out/2026 o último mês era jun/2026): a data
// gravada é o dia 1 do mês e a fonte diz "(mensal)", como Conseleite e Epagri, para o app citar o mês e não um dia.
// Uso autorizado pelo IEA (contato do Matheus em 2026-10-22: dado público, sem problema).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes: rodando em modo dry-run.");
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = UA_PADRAO;
const URL_PAGINA = "https://infoiea.agricultura.sp.gov.br/nia1/precos_medios.aspx?cod_sis=2";
const FONTE = "IEA-SP (mensal)";
const UF = "SP";
// A página mostra 40 linhas por vez (paginação) e a janela inteira tem até 18 meses: 1 produto por consulta cabe sempre
// (18 linhas) e dispensa paginar.
const LOTE_DE_PRODUTOS = 1;

// Produtos que já têm fonte melhor no app (commodities e reposição/pecuária com série diária própria): ficam de fora.
const EXCLUIR = /^(soja|milho|boi |boi$|caf[eé]|bezerr|vaca|touro|garrote|novilha|burro|marruco|borracha|eucalipto|casulo|poedeira|triticale)/i;

// Nome do IEA -> nome na nossa base. O que não está aqui vira "<NOME EM MAIÚSCULAS> (IEA-SP)". Estes reaproveitam o
// nome da série diária para formar uma série só (mesmo produto, mesma unidade); cana e os demais seguem o catálogo.
const NOMES = {
  "Cana de açucar": "CANA-DE-AÇÚCAR (IEA-SP)",
  "Leite cru refrigerado": "LEITE CRU RESFRIADO (IEA-SP)",
  "Leite tipo B": "LEITE B (IEA-SP)",
  "Leite tipo C": "LEITE C (IEA-SP)",
  "Tomate para mesa": "TOMATE DE MESA (IEA-SP)",
  "Banana nanica": "BANANA NANICA (IEA-SP)",
  "Banana prata": "BANANA PRATA (IEA-SP)",
  Batata: "BATATA (IEA-SP)",
  Cebola: "CEBOLA (IEA-SP)",
  "Laranja para indústria": "LARANJA PARA INDÚSTRIA (IEA-SP)",
  "Laranja para mesa": "LARANJA PARA MESA (IEA-SP)",
  "Mandioca para indústria": "MANDIOCA INDÚSTRIA (IEA-SP)",
  "Mandioca para mesa (com casca)": "MANDIOCA PARA MESA (IEA-SP)",
  "Arroz em casca": "ARROZ EM CASCA (IEA-SP)",
  "Amendoim em casca": "AMENDOIM EM CASCA (IEA-SP)",
  "Algodão em caroço": "ALGODÃO EM CAROÇO (IEA-SP)",
  Trigo: "TRIGO (IEA-SP)",
  // O catálogo do app chama o sorgo de "sorgo granífero"; o nome precisa conter essas palavras para a busca achar.
  Sorgo: "SORGO GRANÍFERO (IEA-SP)",
};

const MESES = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };

const limpar = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const numero = (s) => {
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function nomeNaBase(nomeIea) {
  return NOMES[nomeIea] ?? `${nomeIea.toUpperCase()} (IEA-SP)`;
}

export function extrairLinhas(html) {
  const linhas = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const c = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(limpar);
    if (c.length < 6) continue;
    const [produto, mes, ano, moeda, preco, unidade] = c;
    if (!/^\d{2}$/.test(mes) || !/^\d{4}$/.test(ano) || moeda !== "R$") continue;
    const valor = numero(preco);
    if (valor == null || valor <= 0) continue;
    linhas.push({ produtoIea: produto, mes: Number(mes), ano: Number(ano), valor, unidade });
  }
  return linhas;
}

async function abrirPagina() {
  const { texto: html, res } = await buscarComCuidado(URL_PAGINA, { ua: UA });
  const campo = (nome) => html.match(new RegExp(`name="${nome}"[^>]*value="([^"]*)"`))?.[1];
  const viewstate = campo("__VIEWSTATE");
  if (!viewstate) throw new Error("IEA mensal: __VIEWSTATE não encontrado (layout mudou?)");
  const opcoes = (id) =>
    [...(html.match(new RegExp(`<select[^>]*name="${id}"[\\s\\S]*?</select>`))?.[0] ?? "").matchAll(
      /<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g,
    )].map((m) => ({ valor: m[1], rotulo: limpar(m[2]) }));
  const periodos = opcoes("cmbPeriodo_Inicial");
  if (periodos.length === 0) throw new Error("IEA mensal: nenhum período na página (layout mudou?)");
  const produtos = [...html.matchAll(/<input id="chkLstItens_(\d+)"[^>]*name="([^"]+)"[^>]*\/><label[^>]*>([^<]*)<\/label>/g)].map(
    (m) => ({ indice: Number(m[1]), campo: m[2], nome: limpar(m[3]) }),
  );
  if (produtos.length < 50) throw new Error(`IEA mensal: só ${produtos.length} produtos na página (layout mudou?)`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    viewstate,
    gerador: campo("__VIEWSTATEGENERATOR") ?? "",
    validacao: campo("__EVENTVALIDATION") ?? "",
    periodos,
    produtos,
    cookie,
  };
}

async function consultar(pagina, produtos, inicio, fim) {
  const corpo = new URLSearchParams();
  corpo.set("__VIEWSTATE", pagina.viewstate);
  corpo.set("__VIEWSTATEGENERATOR", pagina.gerador);
  if (pagina.validacao) corpo.set("__EVENTVALIDATION", pagina.validacao);
  corpo.set("cmbPeriodo_Inicial", inicio);
  corpo.set("cmbPeriodo_Final", fim);
  for (const p of produtos) corpo.set(p.campo, "on");
  corpo.set("imgPesquisar", "Pesquisar");
  const { texto: html } = await buscarComCuidado(URL_PAGINA, {
    metodo: "POST",
    ua: UA,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: pagina.cookie, Referer: URL_PAGINA },
    corpo: corpo.toString(),
  });
  const linhas = extrairLinhas(html);
  const total = Number(html.match(/(\d+)\s+registro/i)?.[1] ?? linhas.length);
  if (total > linhas.length) throw new Error(`IEA mensal: ${total} registros na página mas só ${linhas.length} lidos (paginação?)`);
  return linhas;
}

async function run() {
  // O IEA fecha um mês novo por vez (a série tem ~4 meses de atraso): uma coleta a cada poucos dias basta.
  if (!DRY_RUN && (await jaCaptadoHa(supabase, { fonte: FONTE, horas: 72 }))) return console.log("IEA mensal já coletado nas últimas 72 h: nada a pedir.");
  await atrasoInicial();
  const pagina = await abrirPagina();
  const inicio = pagina.periodos[0].valor;
  const fim = pagina.periodos.at(-1).valor;
  console.log(`Períodos disponíveis: ${pagina.periodos[0].rotulo} a ${pagina.periodos.at(-1).rotulo}`);
  const alvo = pagina.produtos.filter((p) => !EXCLUIR.test(p.nome));
  console.log(`${alvo.length} de ${pagina.produtos.length} produtos (o resto tem fonte melhor no app).`);

  const todas = [];
  for (let i = 0; i < alvo.length; i += LOTE_DE_PRODUTOS) {
    const lote = alvo.slice(i, i + LOTE_DE_PRODUTOS);
    const linhas = await consultar(pagina, lote, inicio, fim);
    todas.push(...linhas);
    await esperarComVariacao(400, 300);
  }
  console.log(`${todas.length} linha(s) lidas.`);

  const rows = new Map();
  for (const l of todas) {
    const produto = nomeNaBase(l.produtoIea);
    const data = `${l.ano}-${String(l.mes).padStart(2, "0")}-01`;
    rows.set(`${produto}|${data}`, {
      produto,
      uf: UF,
      regiao: "",
      nivel_comercializacao: "PRODUTOR",
      preco: l.valor,
      unidade: l.unidade,
      data_referencia: data,
      fonte: FONTE,
    });
  }
  const dedup = [...rows.values()];
  if (dedup.length < 300) throw new Error(`IEA mensal: só ${dedup.length} linhas (esperava centenas); abortando sem gravar.`);
  const maisRecente = dedup.reduce((a, b) => (a.data_referencia >= b.data_referencia ? a : b)).data_referencia;
  const produtosGravados = new Set(dedup.map((r) => r.produto));
  console.log(`${dedup.length} linha(s), ${produtosGravados.size} produto(s); mês mais recente ${maisRecente}.`);

  if (DRY_RUN) {
    console.log("DRY RUN, amostra:");
    for (const nome of ["CANA-DE-AÇÚCAR (IEA-SP)", "LEITE CRU RESFRIADO (IEA-SP)", "ALFACE (IEA-SP)"]) {
      const r = dedup.filter((x) => x.produto === nome).sort((a, b) => a.data_referencia.localeCompare(b.data_referencia));
      console.log(nome, r.map((x) => `${x.data_referencia.slice(0, 7)}=${x.preco}`).join(" "), r[0]?.unidade);
    }
    console.log([...produtosGravados].sort().join(" | "));
    return;
  }

  const CHUNK = 500;
  for (let i = 0; i < dedup.length; i += CHUNK) {
    const { error } = await supabase
      .from("precos")
      .upsert(dedup.slice(i, i + CHUNK), { onConflict: "produto,uf,regiao,data_referencia" });
    if (error) {
      console.error("Erro ao gravar:", error);
      process.exit(1);
    }
  }
  console.log("OK. Linhas gravadas:", dedup.length);
}

if (!process.env.IEA_MENSAL_SEM_EXECUTAR) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
