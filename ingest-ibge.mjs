import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
// Tabela 6588 (LSPA/IBGE): série histórica mensal, com todas as 44 lavouras
// individuais (não os grupos-cabeçalho, tipo "1 Cereais..." ou "9/10 Café
// total" — esses somam os filhos, incluir os dois juntos duplicaria a
// produção). IDs conferidos direto na API de metadados antes de escrever
// isso, não foram inventados.
const AGREGADO = 6588;
const VARIAVEIS = "109,216,35,36"; // área plantada, área colhida, produção, rendimento médio
const PRODUTOS = [
  39429, 39430, 39431, 39432, 39433, 82223, 39434, 39435, 39436, 39437, 39438, 82224, 39439, 39440,
  39441, 39442, 39443, 39444, 39445, 39446, 39447, 39448, 39449, 39450, 39451, 39452, 39453, 39454,
  39455, 39456, 39457, 39458, 39459, 39460, 39461, 39462, 39463, 39464, 39465, 39467, 39468, 39469,
  39470, 39471,
].join(",");

const VAR_ID_PARA_CAMPO = {
  109: "area_plantada_ha",
  216: "area_colhida_ha",
  35: "producao_ton",
  36: "rendimento_kg_ha",
};

function limparNomeProduto(nome) {
  // "1.1 Algodão herbáceo" -> "Algodão herbáceo" / "11 Cana-de-açúcar" -> "Cana-de-açúcar"
  return nome.replace(/^\d+(\.\d+)?\s+/, "").trim();
}

function numeroOuNull(v) {
  if (v == null || v === "-" || v === "..." || v === "X") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function buscarPeriodoMaisRecente() {
  const res = await fetch(`https://servicodados.ibge.gov.br/api/v3/agregados/${AGREGADO}/periodos`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Períodos retornou ${res.status}`);
  const periodos = await res.json();
  return periodos[periodos.length - 1].id; // ex: "202607"
}

async function run() {
  const periodoId = await buscarPeriodoMaisRecente();
  const periodoISO = `${periodoId.slice(0, 4)}-${periodoId.slice(4, 6)}-01`;
  console.log("Período mais recente do IBGE/LSPA:", periodoId, "->", periodoISO);

  const url =
    `https://servicodados.ibge.gov.br/api/v3/agregados/${AGREGADO}/periodos/${periodoId}` +
    `/variaveis/${VARIAVEIS}?localidades=N3[all]&classificacao=48[${PRODUTOS}]`;

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Dados retornou ${res.status}`);
  const variaveis = await res.json();

  // chave "UF|produto" -> linha acumulando os 4 campos
  const porChave = new Map();

  for (const v of variaveis) {
    const campo = VAR_ID_PARA_CAMPO[v.id];
    if (!campo) continue;
    for (const resultado of v.resultados) {
      const nomeProduto = limparNomeProduto(Object.values(resultado.classificacoes[0].categoria)[0]);
      for (const serie of resultado.series) {
        const uf = serie.localidade.nome;
        const valor = numeroOuNull(serie.serie[periodoId]);
        const chave = `${uf}|${nomeProduto}`;
        if (!porChave.has(chave)) {
          porChave.set(chave, {
            periodo: periodoISO,
            uf,
            produto: nomeProduto,
            area_plantada_ha: null,
            area_colhida_ha: null,
            producao_ton: null,
            rendimento_kg_ha: null,
            fonte: "IBGE/LSPA",
          });
        }
        porChave.get(chave)[campo] = valor;
      }
    }
  }

  // só grava linha se tiver produção real (evita lotar a tabela com
  // "UF não planta essa cultura", que é a maioria das combinações)
  const rows = [...porChave.values()].filter((r) => r.producao_ton != null && r.producao_ton > 0);

  if (rows.length === 0) {
    console.log("Nenhuma linha com produção > 0. Abortando sem gravar.");
    return;
  }

  console.log(`${rows.length} linhas com produção real (de ${porChave.size} combinações UF×produto).`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  // upsert em lotes — Supabase/PostgREST tem limite de tamanho de payload,
  // e um lote grande demais falha silenciosamente em alguns planos.
  const TAMANHO_LOTE = 200;
  for (let i = 0; i < rows.length; i += TAMANHO_LOTE) {
    const lote = rows.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase.from("ibge_producao").upsert(lote, { onConflict: "periodo,uf,produto" });
    if (error) {
      console.error(`Erro ao gravar lote ${i}-${i + lote.length}:`, error);
      process.exit(1);
    }
  }
  console.log("OK. Linhas gravadas:", rows.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
