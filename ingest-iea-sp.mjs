import { createClient } from "@supabase/supabase-js";

import { UA_PADRAO, atrasoInicial, buscarComCuidado, datasJaGravadas, diasSemDado, esperarComVariacao, isoParaBR } from "./coleta-educada.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = UA_PADRAO;
const UF = "SP";
const FONTE = "IEA-SP";
const BASE_URL = "https://infoiea.agricultura.sp.gov.br/BancoDeDados/PrecosDiarios/Recebidos";

// EDRs (Escritórios de Desenvolvimento Rural) 01-41, mais o código especial
// 99 = agregado do Estado de SP inteiro (esse vira regiao="", os outros
// viram o nome do EDR — mesmo padrão de regiao já usado no EPAGRI-SC).
const EDRS = Array.from({ length: 41 }, (_, i) => String(i + 1).padStart(2, "0")).concat(["99"]);

// Código do produto na IEA -> nome padronizado no nosso banco. Soja, milho
// e boi gordo entram como a mesma variante já usada pela Conab (mesma
// unidade confirmada testando: "sc.60 kg" pros grãos, "@" pro boi gordo,
// igual arroba/carcaça já usado em outras fontes). O resto vira variante
// própria "(IEA-SP)" — Conab não tem classe idêntica confirmada pra
// nenhum desses (feijão/trigo/arroz têm classificação por qualidade que
// não bate, o resto é produto que a Conab simplesmente não cobre).
//
// Importante: a UNIDADE nunca é fixada aqui — a própria página devolve a
// unidade de cada linha (coluna "Unidade" do resultado), e o script usa
// exatamente o que veio, sem supor nada.
const PRODUTOS = {
  1101: "ALGODÃO EM CAROÇO (IEA-SP)",
  1905: "ALGODÃO EM PLUMA (IEA-SP)",
  1102: "AMENDOIM EM CASCA (IEA-SP)",
  1105: "ARROZ EM CASCA (IEA-SP)",
  1107: "BANANA NANICA (IEA-SP)",
  1108: "BANANA PRATA (IEA-SP)",
  1106: "BATATA (IEA-SP)",
  1449: "BEZERRA NELORE 12 MESES (IEA-SP)",
  1448: "BEZERRA NELORE 8 MESES (IEA-SP)",
  1407: "BEZERRO MACHO NELORE (IEA-SP)",
  1447: "BEZERRO NELORE 12 MESES (IEA-SP)",
  1446: "BEZERRO NELORE 8 MESES (IEA-SP)",
  1411: "BOI GORDO (15 kg)",
  1999: "BOI GORDO CHINA (IEA-SP)",
  1917: "BOI GORDO RASTREADO (IEA-SP)",
  1410: "BOI MAGRO NELORE (IEA-SP)",
  1053: "CAFÉ BENEFICIADO TIPO 6 DURO (IEA-SP)",
  1055: "CAFÉ CEREJA DESCASCADO (IEA-SP)",
  1109: "CANA PARA INDÚSTRIA (IEA-SP)",
  1111: "CEBOLA (IEA-SP)",
  1113: "FEIJÃO CARIOCA (IEA-SP)",
  1136: "FEIJÃO CARIOCA CAMPOS GERAIS COMERCIAL (IEA-SP)",
  1135: "FEIJÃO CARIOCA CAMPOS GERAIS EXTRA (IEA-SP)",
  1134: "FEIJÃO CARIOCA DAMA COMERCIAL (IEA-SP)",
  1133: "FEIJÃO CARIOCA DAMA EXTRA (IEA-SP)",
  1998: "FEIJÃO CARIOCA ESTILO EXTRA (IEA-SP)",
  1138: "FEIJÃO CARIOCA OUTROS COMERCIAL (IEA-SP)",
  1137: "FEIJÃO CARIOCA OUTROS EXTRA (IEA-SP)",
  1426: "FRANGO VIVO (IEA-SP)",
  1408: "GARROTE NELORE (IEA-SP)",
  1311: "LARANJA PARA INDÚSTRIA (IEA-SP)",
  1312: "LARANJA PARA MESA (IEA-SP)",
  1422: "LEITE B (IEA-SP)",
  1918: "LEITE B PREÇO BASE (IEA-SP)",
  1919: "LEITE B PREÇO MÁXIMO (IEA-SP)",
  1423: "LEITE C (IEA-SP)",
  1920: "LEITE C PREÇO BASE (IEA-SP)",
  1921: "LEITE C PREÇO MÁXIMO (IEA-SP)",
  1421: "LEITE CRU RESFRIADO (IEA-SP)",
  1119: "MANDIOCA INDÚSTRIA (IEA-SP)",
  1120: "MANDIOCA PARA MESA (IEA-SP)",
  1124: "MILHO EM GRÃOS (60 kg)",
  1450: "NOVILHA NELORE PARA ABATE (IEA-SP)",
  1915: "OVO TIPO EXTRA BRANCO (IEA-SP)",
  1916: "OVO TIPO GRANDE BRANCO (IEA-SP)",
  1430: "OVO TIPO MÉDIO BRANCO (IEA-SP)",
  1126: "SOJA EM GRÃOS (60 kg)",
  1403: "SUÍNO TIPO CARNE (IEA-SP)",
  1128: "TOMATE DE MESA (IEA-SP)",
  1130: "TRIGO (IEA-SP)",
  1412: "VACA GORDA (IEA-SP)",
  1451: "VACA MAGRA (IEA-SP)",
};

