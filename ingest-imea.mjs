import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Só as cadeias com Boletim Semanal vivo e com preço de verdade (verificado
// baixando e lendo PDF real de cada uma). Leite só tem boletim anual
// (obsoleto) e Suínos não tem boletim de preço — de propósito fora daqui.
const CADEIAS = { soja: 4, milho: 3, algodao: 1, boi: 2 };
const TIPO_BOLETIM_SEMANAL = "809881640863047681";

const MESES = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

function parseNumeroBR(s) {
  const limpo = (s ?? "").trim().replace(/%/g, "").replace(/\./g, "").replace(",", ".");
  return parseFloat(limpo);
}

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

/**
 * Classifica um rótulo de período (o que aparece no cabeçalho da tabela,
 * ex: "17/08/2026", "20/07 a 24/07", "abr/26", "2º trim/25") e devolve a
 * data_referencia + periodicidade correspondente. `anoPublicacao` é usado
 * pra completar o ano quando o rótulo não traz (semanal/mensal/trimestral).
 */
function resolverPeriodo(label, anoPublicacao) {
  let m = label.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    return { periodicidade: "diario", data_referencia: `${m[3]}-${m[2]}-${m[1]}` };
  }

  m = label.match(/^\d{2}\/\d{2}\s*a\s*(\d{2})\/(\d{2})$/);
  if (m) {
    let ano = anoPublicacao;
    const mesFim = parseInt(m[2], 10);
    return { periodicidade: "semanal", data_referencia: `${ano}-${m[2]}-${m[1]}`, mesFim };
  }

  m = label.match(/^([a-zç]{3})\/(\d{2})$/i);
  if (m && MESES[m[1].toLowerCase()]) {
    const mes = MESES[m[1].toLowerCase()];
    const ano = 2000 + parseInt(m[2], 10);
    return { periodicidade: "mensal", data_referencia: ultimoDiaDoMes(ano, mes), mesFim: mes };
  }

  m = label.match(/^(\d)[ºo]?\s*trim\/(\d{2})$/i);
  if (m) {
    const trimestre = parseInt(m[1], 10);
    const ano = 2000 + parseInt(m[2], 10);
    const mesFim = trimestre * 3;
    return { periodicidade: "trimestral", data_referencia: ultimoDiaDoMes(ano, mesFim), mesFim };
  }

  return null;
}

const ANCHOR_RE = /Local\s*\tUnidade\s*\tFonte/g;
const ROW_RE =
  /^(.+?)\t(.+?)\t(.+?)\t(.+?)\t([\d.,%-]+)\s*\t([\d.,%-]+)\s*\t([\d.,%-]+)\s*\t([\d.,%-]+)\s*\t([\d.,%-]+)\s*$/;

const LABEL_PATTERNS = [
  /\d{2}\/\d{2}\/\d{4}/g,
  /\d{2}\/\d{2}\s*a\s*\d{2}\/\d{2}/g,
  /\d[ºo]?\s*trim\/\d{2}/gi,
  /[a-zç]{3}\/\d{2}/gi,
];

function extrairBlocos(texto) {
  const anchors = [...texto.matchAll(ANCHOR_RE)].map((m) => ({
    inicio: m.index,
    fim: m.index + m[0].length,
  }));

  const blocos = anchors.map((a, i) => {
    const janela = texto.slice(a.fim, a.fim + 250);
    let labels = [];
    for (const pattern of LABEL_PATTERNS) {
      const found = [...janela.matchAll(pattern)].map((m) => m[0].trim());
      if (found.length >= 5) {
        labels = found.slice(0, 5);
        break;
      }
    }
    return { inicio: a.inicio, labels };
  });

  return blocos;
}

function blocoParaPosicao(blocos, posicao) {
  let alvo = null;
  for (const b of blocos) {
    if (b.inicio <= posicao) alvo = b;
    else break;
  }
  return alvo;
}

