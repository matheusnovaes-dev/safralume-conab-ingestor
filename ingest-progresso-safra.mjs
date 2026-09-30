import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// % de semeadura/colheita por cultura e UF, achado 2026-09-30 — é o dado que
// a imprensa cita ("Brasil já plantou 3,9% da soja") mas que NÃO vem do
// painel "Série Histórica de Safra - Grãos" (esse só dá o total da safra
// inteira). A fonte de verdade é uma página DIFERENTE, "Progresso de Safra"
// (semanal), com um Excel de verdade em cada semana — nada de Playwright
// nem de ler texto solto de PDF: as duas páginas de listagem são HTML
// server-renderizado normal, e a página final devolve o .xlsx direto no
// corpo da resposta (confirmado com curl puro, sem JS nenhum envolvido).
const LISTAGEM_URL =
  "https://www.gov.br/conab/pt-br/atuacao/informacoes-agropecuarias/safras/progresso-de-safra";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const ESTADO_PARA_UF = {
  Acre: "AC", Alagoas: "AL", Amapá: "AP", Amazonas: "AM", Bahia: "BA", Ceará: "CE",
  "Distrito Federal": "DF", "Espírito Santo": "ES", Goiás: "GO", Maranhão: "MA",
  "Mato Grosso": "MT", "Mato Grosso do Sul": "MS", "Minas Gerais": "MG", Pará: "PA",
  Paraíba: "PB", Paraná: "PR", Pernambuco: "PE", Piauí: "PI", "Rio de Janeiro": "RJ",
  "Rio Grande do Norte": "RN", "Rio Grande do Sul": "RS", Rondônia: "RO", Roraima: "RR",
  "Santa Catarina": "SC", "São Paulo": "SP", Sergipe: "SE", Tocantins: "TO",
};

// Achado real: "Mato Grosso " (com espaço sobrando) aparece numa das seções
// — normaliza espaços múltiplos/nas pontas antes de procurar no mapa acima,
// em vez de confiar que o nome vem sempre limpo.
function ufDoEstado(nomeEstado) {
  const limpo = nomeEstado.replace(/\s+/g, " ").trim();
  return ESTADO_PARA_UF[limpo] ?? null;
}

// Datas na planilha vêm como serial do Excel (dias desde 1899-12-30) — 25569
// é a diferença pro epoch Unix (1970-01-01), forma padrão de converter sem
// depender de nenhuma lib de data.
function serialParaIso(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function buscarUrlDoArquivoDaSemana() {
  const resListagem = await fetch(LISTAGEM_URL, { headers: { "User-Agent": UA } });
  if (!resListagem.ok) throw new Error(`Listagem retornou ${resListagem.status}`);
  const htmlListagem = await resListagem.text();

  // A listagem vem do mais recente pro mais antigo — o primeiro link
  // "acompanhamento-das-lavouras-..." é a semana mais nova publicada.
  const matchSemana = htmlListagem.match(
    /href="(https:\/\/www\.gov\.br\/conab\/pt-br\/atuacao\/informacoes-agropecuarias\/safras\/progresso-de-safra\/acompanhamento-das-lavouras-[^"]+)"/,
  );
  if (!matchSemana) throw new Error('Nenhum link "acompanhamento-das-lavouras" encontrado na listagem.');
  const urlSemana = matchSemana[1];

  const resSemana = await fetch(urlSemana, { headers: { "User-Agent": UA } });
  if (!resSemana.ok) throw new Error(`Página da semana retornou ${resSemana.status}`);
  const htmlSemana = await resSemana.text();

  const matchPlantio = htmlSemana.match(/href="(https:\/\/www\.gov\.br[^"]*\/plantio-e-colheita-[^"]+)"/);
  if (!matchPlantio) throw new Error('Nenhum link "plantio-e-colheita" encontrado na página da semana.');
  return { urlSemana, urlPlantioColheita: matchPlantio[1] };
}

