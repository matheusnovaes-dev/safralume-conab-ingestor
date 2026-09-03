import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PAGINA_LISTAGEM = "https://www.emater.tche.br/site/info-agro/precos_semanais.php";
const UF = "RS";
const FONTE = "EMATER/RS-Ascar";

// Emater/RS-Ascar — "Cotações Agropecuárias", boletim semanal com preço
// mínimo/médio/máximo recebido pelo produtor no estado. Soja e milho
// entram como a mesma variante já usada pela Conab (mesma saca de 60kg,
// mesmo padrão já validado com o DERAL/PR); feijão/trigo/arroz ganham
// variante própria (Conab já é fragmentada nessas, mesma lógica do
// DERAL/PR). Boi/búfalo/cordeiro/suíno/vaca são cotados em R$/kg VIVO
// aqui — base de medida diferente do "boi gordo" em arroba (15kg,
// carcaça) já usado em outras fontes, então NENHUM desses faz merge:
// todos entram como variante própria, inclusive suíno (Conab tem
// "SUÍNO VIVO (kg)" mas sem confirmação de que a metodologia bate 1:1,
// mais seguro manter distinto do que arriscar juntar bases diferentes).
const PRODUTOS = {
  Arroz: { produto: "ARROZ (EMATER-RS) (50 kg)", unidade: "50 kg" },
  Boi: { produto: "BOI VIVO (EMATER-RS) (kg)", unidade: "kg vivo" },
  Búfalo: { produto: "BÚFALO VIVO (EMATER-RS) (kg)", unidade: "kg vivo" },
  Cordeiro: { produto: "CORDEIRO VIVO (EMATER-RS) (kg)", unidade: "kg vivo" },
  Feijão: { produto: "FEIJÃO (EMATER-RS) (60 kg)", unidade: "60 kg" },
  Milho: { produto: "MILHO EM GRÃOS (60 kg)", unidade: "60 kg" },
  Soja: { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg" },
  Suíno: { produto: "SUÍNO VIVO (EMATER-RS) (kg)", unidade: "kg vivo" },
  Trigo: { produto: "TRIGO (EMATER-RS) (60 kg)", unidade: "60 kg" },
  Vaca: { produto: "VACA VIVA (EMATER-RS) (kg)", unidade: "kg vivo" },
};

function numeroOuNull(s) {
  if (s == null) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

async function buscarPdfMaisRecente() {
  const res = await fetch(PAGINA_LISTAGEM, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Falha ao abrir a página de listagem: HTTP ${res.status}`);
  const html = await res.text();

  const links = [...html.matchAll(/href="([^"]*\/precos\/preco_(\d{2})(\d{2})(\d{4})\.pdf)"/g)];
  if (links.length === 0) throw new Error("Nenhum link de boletim encontrado na página.");

  let melhor = null;
  for (const [, url, dd, mm, aaaa] of links) {
    const dataISO = `${aaaa}-${mm}-${dd}`;
    if (!melhor || dataISO > melhor.dataISO) melhor = { url, dataISO };
  }

  const pdfRes = await fetch(melhor.url, { headers: { "User-Agent": UA } });
  if (!pdfRes.ok) throw new Error(`Falha ao baixar o boletim: HTTP ${pdfRes.status}`);
  const buf = new Uint8Array(await pdfRes.arrayBuffer());
  console.log(`Boletim encontrado: ${melhor.url} (${buf.length} bytes, semana até ${melhor.dataISO}).`);
  return { buf, dataReferencia: melhor.dataISO };
}

async function extrairPrecos(buf) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  // A tabela por produto/estado é sempre a página 1 ("ACOMPANHAMENTO
  // SEMANAL DE PREÇOS RECEBIDOS PELOS PRODUTORES NO ESTADO") — as páginas
  // seguintes são comparação histórica e detalhe por município, fora do
  // escopo desse ingest (mesmo nível de agregação que o DERAL/PR: média
  // estadual, não por cidade).
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const texto = content.items.map((i) => i.str).join(" ");

  const linhas = [];
  for (const [nome, info] of Object.entries(PRODUTOS)) {
    const re = new RegExp(`${nome}\\s+(\\S+\\s+\\S+)\\s+([\\d.,]+)\\s+([\\d.,]+)\\s+([\\d.,]+)`);
    const m = texto.match(re);
    if (!m) {
      console.log(`  aviso: "${nome}" não encontrado no boletim, pulando.`);
      continue;
    }
    const medio = numeroOuNull(m[3]);
    if (medio == null) continue;
    linhas.push({ produto: info.produto, unidade: info.unidade, preco: medio });
  }
  return linhas;
}

async function run() {
  const { buf, dataReferencia } = await buscarPdfMaisRecente();
  const linhas = await extrairPrecos(buf);
  console.log(`${linhas.length} produto(s) extraído(s).`);

  const rows = linhas.map((l) => ({
    produto: l.produto,
    uf: UF,
    nivel_comercializacao: "PRODUTOR",
    preco: l.preco,
    unidade: l.unidade,
    data_referencia: dataReferencia,
    fonte: FONTE,
  }));

  if (rows.length === 0) {
    console.log("Nenhuma linha extraída. Abortando sem gravar.");
    return;
  }

  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.produto}|${row.uf}|${row.data_referencia}`, row);
  const dedupedRows = [...byKey.values()];

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(dedupedRows, null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("precos")
    .upsert(dedupedRows, { onConflict: "produto,uf,regiao,data_referencia" });
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", dedupedRows.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