const NOMES_EDR = {
  "01": "Andradina", "02": "Araçatuba", "03": "Araraquara", "04": "Assis",
  "05": "Avaré", "06": "Barretos", "07": "Bauru", "08": "Botucatu",
  "09": "Brg.Paulista", "10": "Campinas", "11": "Catanduva", "12": "Dracena",
  "13": "Fernandópolis", "14": "Franca", "15": "Gal. Salgado", "16": "Guaratingueta",
  "17": "Itapetininga", "18": "Itapeva", "19": "Jaboticabal", "20": "Jales",
  "21": "Jaú", "22": "Limeira", "23": "Lins", "24": "Marília",
  "25": "Moji Das Cruzes", "26": "Mogi Mirim", "27": "Orlândia", "28": "Ourinhos",
  "29": "Pindamonhangaba", "30": "Piracicaba", "31": "Pres.Prudente", "32": "Pres.Venceslau",
  "33": "Registro", "34": "Rib.Preto", "35": "S.J.Boa Vista", "36": "S.J.Rio Preto",
  "37": "São Paulo", "38": "Sorocaba", "39": "Tupã", "40": "Votuporanga", "41": "Santos",
};

function paraISO(dataBR) {
  const [d, m, a] = dataBR.split("/");
  return `${a}-${m}-${d}`;
}

