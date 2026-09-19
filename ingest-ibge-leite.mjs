import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const ANOS = 6; // histórico suficiente pra mostrar a variação de preço entre anos

// SIDRA/IBGE, Pesquisa da Pecuária Municipal (anual). Parâmetros conferidos
// direto na API antes de escrever isso:
//  - tabela 74, variável 106 (produção, mil litros) e 215 (valor, mil reais),
//    classificação 80 categoria 2682 = leite;
//  - tabela 94, variável 107 = vacas ordenhadas (cabeças).
const URL_LEITE = `https://apisidra.ibge.gov.br/values/t/74/n3/all/v/106,215/p/last%20${ANOS}/c80/2682`;
const URL_VACAS = `https://apisidra.ibge.gov.br/values/t/94/n3/all/v/107/p/last%20${ANOS}`;

const NOME_PARA_UF = {
  Rondônia: "RO", Acre: "AC", Amazonas: "AM", Roraima: "RR", Pará: "PA", Amapá: "AP",
  Tocantins: "TO", Maranhão: "MA", Piauí: "PI", Ceará: "CE", "Rio Grande do Norte": "RN",
  Paraíba: "PB", Pernambuco: "PE", Alagoas: "AL", Sergipe: "SE", Bahia: "BA",
  "Minas Gerais": "MG", "Espírito Santo": "ES", "Rio de Janeiro": "RJ", "São Paulo": "SP",
  Paraná: "PR", "Santa Catarina": "SC", "Rio Grande do Sul": "RS", "Mato Grosso do Sul": "MS",
  "Mato Grosso": "MT", Goiás: "GO", "Distrito Federal": "DF",
};

function numeroOuNull(v) {
  if (v == null || v === "-" || v === "..." || v === "X" || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function buscarSidra(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`SIDRA retornou ${res.status} em ${url}`);
  const dados = await res.json();
  if (!Array.isArray(dados) || dados.length < 2) throw new Error(`SIDRA sem dados em ${url}`);
  return dados.slice(1); // a primeira linha é o cabeçalho
}

async function run() {
  const [leite, vacas] = await Promise.all([buscarSidra(URL_LEITE), buscarSidra(URL_VACAS)]);

  // chave "ano|UF" -> linha acumulando os campos
  const porChave = new Map();
  const linha = (ano, uf) => {
    const chave = `${ano}|${uf}`;
    if (!porChave.has(chave)) {
      porChave.set(chave, {
        ano: Number(ano),
        uf,
        producao_mil_litros: null,
        valor_mil_reais: null,
        vacas_ordenhadas: null,
        fonte: "IBGE/PPM",
        updated_at: new Date().toISOString(),
      });
    }
    return porChave.get(chave);
  };

  for (const r of leite) {
    const uf = NOME_PARA_UF[r.D1N];
    if (!uf) {
      console.log(`  ! Estado não mapeado: "${r.D1N}"`);
      continue;
    }
    const alvo = linha(r.D3N, uf);
    if (r.D2C === "106") alvo.producao_mil_litros = numeroOuNull(r.V);
    else if (r.D2C === "215") alvo.valor_mil_reais = numeroOuNull(r.V);
  }
  for (const r of vacas) {
    const uf = NOME_PARA_UF[r.D1N];
    if (!uf) continue;
    linha(r.D3N, uf).vacas_ordenhadas = numeroOuNull(r.V);
  }

  // Sem produção não há o que mostrar (e evita dividir por zero no preço médio).
  const rows = [...porChave.values()].filter(
    (r) => r.producao_mil_litros != null && r.producao_mil_litros > 0,
  );
  if (rows.length === 0) {
    console.log("Nenhuma linha com produção > 0. Abortando sem gravar.");
    process.exit(1);
  }

  const anos = [...new Set(rows.map((r) => r.ano))].sort();
  console.log(`${rows.length} linhas (UF×ano), anos ${anos.join(", ")}.`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(rows.filter((r) => r.uf === "MG").slice(-2), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const TAMANHO_LOTE = 200;
  for (let i = 0; i < rows.length; i += TAMANHO_LOTE) {
    const lote = rows.slice(i, i + TAMANHO_LOTE);
    const { error } = await supabase.from("leite_ibge").upsert(lote, { onConflict: "ano,uf" });
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