// Cada bloco da planilha segue o mesmo formato: título "Cultura - Safra X",
// subtítulo (ignorado), "Semeadura"/"Colheita*", cabeçalho, linha de anos
// (formato inconsistente entre blocos — às vezes [2025,2026,"",""], às
// vezes [2025,2025,2026,""], por isso não usa essa linha pra nada), linha
// de datas-serial (sempre 3 valores: mesma semana ano passado, semana
// anterior deste ano, semana atual), depois uma linha por estado e uma
// linha de total ("N estados"). Um bloco termina numa linha em branco.
function parseBlocos(rows) {
  const blocos = [];
  let i = 0;
  while (i < rows.length) {
    const titulo = String(rows[i]?.[1] ?? "").trim();
    const matchTitulo = /^(.+?) - Safra (\d{4}(?:\/\d{2})?)$/.exec(titulo);
    if (!matchTitulo) {
      i++;
      continue;
    }
    const produto = matchTitulo[1].trim();
    const safra = matchTitulo[2];

    // i+1 = subtítulo "(Esses N estados...)", i+2 = "Semeadura"/"Colheita*"
    const linhaTipo = String(rows[i + 2]?.[1] ?? "").trim();
    const tipo = /colheita/i.test(linhaTipo)
      ? "colheita"
      : /semeadura/i.test(linhaTipo)
        ? "semeadura"
        : null;
    if (!tipo) {
      console.log(`  ! Bloco "${titulo}": não achei "Semeadura"/"Colheita*" na linha esperada, pulando.`);
      i++;
      continue;
    }

    // i+3 = cabeçalho ("Estado"/"Unidade da Federação" ...), i+4 = anos
    // (formato inconsistente, ignorado), i+5 = datas-serial.
    const linhaDatas = rows[i + 5] ?? [];
    const seriaisEncontrados = linhaDatas
      .map((v) => (typeof v === "number" ? v : null))
      .filter((v) => v != null);
    if (seriaisEncontrados.length === 0) {
      console.log(`  ! Bloco "${titulo}": não achei nenhuma data-serial na linha esperada, pulando.`);
      i++;
      continue;
    }
    // A semana atual é sempre a data mais recente das encontradas — mais
    // robusto do que confiar numa posição de coluna fixa.
    const semanaAtualSerial = Math.max(...seriaisEncontrados);
    const semanaReferencia = serialParaIso(semanaAtualSerial);
    const colunaAtual = linhaDatas.indexOf(semanaAtualSerial);

    // Média de 5 anos é sempre a ÚLTIMA coluna não-vazia da linha (rotulada
    // "Média 5 anos"/"Média  5 anos" no cabeçalho, com espaçamento
    // inconsistente entre blocos — por isso não compara o texto do rótulo).
    const colunaMedia = linhaDatas.length - 1;

    // Linhas de estado começam em i+6 e vão até a próxima linha em branco
    // (coluna B vazia) ou fim da planilha.
    let j = i + 6;
    const paises = [];
    while (j < rows.length && String(rows[j]?.[1] ?? "").trim() !== "") {
      const nomeCampo = String(rows[j][1]).trim();
      const percentualAtual = rows[j][colunaAtual];
      const media5Anos = rows[j][colunaMedia];
      const totalDeEstados = /^\d+\s+estados?$/i.test(nomeCampo);
      paises.push({
        uf: totalDeEstados ? "BR" : ufDoEstado(nomeCampo),
        nomeOriginal: nomeCampo,
        percentual: typeof percentualAtual === "number" ? percentualAtual : null,
        media_5_anos: typeof media5Anos === "number" ? media5Anos : null,
      });
      j++;
    }

    blocos.push({ produto, safra, tipo, semanaReferencia, estados: paises });
    i = j + 1;
  }
  return blocos;
}

async function run() {
  const { urlSemana, urlPlantioColheita } = await buscarUrlDoArquivoDaSemana();
  console.log("Semana encontrada:", urlSemana);
  console.log("Arquivo:", urlPlantioColheita);

  const resArquivo = await fetch(urlPlantioColheita, { headers: { "User-Agent": UA } });
  if (!resArquivo.ok) throw new Error(`Download do xlsx retornou ${resArquivo.status}`);
  const buf = Buffer.from(await resArquivo.arrayBuffer());

  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  const blocos = parseBlocos(rows);
  console.log(`\n${blocos.length} blocos (cultura x tipo) encontrados.`);

  const linhas = [];
  let semUf = 0;
  for (const bloco of blocos) {
    if (!bloco.semanaReferencia) {
      console.log(`  ! Bloco "${bloco.produto} - ${bloco.safra}" (${bloco.tipo}) sem semana de referência válida, pulando.`);
      continue;
    }
    for (const estado of bloco.estados) {
      if (!estado.uf) {
        console.log(`  ! Estado não reconhecido: "${estado.nomeOriginal}" (bloco ${bloco.produto})`);
        semUf++;
        continue;
      }
      if (estado.percentual == null) continue;
      linhas.push({
        produto: bloco.produto,
        safra: bloco.safra,
        tipo: bloco.tipo,
        uf: estado.uf,
        semana_referencia: bloco.semanaReferencia,
        percentual: estado.percentual,
        media_5_anos: estado.media_5_anos,
        fonte: "Conab",
      });
    }
  }

  console.log(`\n${linhas.length} linhas prontas (${semUf} estados não reconhecidos, ver log acima).`);

  if (linhas.length === 0) {
    console.log("Nenhum dado coletado. Abortando sem gravar.");
    return;
  }

  // Sanidade antes de gravar qualquer coisa: essa fonte é conhecida (Soja -
  // Safra 2026/27 tinha PR=15%, MT~5,7%, Brasil~3,9% no dia em que isso foi
  // descoberto) — se um dia a Conab mudar o layout da planilha de um jeito
  // que o parser não perceba, é melhor abortar com erro claro do que gravar
  // silenciosamente um número errado ou incompleto.
  const distintosProdutoTipo = new Set(linhas.map((l) => `${l.produto}|${l.tipo}`));
  console.log("Combinações produto x tipo:", [...distintosProdutoTipo].join(", "));
  if (semUf > 5) {
    throw new Error(
      `${semUf} estados não reconhecidos — layout da planilha pode ter mudado. Abortando sem gravar.`,
    );
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — amostra de 8 linhas:");
    console.log(JSON.stringify(linhas.slice(0, 8), null, 2));
    return;
  }

  console.log("\nGravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("progresso_safra_conab")
    .upsert(linhas, { onConflict: "produto,safra,tipo,uf,semana_referencia" });
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", linhas.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