function numeroOuNull(s) {
  if (s == null || s === "") return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

async function obterSessao() {
  const { texto: html, res } = await buscarComCuidado(BASE_URL, { ua: UA });
  const token = html.match(/__RequestVerificationToken" type="hidden" value="([^"]*)"/)?.[1];
  const cookie = res.headers.get("set-cookie");
  if (!token || !cookie) throw new Error("Não encontrei token/cookie de sessão na página.");
  return { token, cookie: cookie.split(";")[0] };
}

async function buscarProduto(sessao, codigo, startDate, endDate) {
  const params = new URLSearchParams();
  params.append("__RequestVerificationToken", sessao.token);
  params.append("produtos", String(codigo));
  for (const e of EDRS) params.append("edrs", e);
  params.append("startDate", startDate);
  params.append("endDate", endDate);

  const { texto } = await buscarComCuidado(BASE_URL, {
    metodo: "POST",
    ua: UA,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessao.cookie,
    },
    corpo: params.toString(),
  });
  return texto;
}

// Linhas da tabela: <td>GRUPO</td><td>Produto</td><td>EDR</td><td>Data</td>
// <td class="text-right">Preço</td><td>Unidade</td><td>Obs</td>
const LINHA_RE =
  /<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td class="text-right">([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;

function limparHtml(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .trim();
}

function extrairLinhas(html, produtoPadronizado) {
  const linhas = [];
  for (const m of html.matchAll(LINHA_RE)) {
    const [, , , edrBruto, dataBruta, precoBruto, unidadeBruta] = m;
    const preco = numeroOuNull(limparHtml(precoBruto));
    if (preco == null) continue;
    const edr = limparHtml(edrBruto);
    linhas.push({
      produto: produtoPadronizado,
      uf: UF,
      regiao: edr === "Estado de São Paulo" ? "" : edr,
      nivel_comercializacao: "PRODUTOR",
      preco,
      unidade: limparHtml(unidadeBruta),
      data_referencia: paraISO(limparHtml(dataBruta)),
      fonte: FONTE,
    });
  }
  return linhas;
}

async function run() {
  const sessao = await obterSessao();

  // A página só devolve o dia da data INICIAL (startDate): a data final é ignorada e, se o dia inicial não tem preço (fim
  // de semana, feriado), responde "Não há preços" mesmo havendo dados nos dias seguintes (achado 2026-10-22: com a janela
  // de 10 dias da versão antiga, a coleta pegava sempre o dia de 10 dias atrás e, caindo em sábado/domingo/feriado, vinha
  // vazia; a base ficou parada em 09/10 enquanto o IEA já tinha 21/10, e o job aparecia "verde"). Agora consulta cada dia
  // da janela, um a um: primeiro a soja como sonda (dia sem preço é pulado) e, se há dado, todos os produtos.
  await atrasoInicial();
  const DIAS = Number(process.env.IEA_DIAS ?? 8);
  // Só pede os dias úteis que ainda não estão no banco (dia sem dado no IEA, como feriado, custa 1 pedido de sonda por rodada):
  // uma rodada normal faz ~50 pedidos em vez de ~400.
  const jaTem = supabase
    ? await datasJaGravadas(supabase, { fonte: FONTE, filtroProduto: "SOJA EM GRÃOS (60 kg)", dias: DIAS + 2 })
    : new Set();
  const pendentes = process.env.FORCAR === "1" ? diasSemDado(DIAS, new Set()) : diasSemDado(DIAS, jaTem);
  const todasLinhas = [];
  const diasComDado = [];
  for (const iso of pendentes) {
    const dia = isoParaBR(iso);
    const sonda = extrairLinhas(await buscarProduto(sessao, 1126, dia, dia), "SONDA");
    await esperarComVariacao(300, 200);
    if (sonda.length === 0) continue;
    diasComDado.push(dia);
    for (const [codigo, produtoPadronizado] of Object.entries(PRODUTOS)) {
      const html = await buscarProduto(sessao, codigo, dia, dia);
      todasLinhas.push(...extrairLinhas(html, produtoPadronizado));
      await esperarComVariacao(300, 200);
    }
  }
  console.log(`Dias pendentes: ${pendentes.length}; com preço: ${diasComDado.join(", ") || "nenhum"}.`);
  console.log(`${todasLinhas.length} linha(s) coletada(s) no total.`);

  if (todasLinhas.length === 0) {
    // Nada novo é normal (já estava tudo no banco, ou o IEA ainda não publicou o dia). Só é falha se o banco está vazio de verdade.
    if (supabase && jaTem.size === 0) {
      console.error(`Nenhuma linha extraída e o banco não tem nenhum dia dos últimos ${DIAS}. Abortando.`);
      process.exit(1);
    }
    console.log("Nada novo para gravar.");
    return;
  }

  const byKey = new Map();
  for (const row of todasLinhas) {
    byKey.set(`${row.produto}|${row.uf}|${row.regiao}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];
  console.log(
    `${dedupedRows.length} linha(s) prontas pra gravar (${todasLinhas.length} coletadas, ${todasLinhas.length - dedupedRows.length} duplicadas removidas).`,
  );

  if (DRY_RUN) {
    console.log("DRY RUN — amostra de 5 linhas:");
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
      console.error(`Erro ao gravar lote ${i}-${i + chunk.length}:`, error);
      process.exit(1);
    }
    gravadas += chunk.length;
  }
  console.log("OK. Linhas gravadas:", gravadas);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
