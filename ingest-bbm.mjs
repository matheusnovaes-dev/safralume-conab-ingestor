import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const FONTE = "BBM";
const URL_COTACOES = "https://www.bbmbolsa.com.br/cotacoes-agricolas/";

// Bolsa Brasileira de Mercadorias — cotações diárias por praça, cobrindo o
// centro-sul inteiro numa página só, sem login/token/bloqueio. Testado ao
// vivo: unidade confirmada como saca de 60kg pra soja e milho (mesma base
// já usada em toda cotação de saca dessas duas culturas no resto do
// banco — bate exatamente com o mesmo padrão de magnitude confirmado em
// DERAL/PR, EPAGRI/SC e IEA/SP). Só esses dois produtos por enquanto — a
// página tem café/algodão/arroz/feijão/trigo também, mas a unidade de
// cada um não foi confirmada com a mesma certeza ainda (fica pra uma
// próxima rodada).
const PRODUTOS = {
  7: { produto: "MILHO EM GRÃOS (60 kg)", unidade: "60 kg" },
  8: { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg" },
};

const UF_POR_ESTADO = {
  Bahia: "BA",
  "Espírito Santo": "ES",
  Goiás: "GO",
  "Mato Grosso": "MT",
  "Mato Grosso do Sul": "MS",
  "Minas Gerais": "MG",
  Paraná: "PR",
  "Rio Grande do Sul": "RS",
  "Santa Catarina": "SC",
  "São Paulo": "SP",
};

function numeroOuNull(s) {
  const limpo = s.replace(/^R\$\s*/, "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(limpo);
  return Number.isNaN(n) ? null : n;
}

function extrairPainel(html, tabId) {
  const inicio = html.indexOf(`id="cotacao_home_${tabId}">`);
  if (inicio === -1) return null;
  const proximo = html.indexOf('id="cotacao_home_', inicio + 10);
  return html.slice(inicio, proximo === -1 ? inicio + 60000 : proximo);
}

const BLOCO_ESTADO_RE =
  /back-groun-azul">[\s\S]*?b-grupo-1">\s*([^<]+?)\s*<\/div>[\s\S]*?vc_list">([\s\S]*?)<\/ul>/g;
const LINHA_PRACA_RE = /c-grupo-1">\s*([^<]+?)\s*<\/div>[\s\S]*?c-grupo-2">\s*([^<]+?)\s*<\/div>/g;

async function run() {
  const res = await fetch(URL_COTACOES, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Falha ao abrir a página: HTTP ${res.status}`);
  const html = await res.text();

  const dataMatch = html.match(/Atualização das Cotações - (\d{2})\/(\d{2})\/(\d{4})/);
  if (!dataMatch) throw new Error("Não encontrei a data de atualização na página.");
  const dataReferencia = `${dataMatch[3]}-${dataMatch[2]}-${dataMatch[1]}`;
  console.log(`Data de referência da página: ${dataReferencia}`);

  const rows = [];
  for (const [tabId, mapeado] of Object.entries(PRODUTOS)) {
    const painel = extrairPainel(html, tabId);
    if (!painel) {
      console.log(`  aviso: painel do produto (tab ${tabId}) não encontrado, pulando.`);
      continue;
    }
    let coletadasNoPainel = 0;
    for (const blocoMatch of painel.matchAll(BLOCO_ESTADO_RE)) {
      const [, estadoBruto, conteudoLista] = blocoMatch;
      const estado = estadoBruto.trim();
      const uf = UF_POR_ESTADO[estado];
      if (!uf) {
        console.log(`  aviso: estado "${estado}" não mapeado, pulando essas linhas.`);
        continue;
      }
      for (const linhaMatch of conteudoLista.matchAll(LINHA_PRACA_RE)) {
        const [, pracaBruta, precoBruto] = linhaMatch;
        const preco = numeroOuNull(precoBruto);
        if (preco == null || preco <= 0) continue;
        rows.push({
          produto: mapeado.produto,
          uf,
          regiao: pracaBruta.trim().replace(/\s+/g, " "),
          nivel_comercializacao: "PRODUTOR",
          preco,
          unidade: mapeado.unidade,
          data_referencia: dataReferencia,
          fonte: FONTE,
        });
        coletadasNoPainel++;
      }
    }
    console.log(`  ${mapeado.produto}: ${coletadasNoPainel} linha(s).`);
  }
  console.log(`${rows.length} linha(s) coletada(s) no total.`);

  if (rows.length === 0) {
    console.log("Nenhuma linha extraída. Abortando sem gravar.");
    return;
  }

  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.produto}|${row.uf}|${row.regiao}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];
  if (dedupedRows.length !== rows.length) {
    console.log(`${rows.length - dedupedRows.length} linha(s) duplicada(s) removida(s).`);
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra de 5 linhas:");
    console.log(JSON.stringify(dedupedRows.slice(0, 5), null, 2));
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
