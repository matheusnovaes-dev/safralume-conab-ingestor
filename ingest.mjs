import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PRODUTO_ID = "29"; // SOJA
const PRODUTO_NOME = "SOJA EM GRÃOS (60 kg)";
const NIVEL_CODE = "5"; // PRODUTOR
const TARGET_UFS = ["GOIAS", "MATO GROSSO", "PARANA"];

function ddmmyyyy(date) {
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
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

let previousUf = null;

async function queryUf(page, uf) {
  await page.locator('.br-select:has-text("Unidade da federação")').first().click();
  await page.waitForTimeout(400);
  // "Unidade da federação" is a multi-select checkbox list — uncheck whatever
  // was picked last run, or selections accumulate across UFs.
  if (previousUf) {
    await page.getByText(previousUf, { exact: true }).click();
    await page.waitForTimeout(200);
  }
  await page.getByText(uf, { exact: true }).click();
  previousUf = uf;
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(600);

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/consulta/precos/consultar") && res.request().method() === "POST",
    { timeout: 15000 },
  );
  await page.locator('button:has-text("Consultar")').click();
  const res = await responsePromise;
  const body = await res.json().catch(() => null);
  return body?.precos ?? [];
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
  console.log("Loading Conab price query tool...");
  await page.goto("https://consultaprecosdemercado.conab.gov.br/#/home", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("#range-input", { timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.locator("#range-input").click();
  await page.waitForTimeout(500);
  // Pick two day-cells within the same visible month, ~2.5 weeks apart, to
  // stay safely under the site's 4-week-per-query limit.
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
    await page.screenshot({ path: "/tmp/conab-ingest-error.png", fullPage: true });
    throw new Error(
      "Campo 'Produto' não apareceu após Pesquisar — intervalo de datas provavelmente inválido. Ver /tmp/conab-ingest-error.png",
    );
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

  const rows = [];

  for (const uf of TARGET_UFS) {
    console.log(`Querying ${uf}...`);
    const precos = await queryUf(page, uf);
    const ufAbbrev = precos[0]?.uf;
    for (const p of precos) {
      const dataRef = parsePeriodoEndDate(p.periodo);
      const valor = parseValor(p.valor);
      if (!dataRef || Number.isNaN(valor)) continue;
      rows.push({
        produto: PRODUTO_NOME,
        uf: ufAbbrev || uf,
        nivel_comercializacao: "PRODUTOR",
        preco: valor,
        unidade: "saca 60kg",
        data_referencia: dataRef,
        fonte: "Conab",
      });
    }
    console.log(`  -> ${precos.length} linhas`);
  }

  if (rows.length === 0) {
    console.log("Nenhum dado coletado. Abortando sem gravar.");
    return;
  }

  // Dedupe by the same key the DB constraint uses — Postgres upsert fails if
  // a batch has two rows targeting the same conflict key.
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.produto}|${row.uf}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];

  console.log(`\nGravando ${dedupedRows.length} linhas no Supabase (${rows.length} coletadas, ${rows.length - dedupedRows.length} duplicadas removidas)...`);
  const { error } = await supabase
    .from("precos")
    .upsert(dedupedRows, { onConflict: "produto,uf,data_referencia" });

  if (error) {
    console.error("Erro ao gravar no Supabase:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", dedupedRows.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
