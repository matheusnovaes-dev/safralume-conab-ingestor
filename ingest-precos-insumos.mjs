import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Preço de defensivo (agrotóxico) e fertilizante por produto comercial e UF,
// achado 2026-09-30. Fonte: "Consulta de Preços de Insumos" da Conab —
// sistemas.conab.gov.br/consulta-precos-insumos, um app Angular cujo bundle
// (main-*.js) expõe a apiUrl direto: barramento.conab.gov.br/consulta-precos-
// insumos-rs/api/consulta/insumos. É uma API REST pública de verdade (GET
// puro, sem chave, sem captcha — confirmado com curl puro), NÃO um scraping
// de HTML nem um PDF. Confirmado: omitir o parâmetro "uf" já devolve todas
// as UFs numa chamada só, então o loop é só por grupo x subgrupo (9 no
// total), não por UF.
const API_BASE = "https://barramento.conab.gov.br/consulta-precos-insumos-rs/api/consulta/insumos";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// IMPLEMENTO/MÁQUINAS-MOTORES/MATERIAL PROPAGATIVO existem no sistema mas
// ficam de fora de propósito — bem custo de capital/semente, pergunta
// diferente de "quanto tá custando o insumo que eu recompro toda safra".
const SUBGRUPOS = [
  { idGrupo: 9, idSubgrupo: 28, grupo: "AGROTÓXICO", subgrupo: "ACARICIDA" },
  { idGrupo: 9, idSubgrupo: 29, grupo: "AGROTÓXICO", subgrupo: "ESPALHANTE / ADJUVANTE" },
  { idGrupo: 9, idSubgrupo: 35, grupo: "AGROTÓXICO", subgrupo: "ESTIMULANTE/REGULADOR DE CRESCIMENTO" },
  { idGrupo: 9, idSubgrupo: 30, grupo: "AGROTÓXICO", subgrupo: "FUNGICIDA" },
  { idGrupo: 9, idSubgrupo: 31, grupo: "AGROTÓXICO", subgrupo: "HERBICIDA" },
  { idGrupo: 9, idSubgrupo: 33, grupo: "AGROTÓXICO", subgrupo: "INSETICIDA" },
  { idGrupo: 27, idSubgrupo: 32, grupo: "FERTILIZANTE", subgrupo: "INOCULANTE" },
  { idGrupo: 27, idSubgrupo: 70, grupo: "FERTILIZANTE", subgrupo: "ORGÂNICO" },
  { idGrupo: 27, idSubgrupo: 71, grupo: "FERTILIZANTE", subgrupo: "QUÍMICO" },
];

const MESES = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// Publicação é bimestral (a própria Conab confirma: sempre nos meses
// ímpares) — pegar o ano corrente inteiro mais o anterior garante que a
// gente sempre tenha pelo menos uma publicação recente, mesmo logo no
// início de um ano novo antes da primeira rodada bimestral sair.
const anoAtual = new Date().getUTCFullYear();
const ANO_INICIAL = anoAtual - 1;
const ANO_FINAL = anoAtual;

async function buscarSubgrupo({ idGrupo, idSubgrupo, grupo, subgrupo }) {
  const url = `${API_BASE}/consultar?anoInicial=${ANO_INICIAL}&anoFinal=${ANO_FINAL}&idGrupo=${idGrupo}&idSubgrupo=${idSubgrupo}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} pra ${grupo}/${subgrupo}`);
  const linhasWide = await res.json();

  const linhas = [];
  for (const w of linhasWide) {
    // Nome do produto às vezes vem com espaços sobrando nas pontas (achado
    // real: "  KCL" com espaços à esquerda) — normaliza antes de gravar,
    // senão a mesma marca vira duas linhas "diferentes" por causa de espaço.
    const produto = w.produto.replace(/\s+/g, " ").trim();
    for (let i = 0; i < 12; i++) {
      const preco = w[MESES[i]];
      if (preco == null) continue;
      linhas.push({
        produto_id: w.produtoId,
        produto,
        grupo,
        subgrupo,
        uf: w.uf,
        ano: w.ano,
        mes: i + 1,
        preco,
        unidade_medida: w.unidadeMedida,
        fonte: "Conab",
      });
    }
  }
  return linhas;
}

async function run() {
  const todasAsLinhas = [];
  for (const s of SUBGRUPOS) {
    const linhas = await buscarSubgrupo(s);
    console.log(`${s.grupo}/${s.subgrupo}: ${linhas.length} linhas (produto x uf x mês).`);
    todasAsLinhas.push(...linhas);
  }

  console.log(`Total: ${todasAsLinhas.length} linhas.`);

  // Achado ao vivo: o mesmo produtoId às vezes é cotado sob DUAS
  // unidadeComercializacaoFk diferentes no mesmo mês/UF (ex: "05-20-20" no
  // RS em mar/2025 saiu como R$130,93 por saco de 50kg E R$2.662,17 por
  // tonelada — preços de verdade, unidades diferentes, não é erro/duplicata
  // — por isso unidade_medida entra na chave única). Ainda assim dedupa
  // defensivamente pela MESMA chave do upsert, senão um upsert com duas
  // linhas de chave igual falha inteiro ("cannot affect row a second time").
  const porChave = new Map();
  for (const linha of todasAsLinhas) {
    porChave.set(`${linha.produto_id}|${linha.uf}|${linha.ano}|${linha.mes}|${linha.unidade_medida}`, linha);
  }
  const linhasFinais = [...porChave.values()];
  if (linhasFinais.length !== todasAsLinhas.length) {
    console.log(`${todasAsLinhas.length - linhasFinais.length} linha(s) duplicada(s) removida(s).`);
  }

  if (linhasFinais.length === 0) {
    console.log("Nada pra gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(linhasFinais.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const LOTE = 1000;
  for (let i = 0; i < linhasFinais.length; i += LOTE) {
    const lote = linhasFinais.slice(i, i + LOTE);
    const { error } = await supabase
      .from("precos_insumos_conab")
      .upsert(lote, { onConflict: "produto_id,uf,ano,mes,unidade_medida" });
    if (error) {
      console.error("Erro ao gravar lote:", error);
      process.exit(1);
    }
    console.log(`  gravado lote ${i}-${i + lote.length} (${i + lote.length}/${linhasFinais.length})`);
  }
  console.log("OK. Linhas gravadas:", linhasFinais.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
