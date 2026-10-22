import { createClient } from "@supabase/supabase-js";

import { atrasoInicial, buscarComCuidado, esperarComVariacao, jaCaptadoHa } from "./coleta-educada.mjs";

// Cepea/Esalq: valores publicados nas páginas de indicador (suíno diário por estado; leite cru mensal por estado). Uso autorizado por
// escrito pelo Cepea (e-mail ao Matheus, 2026-10-22: "a utilização de informações factuais públicas, como indicadores e valores de
// mercado, poderá ocorrer na plataforma Safralume, inclusive em suas ferramentas de consulta e funcionalidades destinadas aos
// produtores rurais"). Limites do mesmo e-mail: não abrange reprodução de relatórios, materiais exclusivos, bases protegidas nem
// conteúdo sujeito a licenciamento; por isso lê SÓ a tabela que a página já mostra (sem "Série de preços", sem download, sem
// "Consulta ao Banco de Dados") e toda resposta cita o Cepea. Ver dados/autorizacoes_uso_de_dados_2026-10-22.md.
// O robots.txt do Cepea libera `User-agent: *` e bloqueia robôs de IA pelo nome: este é um script comum, com identificação própria.

const DRY = process.env.DRY === "1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes.");
  process.exit(2);
}
const supabase = DRY ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "SafralumeBot/1.0 (+https://safralume.com.br; indicadores publicos do Cepea, uso autorizado)";
const FONTE = "Cepea/Esalq";
const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const ESTADOS_DO_LEITE = new Set(["RS", "SC", "PR", "SP", "MG", "GO", "BA", "RJ", "ES"]);

const limpar = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const numero = (s) => {
  const n = Number(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

function tabelas(html) {
  return (html.match(/<table[\s\S]*?<\/table>/gi) ?? []).map((tb) =>
    (tb.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((tr) => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(limpar)),
  );
}

/** Suíno: linhas "21/10/2026 | MG - posto | 6,96 | ..." da primeira tabela com coluna de estado. */
export function linhasDoSuino(html) {
  const out = [];
  for (const tb of tabelas(html)) {
    for (const c of tb) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0] ?? "");
      const e = /^([A-Z]{2}) - (posto|a retirar)$/i.exec(c[1] ?? "");
      const preco = numero(c[2] ?? "");
      if (!m || !e || preco == null || preco <= 0 || preco > 30) continue;
      out.push({
        produto: "SUÍNO VIVO (CEPEA) (kg)",
        uf: e[1].toUpperCase(),
        regiao: "",
        nivel_comercializacao: "PRODUTOR",
        preco,
        unidade: `kg vivo (${e[2].toLowerCase()})`,
        data_referencia: `${m[3]}-${m[2]}-${m[1]}`,
        fonte: FONTE,
      });
    }
  }
  return out;
}

/** Leite cru: linhas "ago/26 | RS | 2,6545" (preço médio ao produtor, R$/litro, por estado e mês). */
export function linhasDoLeite(html) {
  const out = [];
  for (const tb of tabelas(html)) {
    for (const c of tb) {
      const m = /^([a-zç]{3})\/(\d{2})$/i.exec(c[0] ?? "");
      const uf = (c[1] ?? "").toUpperCase();
      const preco = numero(c[2] ?? "");
      if (!m || !MESES[m[1].toLowerCase()] || !ESTADOS_DO_LEITE.has(uf) || preco == null || preco < 0.5 || preco > 10) continue;
      out.push({
        produto: "LEITE (CEPEA) (l)",
        uf,
        regiao: "",
        nivel_comercializacao: "PRODUTOR",
        preco,
        unidade: "l",
        data_referencia: `20${m[2]}-${String(MESES[m[1].toLowerCase()]).padStart(2, "0")}-01`,
        fonte: FONTE,
      });
    }
  }
  return out;
}

/** Baixa a página com GET condicional (Last-Modified guardado entre execuções); null se não mudou desde a última vez. */
async function baixar(url) {
  const r = await buscarComCuidado(url, { ua: UA, condicional: true });
  return r.naoModificado ? null : r.texto;
}

async function run() {
  if (await jaCaptadoHa(supabase, { fonte: FONTE, horas: 3 })) return console.log("Cepea já coletado nas últimas 3 h: nada a pedir.");
  await atrasoInicial();
  const htmlSuino = await baixar("https://www.cepea.org.br/br/indicador/suino.aspx");
  await esperarComVariacao(4000);
  const htmlLeite = await baixar("https://www.cepea.org.br/br/indicador/leite.aspx");
  if (htmlSuino === null && htmlLeite === null) return console.log("Cepea: as duas páginas não mudaram desde a última coleta (304).");
  const suino = htmlSuino ? linhasDoSuino(htmlSuino) : [];
  const leite = htmlLeite ? linhasDoLeite(htmlLeite) : [];
  if (htmlSuino && suino.length < 5) throw new Error(`Cepea suíno: só ${suino.length} linha(s) (layout mudou?)`);
  if (htmlLeite && leite.length < 5) throw new Error(`Cepea leite: só ${leite.length} linha(s) (layout mudou?)`);
  const datas = (l) => [...new Set(l.map((x) => x.data_referencia))].sort();
  console.log(`suíno: ${suino.length} linhas${suino.length ? `, ${datas(suino).at(0)} a ${datas(suino).at(-1)}` : ""}; leite: ${leite.length} linhas${leite.length ? `, ${datas(leite).at(0)} a ${datas(leite).at(-1)}` : ""}`);
  const linhas = [...suino, ...leite];
  if (DRY) {
    console.log(JSON.stringify(linhas.slice(0, 3)));
    return console.log("DRY: nada gravado.");
  }
  const { error } = await supabase.from("precos").upsert(linhas, { onConflict: "produto,uf,regiao,data_referencia" });
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", linhas.length);
}

if (!process.env.CEPEA_SEM_EXECUTAR) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
