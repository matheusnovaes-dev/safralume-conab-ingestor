import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Arquivo público do Portal de Informações da Conab (área Logística) — sem
// autenticação, sem scraping: é um .txt direto. Confirmado com a Conab (via
// o próprio Boletim Logístico) que cobre frete de grãos (soja e milho) nos
// principais estados produtores — o arquivo em si não separa por cultura
// (não tem essa coluna), por isso grava a mesma rota sob as duas.
const URL_FRETE_CONAB = "https://portaldeinformacoes.conab.gov.br/downloads/arquivos/Frete.txt";
const CULTURAS = ["soja", "milho"];

// A Conab publica em Latin-1 (ISO-8859-1), não UTF-8 — sem essa conversão
// "AÇAILÂNDIA" vira "A�AIL�NDIA" no banco.
async function baixarTextoLatin1(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buffer);
}

function parseNumeroBR(s) {
  return parseFloat((s ?? "").trim().replace(/\./g, "").replace(",", "."));
}

const CONECTORES_MINUSCULOS = new Set(["de", "do", "da", "dos", "das", "e"]);

// A Conab manda "AÇAILÂNDIA-MA" (tudo maiúsculo + sufixo de UF redundante,
// já que uf_origem/uf_destino já vêm em colunas próprias) — normaliza pro
// mesmo padrão "Título" que a Sifreca já usa (ex: "Araras", "Paranaguá").
function normalizarMunicipio(bruto, uf) {
  const semSufixoUf = bruto.replace(new RegExp(`-${uf}$`), "");
  return semSufixoUf
    .toLowerCase()
    .split(" ")
    .map((palavra, i) =>
      i > 0 && CONECTORES_MINUSCULOS.has(palavra) ? palavra : palavra.charAt(0).toUpperCase() + palavra.slice(1),
    )
    .join(" ");
}

async function coletar() {
  console.log("Baixando frete da Conab...");
  const texto = await baixarTextoLatin1(URL_FRETE_CONAB);
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = linhas[0].split(";").map((c) => c.trim());
  console.log(`Colunas: ${header.join(", ")}`);

  const idx = {
    municipioOrigem: header.indexOf("municipio_origem"),
    ufOrigem: header.indexOf("uf_origem"),
    municipioDestino: header.indexOf("municipio_destino"),
    ufDestino: header.indexOf("uf_destino"),
    ano: header.indexOf("ano"),
    mes: header.indexOf("mes"),
    valorFreteTonelada: header.indexOf("valor_frete_tonelada"),
    valorToneladaKm: header.indexOf("valor_tonelada_km"),
  };

  // Uma rota tem várias linhas (uma por mês/ano) — fica só com a mais
  // recente de cada, igual o padrão de "cotação atual" já usado pros
  // outros ingests (a tabela `fretes` guarda referência atual, não série
  // histórica completa).
  const maisRecentePorRota = new Map();
  for (const linha of linhas.slice(1)) {
    const cols = linha.split(";").map((c) => c.trim());
    const ufOrigem = cols[idx.ufOrigem];
    const ufDestino = cols[idx.ufDestino];
    const municipioOrigem = normalizarMunicipio(cols[idx.municipioOrigem], ufOrigem);
    const municipioDestino = normalizarMunicipio(cols[idx.municipioDestino], ufDestino);
    const ano = parseInt(cols[idx.ano], 10);
    const mes = parseInt(cols[idx.mes], 10);
    if (!municipioOrigem || !ufOrigem || Number.isNaN(ano) || Number.isNaN(mes)) continue;

    const freteRt = parseNumeroBR(cols[idx.valorFreteTonelada]);
    if (Number.isNaN(freteRt)) continue;

    const chave = `${municipioOrigem}|${ufOrigem}|${municipioDestino}`;
    const existente = maisRecentePorRota.get(chave);
    const chaveOrdenacao = ano * 100 + mes;
    if (!existente || chaveOrdenacao > existente.chaveOrdenacao) {
      const freteRtKm = parseNumeroBR(cols[idx.valorToneladaKm]);
      maisRecentePorRota.set(chave, {
        chaveOrdenacao,
        municipio_origem: municipioOrigem,
        uf_origem: ufOrigem,
        municipio_destino: municipioDestino,
        uf_destino: ufDestino,
        frete_rt: freteRt,
        frete_rt_km: Number.isNaN(freteRtKm) ? null : freteRtKm,
        fonte: "Conab/Boletim Logístico",
      });
    }
  }

  console.log(`${maisRecentePorRota.size} rotas únicas (mais recentes) encontradas.`);

  const rows = [];
  for (const rota of maisRecentePorRota.values()) {
    const { chaveOrdenacao, ...campos } = rota;
    for (const cultura of CULTURAS) {
      rows.push({ cultura, ...campos });
    }
  }
  return rows;
}

async function main() {
  const rows = await coletar();
  if (rows.length === 0) {
    console.log("Nenhuma rota coletada. Abortando sem gravar.");
    return;
  }

  console.log(`\n${rows.length} linhas prontas (rotas × culturas).`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  // Em lotes: 2000+ linhas de uma vez só num upsert costuma estourar limite
  // de tamanho de requisição do PostgREST.
  const TAMANHO_LOTE = 500;
  for (let i = 0; i < rows.length; i += TAMANHO_LOTE) {
    const lote = rows.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase
      .from("fretes")
      .upsert(lote, { onConflict: "cultura,uf_origem,municipio_origem,municipio_destino" });
    if (error) {
      console.error(`Erro ao gravar lote ${i / TAMANHO_LOTE + 1}:`, error);
      process.exit(1);
    }
    console.log(`Lote ${i / TAMANHO_LOTE + 1}: ${lote.length} linhas gravadas.`);
  }
  console.log("OK. Total gravado:", rows.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