function parsearIndicadores(texto, cadeia, anoPublicacao) {
  const blocos = extrairBlocos(texto);
  const linhas = texto.split("\n");
  const resultados = [];
  let offset = 0;

  for (const linha of linhas) {
    const posicaoLinha = offset;
    offset += linha.length + 1;

    const m = linha.match(ROW_RE);
    if (!m) continue;

    const bloco = blocoParaPosicao(blocos, posicaoLinha);
    if (!bloco || bloco.labels.length !== 5) continue;

    const [, indicadorRaw, localRaw, unidadeRaw, fonteRaw, ...valoresRaw] = m;
    const indicador = indicadorRaw.trim();
    const local = localRaw.trim() || null;
    const unidade = unidadeRaw.trim();

    for (let i = 0; i < 5; i++) {
      const valorStr = valoresRaw[i].trim();
      if (valorStr === "-" || valorStr === "") continue;
      const valor = parseNumeroBR(valorStr);
      if (Number.isNaN(valor)) continue;

      const periodo = resolverPeriodo(bloco.labels[i], anoPublicacao);
      if (!periodo) continue;

      resultados.push({
        cadeia,
        indicador,
        local,
        unidade,
        periodicidade: periodo.periodicidade,
        valor,
        data_referencia: periodo.data_referencia,
        fonte: "Imea",
      });
    }
  }

  return resultados;
}

