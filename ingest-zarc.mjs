import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// A Tábua de Risco do ZARC (MAPA) é publicada uma vez por safra, cobrindo
// TODO município do Brasil, com o risco climático de plantio em cada um dos
// 36 decêndios do ano (3 por mês) — dado oficial, não estimativa nossa.
// Só cobre cultura ANUAL (decisão de plantio a cada safra); café e cana são
// perenes e não aparecem aqui — achado real 2026-09-10, verificado direto
// no arquivo (17 culturas no total, nenhuma delas café/cana/trigo).
const URL_CSV =
  "https://dados.agricultura.gov.br/dataset/6d3d141c-885e-41a4-ab7f-dc8ff323b96f/resource/139e5a60-1f43-4cc8-aeab-a35dbbf816c0/download/dados-abertos-tabua-de-risco-safra-2026-2027.csv";

// Nome oficial do ZARC -> palavra-chave que o resto do sistema já usa
// (mesma convenção de buscar_preco). Só as 5 culturas anuais que o ZARC
// cobre E que já rastreamos — exclui variantes de consórcio/Caupi de
// propósito, pra não confundir "posso plantar hoje" com uma variedade de
// nicho que a maioria dos produtores não usa.
const CULTURA_ZARC_PARA_NOSSA = {
  Soja: "SOJA",
  "Milho 1ª Safra": "MILHO",
  "Milho 2ª Safra": "MILHO",
  "Algodão Herbáceo": "ALGODÃO",
  Arroz: "ARROZ",
  Feijão: "FEIJÃO",
  "Feijão 2ª Safra": "FEIJÃO",
};

function parseLinhaCsv(linha) {
  return linha.split(";");
}

async function run() {
  console.log("Baixando Tábua de Risco do ZARC (arquivo grande, ~210MB)...");
  const res = await fetch(URL_CSV, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`Download falhou: HTTP ${res.status}`);
  }
  const texto = await res.text();
  const linhas = texto.split("\n");
  console.log(`${linhas.length} linhas no CSV (incluindo cabeçalho).`);

  const rows = [];
  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || linha.length < 10) continue;
    const c = parseLinhaCsv(linha);
    const nomeCulturaZarc = c[0]?.replace(/^﻿/, "");
    const cultura = CULTURA_ZARC_PARA_NOSSA[nomeCulturaZarc];
    if (!cultura) continue;

    const riscos = c.slice(19, 55).map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    });
    if (riscos.length !== 36) continue;

    rows.push({
      cultura,
      nome_cultura_zarc: nomeCulturaZarc,
      uf: c[7],
      municipio: c[8],
      geocodigo: c[6],
      cod_ciclo: c[4] || null,
      cod_solo: c[5] || null,
      portaria: c[18] || null,
      safra_ini: Number(c[1]),
      safra_fim: Number(c[2]),
      riscos_decendio: riscos,
    });
  }

  console.log(`${rows.length} linhas relevantes (das nossas 5 culturas anuais).`);

  // Dedupe pela mesma chave do upsert — mesmo bug real já achado no
  // ingest-b3-futuros.mjs: o Postgres rejeita um upsert que tenta afetar a
  // mesma linha (aqui: cultura+geocodigo+cod_ciclo+cod_solo+safra_ini) duas
  // vezes no mesmo comando. O CSV oficial tem algumas linhas duplicadas
  // nessa chave (mesmo município/cultura/cultivar/solo aparecendo mais de
  // uma vez) — fica com a última ocorrência.
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.cultura}|${row.geocodigo}|${row.cod_ciclo}|${row.cod_solo}|${row.safra_ini}`, row);
  }
  const dedupedRows = [...byKey.values()];
  if (dedupedRows.length !== rows.length) {
    console.log(
      `${rows.length - dedupedRows.length} linha(s) duplicada(s) removida(s) (${dedupedRows.length} restantes).`,
    );
  }

  if (dedupedRows.length === 0) {
    console.log("Nenhuma linha relevante. Abortando sem gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(dedupedRows.slice(0, 3), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const TAMANHO_LOTE = 1000;
  let gravadas = 0;
  for (let i = 0; i < dedupedRows.length; i += TAMANHO_LOTE) {
    const lote = dedupedRows.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase
      .from("zarc_janelas_plantio")
      .upsert(lote, { onConflict: "cultura,geocodigo,cod_ciclo,cod_solo,safra_ini" });
    if (error) {
      console.error(`Erro no lote ${i}-${i + lote.length}:`, error);
      process.exit(1);
    }
    gravadas += lote.length;
    if (gravadas % 20000 === 0) console.log(`${gravadas}/${dedupedRows.length} gravadas...`);
  }
  console.log("OK. Linhas gravadas:", gravadas);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
