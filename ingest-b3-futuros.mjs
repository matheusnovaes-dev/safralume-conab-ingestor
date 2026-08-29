import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// O "Ajustes do Pregão" antigo foi descontinuado pela B3 em 10/12/2025. O
// substituto oficial é a tabela "Negócios consolidados do pregão" dentro do
// Boletim Diário do Mercado (capítulo "Derivativos de bolsa", arquivo
// BDI_03-4), que a própria B3 serve como PDF estático em arquivos.b3.com.br
// — sem login, sem cookie-consent, sem SPA. Confirmado testando: essa URL
// responde 200 direto via curl puro, sem Playwright.
const BASE_URL = "https://arquivos.b3.com.br/bdi/download/bdi";

// Só os 5 contratos futuros de commodities agropecuárias listados na B3.
// Unidade/moeda conferidas contra as especificações oficiais de cada
// contrato (não inventadas) — DOL/WDO (câmbio) ficam de fora de propósito,
// já cobertos pela cotação do BCB em ingest-cambio.mjs.
const PRODUTOS = {
  BGI: { nome: "Boi Gordo", moeda: "BRL", unidade: "R$/@ (arroba)" },
  CCM: { nome: "Milho", moeda: "BRL", unidade: "R$/saca 60kg" },
  ICF: { nome: "Café Arábica", moeda: "USD", unidade: "US$/saca 60kg" },
  SJC: { nome: "Soja (cross listing CME)", moeda: "USD", unidade: "US$/saca 60kg" },
  ETH: { nome: "Etanol Hidratado", moeda: "BRL", unidade: "R$/m³" },
};

const MES_LETRA = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
const TICKER_RE = /^(BGI|CCM|ICF|SJC|ETH)([FGHJKMNQUVXZ])(\d{2})$/;

function colunaDe(x) {
  if (x >= 410 && x < 484) return "ajuste_atual";
  if (x >= 484 && x < 563) return "ajuste_anterior";
  if (x >= 563 && x < 598) return "variacao";
  return null;
}

function numeroOuNull(s) {
  if (s == null || s === "-" || s === "") return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function paraISO(date) {
  return date.toISOString().slice(0, 10);
}

async function buscarPdfMaisRecente() {
  const hoje = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(hoje);
    d.setUTCDate(d.getUTCDate() - i);
    const dataISO = paraISO(d);
    const dataCompacta = dataISO.replace(/-/g, "");
    const url = `${BASE_URL}/${dataISO}/BDI_03-4_${dataCompacta}.pdf`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 10000) {
        console.log(`Boletim encontrado para ${dataISO} (${buf.length} bytes).`);
        return { buf, dataPregao: dataISO };
      }
    }
  }
  throw new Error("Nenhum boletim encontrado nos últimos 10 dias.");
}

async function extrairFuturos(buf) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;

  const linhas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // A "Negócios consolidados do pregão" (a tabela que queremos, com preço
    // de ajuste por instrumento) é seguida no mesmo capítulo por duas outras
    // tabelas — "...não regular" (negócios de balcão/não regulares) e
    // "Contratos em aberto" (posição em aberto) — com layouts de coluna
    // diferentes. Parar assim que qualquer uma delas aparecer evita ler os
    // mesmos tickers com o bucket de coluna errado (bug real, achado
    // testando: sem isso cada ticker aparecia 2-3x com valores errados).
    const tituloArea = content.items.slice(0, 20).map((i) => i.str).join(" ");
    if (tituloArea.includes("não regular") || tituloArea.includes("Contratos em aberto")) {
      page.cleanup();
      break;
    }

    const porLinha = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!porLinha.has(y)) porLinha.set(y, []);
      porLinha.get(y).push({ x, str: item.str });
    }

    for (const itens of porLinha.values()) {
      itens.sort((a, b) => a.x - b.x);
      const primeiro = itens[0];
      if (!primeiro || primeiro.x > 80) continue;
      const m = TICKER_RE.exec(primeiro.str.trim());
      if (!m) continue;

      const achado = {};
      for (const it of itens) {
        const col = colunaDe(it.x);
        let valor = it.str.trim();
        if (!col || valor === "-" || valor === "") continue;
        // Em algumas linhas o pdf.js funde "Variação" e "Valor do ajuste por
        // contrato" num único item de texto (mesmo bucket de coluna, um
        // espaço no meio) — bug real, achado testando contra os valores
        // conferidos manualmente. Sempre o primeiro número é o que importa.
        if (valor.includes(" ")) valor = valor.split(/\s+/)[0];
        achado[col] = valor;
      }
      if (achado.ajuste_atual == null) continue; // sem ajuste calculado nesse pregão

      const [, produto, mesLetra, anoYY] = m;
      const mes = MES_LETRA[mesLetra];
      const ano = 2000 + Number(anoYY);
      linhas.push({
        codigo_vencimento: primeiro.str.trim(),
        produto,
        mes_ano_vencimento: `${ano}-${String(mes).padStart(2, "0")}-01`,
        preco_ajuste_atual: numeroOuNull(achado.ajuste_atual),
        preco_ajuste_anterior: numeroOuNull(achado.ajuste_anterior),
        variacao: numeroOuNull(achado.variacao),
      });
    }
    page.cleanup();
  }
  return linhas;
}

async function run() {
  const { buf, dataPregao } = await buscarPdfMaisRecente();
  const linhas = await extrairFuturos(buf);
  console.log(`${linhas.length} contratos extraídos (pregão de ${dataPregao}).`);

  const rows = linhas.map((l) => ({
    data_pregao: dataPregao,
    produto: l.produto,
    nome_produto: PRODUTOS[l.produto].nome,
    codigo_vencimento: l.codigo_vencimento,
    mes_ano_vencimento: l.mes_ano_vencimento,
    preco_ajuste_atual: l.preco_ajuste_atual,
    preco_ajuste_anterior: l.preco_ajuste_anterior,
    variacao: l.variacao,
    moeda: PRODUTOS[l.produto].moeda,
    unidade: PRODUTOS[l.produto].unidade,
    fonte: "B3",
  }));

  if (rows.length === 0) {
    console.log("Nenhuma linha extraída. Abortando sem gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("b3_futuros")
    .upsert(rows, { onConflict: "codigo_vencimento,data_pregao" });

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
