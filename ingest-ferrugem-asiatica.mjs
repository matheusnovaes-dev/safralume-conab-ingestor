import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Ocorrências de ferrugem asiática da soja por município, achado 2026-09-30.
// Fonte: Consórcio Antiferrugem (consorcioantiferrugem.net) — rede
// pública-privada de monitoramento, API REST pública de verdade (achada
// lendo o bundle AngularJS do site: endpoints /rest/safras e
// /rest/ocorrencias/safra/:id, sem chave nem autenticação — confirmado com
// curl puro). NÃO cobre pragas/doenças em geral, só ferrugem asiática —
// mas é a doença de maior impacto econômico na soja (até 30% de perda),
// com rede de monitoramento oficial nacional de verdade, o que a maioria
// das outras pragas não tem.
const API_BASE = "http://www.consorcioantiferrugem.net";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// tipo: 1=ocorrência confirmada, 3=ferrugem em soja voluntária (fora da
// safra), 4=presença de esporos (alerta precoce), 5=unidade de alerta
// (estação de monitoramento, não é detecção) — legenda achada lendo o
// template do popup do mapa no bundle, não documentação oficial escrita,
// mas o texto é literal e inequívoco.
const TIPOS_VALIDOS = new Set([1, 3, 4, 5]);

// Só as safras "de verdade" (formato AAAA/AAAA) — a API também lista
// "vazio sanitário AAAA" (período obrigatório sem soja, sempre zero
// ocorrência por definição) com um id próprio; ignora essas.
function ehSafraDeCultivo(nomeSafra) {
  return /^\d{4}\/\d{4}$/.test(nomeSafra);
}

async function buscarSafras() {
  const res = await fetch(`${API_BASE}/rest/safras?size=100`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} buscando safras`);
  const json = await res.json();
  return json.data.filter((s) => ehSafraDeCultivo(s.safra));
}

async function buscarOcorrenciasDaSafra(safraId) {
  const res = await fetch(`${API_BASE}/rest/ocorrencias/safra/${safraId}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} buscando ocorrências da safra ${safraId}`);
  const json = await res.json();
  return json.data;
}

async function run() {
  const safras = await buscarSafras();
  console.log(`${safras.length} safras de cultivo encontradas.`);

  const linhas = [];
  for (const safra of safras) {
    const estados = await buscarOcorrenciasDaSafra(safra.id);
    // Dedup por (municipio_ibge, tipo): a API repete "qtd" (já é o total do
    // município+tipo na safra) numa sub-linha por ponto de coleta/fonte —
    // somar de novo contaria em dobro. Confirmado comparando manualmente:
    // "qtd" bate exatamente com o número de sub-linhas daquele tipo.
    const vistos = new Set();
    for (const estado of estados) {
      for (const ocorrencia of estado.ocorrencias) {
        if (!TIPOS_VALIDOS.has(ocorrencia.tipo)) continue;
        const chave = `${ocorrencia.id}|${ocorrencia.tipo}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        linhas.push({
          safra_id: safra.id,
          safra: safra.safra,
          uf: estado.sigla,
          municipio_ibge: ocorrencia.id,
          municipio_nome: ocorrencia.nome,
          tipo: ocorrencia.tipo,
          quantidade: ocorrencia.qtd,
          latitude: ocorrencia.clatitude ?? ocorrencia.latitude,
          longitude: ocorrencia.clongitude ?? ocorrencia.longitude,
        });
      }
    }
    console.log(`  safra ${safra.safra} (id ${safra.id}): ${estados.length} UFs, ${linhas.length} linhas acumuladas.`);
  }

  console.log(`Total: ${linhas.length} linhas.`);

  if (linhas.length === 0) {
    console.log("Nada pra gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(linhas.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const LOTE = 1000;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const { error } = await supabase
      .from("ferrugem_asiatica_ocorrencias")
      .upsert(lote, { onConflict: "safra_id,municipio_ibge,tipo" });
    if (error) {
      console.error("Erro ao gravar lote:", error);
      process.exit(1);
    }
    console.log(`  gravado lote ${i}-${i + lote.length} (${i + lote.length}/${linhas.length})`);
  }
  console.log("OK. Linhas gravadas:", linhas.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