function extrairNumeroBoletim(textoPagina1) {
  const m = textoPagina1.match(/n[ºo]\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Acha a manchete da página 2 (a análise/destaque) pelo tamanho de fonte —
 * não dá pra confiar na ordem de leitura do texto puro, porque o boletim de
 * cada cadeia intercala a manchete com título de gráfico/dado numérico em
 * ordens diferentes (testado e confirmado nas 4 cadeias). A manchete é
 * sempre o maior texto da página, uma linha só, sem dígito.
 */
async function acharManchete(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  if (doc.numPages < 2) return null;
  const page = await doc.getPage(2);
  const content = await page.getTextContent();

  const linhas = [];
  for (const it of content.items) {
    if (!it.str.trim()) continue;
    const y = it.transform[5];
    let linha = linhas.find((l) => Math.abs(l.y - y) < 2);
    if (!linha) {
      linha = { y, itens: [] };
      linhas.push(linha);
    }
    linha.itens.push(it);
  }
  for (const l of linhas) {
    l.itens.sort((a, b) => a.transform[4] - b.transform[4]);
    l.texto = l.itens.map((i) => i.str).join("");
    l.tamFonte = Math.max(...l.itens.map((i) => Math.abs(i.transform[0])));
  }

  const candidatas = linhas
    .filter((l) => l.tamFonte >= 14)
    .filter((l) => /[a-zà-úA-ZÀ-Ú]/.test(l.texto))
    .filter((l) => !/\d/.test(l.texto))
    .filter((l) => l.texto.trim().length >= 8 && l.texto.trim().length <= 80)
    .sort((a, b) => b.tamFonte - a.tamFonte);

  return candidatas[0]?.texto.trim() ?? null;
}

function pareceProsa(linha) {
  const l = linha.trim();
  if (l.length < 2) return false;
  if (/^(Fonte|Nota|Obs)[:.]/i.test(l)) return false; // legenda/rodapé de gráfico
  if (/^[¹²³]/.test(l)) return false; // marcador de nota de rodapé
  const letras = l.match(/[a-zà-úA-ZÀ-Ú]/g) ?? [];
  if (letras.length === 0) return false;
  const minusculas = l.match(/[a-zà-ú]/g) ?? [];
  // título/legenda de gráfico é majoritariamente maiúsculo (mesmo com
  // alguma unidade em minúsculo tipo "(R$/kg)"); prosa de verdade não é.
  if (minusculas.length / letras.length < 0.4) return false;
  return true; // pode começar com número (quebra de linha no meio de frase)
}

/**
 * Pega o parágrafo de "destaque" logo depois da manchete, usando o texto
 * puro (esse já vem contíguo e bem formado — o problema nunca foi o
 * parágrafo em si, só achar onde ele começa). Corta num fim de frase de
 * verdade — é resumo com link "ler completo" ao lado, não precisa do
 * parágrafo inteiro.
 */
function extrairResumo(textoPagina2, manchete) {
  if (!manchete) return null;
  const idx = textoPagina2.indexOf(manchete);
  if (idx === -1) return null;
  const resto = textoPagina2.slice(idx + manchete.length);
  const linhas = resto.split("\n");

  const acumulado = [];
  let comecou = false;
  for (const linhaRaw of linhas) {
    const linha = linhaRaw.trim();
    if (!comecou) {
      if (pareceProsa(linha)) comecou = true;
      else continue;
    }
    if (!pareceProsa(linha)) break;
    acumulado.push(linha);
    if (acumulado.join(" ").length > 1200) break;
  }
  if (acumulado.length === 0) return null;

  let texto = "";
  for (const linha of acumulado) {
    if (texto.endsWith("-") && /[a-zà-ú]$/i.test(texto.slice(0, -1))) {
      texto = texto.slice(0, -1) + linha;
    } else if (texto) {
      texto += " " + linha;
    } else {
      texto = linha;
    }
  }

  if (texto.length > 500) {
    const corte = texto.lastIndexOf(". ", 500);
    if (corte > 150) texto = texto.slice(0, corte + 1);
  }
  return texto;
}

async function jaTemos(cadeia, dataPublicacao) {
  if (DRY_RUN) return false;
  const { data } = await supabase
    .from("imea_boletins")
    .select("id")
    .eq("cadeia", cadeia)
    .eq("data_publicacao", dataPublicacao)
    .maybeSingle();
  return !!data;
}

async function coletarCadeia(cadeia, cadeiaId) {
  console.log(`\n=== ${cadeia} (cadeia=${cadeiaId}) ===`);
  const url = `https://api1.imea.com.br/api/arquivo?cadeia=${cadeiaId}&tipo=${TIPO_BOLETIM_SEMANAL}&page=1&pageSize=1&nome=&sort=1`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  Falha na API (${res.status}), pulando.`);
    return;
  }
  const json = await res.json();
  const item = json?.Result?.[0];
  if (!item) {
    console.log("  Nenhum boletim encontrado.");
    return;
  }

  const dataPublicacao = item.Data.slice(0, 10);
  if (await jaTemos(cadeia, dataPublicacao)) {
    console.log(`  Já temos a edição de ${dataPublicacao}, pulando.`);
    return;
  }

  console.log(`  Edição nova: ${item.Nome} (${dataPublicacao})`);
  const pdfRes = await fetch(item.Path);
  if (!pdfRes.ok) {
    console.log(`  Falha ao baixar PDF (${pdfRes.status}), pulando.`);
    return;
  }
  const buf = Buffer.from(await pdfRes.arrayBuffer());

  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  const anoPublicacao = parseInt(dataPublicacao.slice(0, 4), 10);

  const textoCompleto = (result.pages ?? []).map((p) => p.text).join("\n") || result.text || "";
  const numero = extrairNumeroBoletim(result.pages?.[0]?.text ?? textoCompleto);
  const indicadores = parsearIndicadores(textoCompleto, cadeia, anoPublicacao);

  const manchete = await acharManchete(buf).catch((err) => {
    console.log("  Aviso: falha ao achar manchete —", err.message);
    return null;
  });
  const resumo = extrairResumo(result.pages?.[1]?.text ?? "", manchete);
  console.log(`  Manchete: ${manchete ?? "(não encontrada)"}`);

  console.log(`  Boletim nº ${numero ?? "?"} — ${indicadores.length} indicadores extraídos.`);
  if (indicadores.length === 0) {
    console.log("  Nenhum indicador reconhecido — layout pode ter mudado, pulando gravação.");
    return;
  }

  if (DRY_RUN) {
    console.log("  Resumo:", resumo ?? "(não encontrado)");
    console.log("  DRY RUN — amostra:");
    console.log(JSON.stringify(indicadores.slice(0, 6), null, 2));
    return;
  }

  const { error: errIndicadores } = await supabase
    .from("imea_indicadores")
    .upsert(indicadores, { onConflict: "cadeia,indicador,local,periodicidade,data_referencia" });
  if (errIndicadores) {
    console.error("  Erro ao gravar indicadores:", errIndicadores);
    return;
  }

  const { error: errBoletim } = await supabase.from("imea_boletins").upsert(
    {
      cadeia,
      numero,
      titulo: item.Nome,
      data_publicacao: dataPublicacao,
      url_leitura: item.UrlCompleto,
      manchete,
      resumo,
    },
    { onConflict: "cadeia,data_publicacao" },
  );
  if (errBoletim) {
    console.error("  Erro ao gravar boletim:", errBoletim);
    return;
  }

  console.log(`  OK. ${indicadores.length} indicadores + 1 boletim gravados.`);
}

async function main() {
  for (const [cadeia, cadeiaId] of Object.entries(CADEIAS)) {
    try {
      await coletarCadeia(cadeia, cadeiaId);
    } catch (err) {
      console.error(`  Erro inesperado em ${cadeia}:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
