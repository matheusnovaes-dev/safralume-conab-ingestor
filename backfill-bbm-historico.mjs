import { createClient } from "@supabase/supabase-js";

// Backfill do histórico da BBM: cada praça da página de cotações tem um "Histórico" (id numérico) que o
// próprio site carrega por AJAX (admin-ajax.php, liberado no robots.txt da BBM). A ação "Ano" devolve
// ~1 ano de preço diário daquela praça. Rodar uma vez (ou de novo para completar); é idempotente
// (upsert pela mesma chave do ingest-bbm.mjs). Uso: bun run backfill-bbm-historico.mjs [--gravar]
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRAVAR = process.argv.includes("--gravar") && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;
const supabase = GRAVAR ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PAGINA = "https://www.bbmbolsa.com.br/cotacoes-agricolas/";
const AJAX = "https://www.bbmbolsa.com.br/wp-admin/admin-ajax.php";

// Mesmos painéis e produtos do ingest-bbm.mjs (manter os dois em sincronia).
const PRODUTOS = {
  7: { produto: "MILHO EM GRÃOS (60 kg)", unidade: "60 kg" },
  8: { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg" },
  3: { produto: "CAFÉ ARÁBICA TIPO 6, BEBIDA DURA (60 kg)", unidade: "60 kg" },
  5: { produto: "CAFÉ CONILLON TIPO 8 (60 kg)", unidade: "60 kg" },
  4: { produto: "FEIJÃO CARIOCA EXTRA (60 kg)", unidade: "60 kg" },
  9: { produto: "TRIGO (BBM) (60 kg)", unidade: "60 kg", fator: 0.06 },
  2: { produto: "ARROZ EM CASCA LONGO FINO TIPO 1 (50 kg)", unidade: "50 kg" },
};
const UF_POR_ESTADO = {
  Bahia: "BA", "Espírito Santo": "ES", Goiás: "GO", "Mato Grosso": "MT", "Mato Grosso do Sul": "MS",
  "Minas Gerais": "MG", Paraná: "PR", "Rio Grande do Sul": "RS", "Santa Catarina": "SC", "São Paulo": "SP",
};

const UF_DA_PRACA = { "E.S. do Pinhal": "SP" }; // a BBM lista no bloco de MG, mas o município é de SP
const norm = (s) => s.trim().replace(/\s+/g, " ");
const numero = (s) => {
  const n = Number(s.replace(/^R\$\s*/, "").replace(/\./g, "").replace(",", ".").trim());
  return Number.isNaN(n) ? null : n;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function painel(html, tabId) {
  const i = html.indexOf(`id="cotacao_home_${tabId}">`);
  if (i === -1) return null;
  const j = html.indexOf('id="cotacao_home_', i + 10);
  return html.slice(i, j === -1 ? i + 60000 : j);
}

const BLOCO_ESTADO_RE = /back-groun-azul">[\s\S]*?b-grupo-1">\s*([^<]+?)\s*<\/div>[\s\S]*?vc_list">([\s\S]*?)<\/ul>/g;
const LINHA_RE =
  /c-grupo-1">\s*([^<]+?)\s*<\/div>[\s\S]*?c-grupo-2">\s*([^<]+?)\s*<\/div>[\s\S]*?id="(\d+)"\s+class="various"/;
const LINHA_HIST_RE =
  /nome-cota1">\s*([^<]*?)\s*<\/div>\s*<div[^>]*nome-cota">\s*([^<]*?)\s*<\/div>\s*<div[^>]*nome-cota[^"]*">\s*([^<]*?)\s*<\/div>\s*<div[^>]*data">\s*([^<]*?)\s*<\/div>/g;

async function main() {
  const html = await (await fetch(PAGINA, { headers: { "User-Agent": UA } })).text();
  const pracas = [];
  for (const [tabId, mapeado] of Object.entries(PRODUTOS)) {
    const p = painel(html, tabId);
    if (!p) { console.log(`aviso: painel ${tabId} não encontrado`); continue; }
    for (const [, estadoBruto, lista] of p.matchAll(BLOCO_ESTADO_RE)) {
      const uf = UF_POR_ESTADO[estadoBruto.trim()];
      if (!uf) continue;
      for (const li of lista.split("<li>").slice(1)) {
        const m = li.match(LINHA_RE);
        if (m) pracas.push({ id: m[3], praca: norm(m[1]), uf: UF_DA_PRACA[norm(m[1])] ?? uf, mapeado });
      }
    }
  }
  console.log(`${pracas.length} praças com histórico para buscar.`);

  const rows = [];
  let n = 0;
  for (const pr of pracas) {
    n++;
    let h;
    try {
      const res = await fetch(AJAX, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "getAjaxCotacoesHistoricoAno", id: pr.id }),
      });
      if (!res.ok) { console.log(`  [${n}/${pracas.length}] ${pr.mapeado.produto} ${pr.uf} ${pr.praca}: HTTP ${res.status}, pulando`); await dormir(800); continue; }
      h = await res.text();
    } catch (e) { console.log(`  [${n}] erro ${e.message}`); continue; }

    let q = 0;
    for (const [, , precoBruto, , dataBr] of h.matchAll(LINHA_HIST_RE)) {
      const [, dd, mm, aaaa] = dataBr.match(/(\d{2})\/(\d{2})\/(\d{4})/) ?? [];
      const preco = numero(precoBruto);
      if (!aaaa || preco == null || preco <= 0) continue;
      rows.push({
        produto: pr.mapeado.produto,
        uf: pr.uf,
        regiao: pr.praca,
        nivel_comercializacao: "PRODUTOR",
        preco: pr.mapeado.fator ? Math.round(preco * pr.mapeado.fator * 100) / 100 : preco,
        unidade: pr.mapeado.unidade,
        data_referencia: `${aaaa}-${mm}-${dd}`,
        fonte: "BBM",
      });
      q++;
    }
    console.log(`  [${n}/${pracas.length}] ${pr.mapeado.produto} | ${pr.uf} | ${pr.praca}: ${q} dias`);
    await dormir(700);
  }

  const porChave = new Map();
  for (const r of rows) porChave.set(`${r.produto}|${r.uf}|${r.regiao}|${r.data_referencia}`, r);
  const unicas = [...porChave.values()];
  const datas = unicas.map((r) => r.data_referencia).sort();
  console.log(`\n${unicas.length} linhas únicas; de ${datas[0]} a ${datas.at(-1)}.`);
  if (!GRAVAR) { console.log("DRY RUN (use --gravar com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY)."); return; }

  for (let i = 0; i < unicas.length; i += 500) {
    const { error } = await supabase.from("precos").upsert(unicas.slice(i, i + 500), { onConflict: "produto,uf,regiao,data_referencia" });
    if (error) { console.error("Erro ao gravar:", error); process.exit(1); }
  }
  console.log("OK. Linhas gravadas:", unicas.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
