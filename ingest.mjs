import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Runs diárias pedem só uma janela curta (pega a semana corrente + alguma
// margem pra revisão tardia da Conab). Um backfill único usa um valor bem
// maior via workflow_dispatch, sem mudar o padrão do cron.
const DIAS_HISTORICO = parseInt(process.env.DIAS_HISTORICO ?? "40", 10);

const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log(
    "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).",
  );
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Todos os 77 produtos oferecidos pela Conab (código interno -> nome vem na
// própria resposta da API, não precisamos mapear aqui).
const PRODUTOS = [
  465, 929, 15, 17, 647, 2190, 1913, 24, 19, 932, 2538, 469, 1667, 735, 2007, 226, 323, 1634, 937,
  2692, 2424, 489, 3749, 3750, 240, 490, 737, 248, 251, 1014, 491, 943, 1, 2, 648, 1356, 650, 12,
  11, 329, 20, 222, 739, 2191, 13, 474, 583, 576, 476, 2381, 14, 27, 478, 818, 479, 233, 22, 2565,
  1322, 2566, 1170, 246, 1325, 38, 1089, 992, 660, 740, 453, 29, 23, 232, 486, 487, 21, 1493, 488,
].map(String);

// Todas as 27 UFs (26 estados + DF).
const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
  "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

// Só nível Produtor: é o que o dashboard usa (preço na porteira), e manter
// um nível só evita colidir com a chave única atual da tabela
// (produto, uf, data_referencia — sem nivel_comercializacao).
const NIVEL_PRODUTOR = "5";

const PAGE_SIZE = 5000;

function formatPeriodo(diasAtras) {
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - diasAtras);
  const fmt = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${fmt(inicio)} até ${fmt(fim)}`;
}

function parsePeriodoEndDate(periodo) {
  // "27/07/26 a 31/07/26" -> end date as ISO
  const match = periodo.match(/a\s+(\d{2})\/(\d{2})\/(\d{2})/);
  if (!match) return null;
  const [, dd, mm, yy] = match;
  return `20${yy}-${mm}-${dd}`;
}

function parseValor(valor) {
  return parseFloat(valor.trim().replace(/\./g, "").replace(",", "."));
}

// "SOJA EM GRÃOS   (60 kg)" -> { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg" }
// Importante: a unidade fica DENTRO de `produto` (não é removida) — vários
// produtos existem em mais de uma unidade ao mesmo tempo (ex: "ALHO COMUM
// (10 kg)" e "ALHO COMUM (kg)" são séries diferentes). Tirar a unidade do
// nome faria as duas colidirem na chave única (produto, uf, data_referencia)
// e uma sobrescreveria a outra. `unidade` aqui é só uma cópia pra exibição.
function splitProdutoUnidade(nomeProduto) {
  const limpo = nomeProduto.trim().replace(/\s+/g, " ");
  const match = limpo.match(/\(([^)]+)\)\s*$/);
  return { produto: limpo, unidade: match ? match[1].trim() : null };
}

async function bootstrap(page) {
  console.log("Loading Conab price query tool...");
  await page.goto("https://consultaprecosdemercado.conab.gov.br/#/home", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("#range-input", { timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.locator("#range-input").click();
  await page.waitForTimeout(500);
  const days = page.locator(".flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)");
  await days.nth(0).click();
  await page.waitForTimeout(300);
  await days.nth(17).click();
  await page.waitForTimeout(500);

  const pesquisarBtn = page.locator('button:has-text("Pesquisar")');
  await pesquisarBtn.click();
  await page.waitForTimeout(1500);

  const produtoField = page.locator('.br-select:has-text("Produto")').first();
  if ((await produtoField.count()) === 0) {
    await page.screenshot({ path: "failure.png", fullPage: true });
    throw new Error("Campo 'Produto' não apareceu após Pesquisar.");
  }
  await produtoField.click();
  await page.waitForTimeout(400);
  await page.getByText("SOJA", { exact: true }).click();
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(600);

  await page.locator('.br-select:has-text("Nível de comercialização")').first().click();
  await page.waitForTimeout(400);
  await page.getByText("PRODUTOR", { exact: true }).click();
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(600);

  // O clique aqui só serve pra habilitar o botão "Consultar" — o filtro de
  // UF de verdade vem do array UFS, sobrescrito direto no corpo do POST em
  // fetchAllPages() (não depende do que foi marcado na tela). "Selecionar
  // Todos" fica sempre no topo da lista, então não quebra se a Conab mudar
  // a lista pra virtualizada/paginada (visto na prática: em algum momento a
  // lista passou a renderizar só 2-3 UFs por vez, e "GOIAS" específico
  // parou de estar sempre visível/clicável).
  await page.locator('.br-select:has-text("Unidade da federação")').first().click();
  await page.waitForTimeout(400);
  await page.locator('label[for="unidadeFederacao-all"]').click();
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(600);

  const reqPromise = page.waitForRequest(
    (r) => r.url().includes("/consulta/precos/consultar") && r.method() === "POST",
    { timeout: 15000 },
  );
  await page.locator('button:has-text("Consultar")').click();
  const req = await reqPromise;
  return { url: req.url(), body: JSON.parse(req.postData()) };
}

async function fetchAllPages(page, url, baseBody, periodo) {
  const rows = [];
  let start = 0;
  let count = Infinity;

  while (start < count) {
    const body = {
      ...baseBody,
      produto: PRODUTOS,
      nivelComercializacao: [NIVEL_PRODUTOR],
      unidadeFederacao: UFS,
      periodo,
      pageSize: PAGE_SIZE,
      start,
    };
    const res = await page.request.post(url, {
      headers: { "content-type": "application/json" },
      data: body,
      timeout: 60000,
    });
    if (!res.ok()) {
      throw new Error(`Conab respondeu ${res.status()} na página start=${start}`);
    }
    const json = await res.json();
    count = json.count ?? 0;
    rows.push(...(json.precos ?? []));
    console.log(`  página start=${start}: +${json.precos?.length ?? 0} linhas (total esperado: ${count})`);
    start += PAGE_SIZE;
  }

  return rows;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await run(page);
  } catch (err) {
    await page.screenshot({ path: "failure.png", fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

async function run(page) {
  const { url, body: baseBody } = await bootstrap(page);
  const periodo = formatPeriodo(DIAS_HISTORICO);
  console.log(`\nBuscando todos os produtos x todas as UFs (nível Produtor), período: ${periodo}`);

  const rawRows = await fetchAllPages(page, url, baseBody, periodo);
  console.log(`\n${rawRows.length} linhas brutas recebidas. Preenchendo grupos (a API "mescla" produto/nível/uf repetidos)...`);

  // A resposta só traz nomeProduto/nivel/uf na primeira linha de cada grupo
  // (produto+nível+uf) — as linhas seguintes do mesmo grupo, com período
  // diferente, vêm com esses campos null. Preciso herdar do último valor
  // visto, na ordem em que a API devolveu (inclusive entre páginas).
  let last = { nomeProduto: null, uf: null };
  const rows = [];
  for (const p of rawRows) {
    if (p.nomeProduto != null) last = { nomeProduto: p.nomeProduto, uf: p.uf };
    if (!last.nomeProduto || !last.uf) continue;

    const dataRef = parsePeriodoEndDate(p.periodo);
    const valor = parseValor(p.valor);
    if (!dataRef || Number.isNaN(valor)) continue;

    const { produto, unidade } = splitProdutoUnidade(last.nomeProduto);
    rows.push({
      produto,
      uf: last.uf,
      nivel_comercializacao: "PRODUTOR",
      preco: valor,
      unidade,
      data_referencia: dataRef,
      fonte: "Conab",
    });
  }

  if (rows.length === 0) {
    console.log("Nenhum dado coletado. Abortando sem gravar.");
    return;
  }

  // Dedupe pela mesma chave usada no upsert — Postgres upsert falha se um
  // lote tiver duas linhas visando o mesmo conflict key.
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.produto}|${row.uf}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];
  console.log(
    `\n${dedupedRows.length} linhas prontas pra gravar (${rows.length} coletadas, ${rows.length - dedupedRows.length} duplicadas removidas).`,
  );
  console.log("Produtos distintos:", new Set(dedupedRows.map((r) => r.produto)).size);
  console.log("UFs distintas:", new Set(dedupedRows.map((r) => r.uf)).size);

  if (DRY_RUN) {
    console.log("\nDRY RUN — amostra de 5 linhas:");
    console.log(JSON.stringify(dedupedRows.slice(0, 5), null, 2));
    return;
  }

  console.log("\nGravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const CHUNK = 1000;
  let gravadas = 0;
  for (let i = 0; i < dedupedRows.length; i += CHUNK) {
    const chunk = dedupedRows.slice(i, i + CHUNK);
    const { error } = await supabase.from("precos").upsert(chunk, {
      onConflict: "produto,uf,regiao,data_referencia",
    });
    if (error) {
      console.error(`Erro ao gravar lote ${i}-${i + chunk.length}:`, error);
      process.exit(1);
    }
    gravadas += chunk.length;
    console.log(`  gravado lote ${i}-${i + chunk.length} (${gravadas}/${dedupedRows.length})`);
  }
  console.log("OK. Linhas gravadas:", gravadas);

  await checkAlertas(dedupedRows);
}

async function checkAlertas(precoRows) {
  const latestByUf = new Map();
  for (const row of precoRows) {
    const current = latestByUf.get(row.uf);
    if (!current || row.data_referencia > current.data_referencia) {
      latestByUf.set(row.uf, row);
    }
  }

  const { data: alertas, error } = await supabase
    .from("alertas_preco")
    .select("id, cultura, uf, limite, direcao")
    .eq("ativo", true)
    .is("disparado_em", null);

  if (error) {
    console.error("Erro ao buscar alertas:", error);
    return;
  }
  if (!alertas || alertas.length === 0) return;

  console.log(`\nChecando ${alertas.length} alerta(s) ativo(s)...`);
  for (const alerta of alertas) {
    const preco = latestByUf.get(alerta.uf);
    if (!preco || !preco.produto.toUpperCase().includes(alerta.cultura.toUpperCase())) continue;

    const disparou =
      alerta.direcao === "acima" ? preco.preco >= alerta.limite : preco.preco <= alerta.limite;

    if (disparou) {
      console.log(
        `  -> Alerta ${alerta.id} disparado: ${alerta.cultura}/${alerta.uf} ${alerta.direcao} de ${alerta.limite} (preço atual: ${preco.preco})`,
      );
      await supabase
        .from("alertas_preco")
        .update({ disparado_em: new Date().toISOString() })
        .eq("id", alerta.id);
    }
  }
}

// O site da Conab é uma SPA real (não uma API) — de vez em quando um clique
// ou navegação estoura o timeout do Playwright por lentidão passageira do
// site, não por erro de lógica (achado em produção: ~1 em cada 5 execuções
// agendadas, sempre recuperando sozinho na tentativa seguinte, só que até
// 1 dia inteiro depois). Tenta de novo com um browser novo antes de desistir
// de verdade, em vez de esperar o próximo cron.
const TENTATIVAS = 3;
async function runComRetry() {
  for (let i = 1; i <= TENTATIVAS; i++) {
    try {
      await main();
      return;
    } catch (err) {
      if (i === TENTATIVAS) throw err;
      console.error(`Tentativa ${i}/${TENTATIVAS} falhou, tentando de novo em 10s:`, err.message ?? err);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

runComRetry().catch((err) => {
  console.error(err);
  process.exit(1);
});
