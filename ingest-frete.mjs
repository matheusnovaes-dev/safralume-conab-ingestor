import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// A Sifreca só publica frete pra rotas "selecionadas" (curadas por eles, não
// por município completo) e só pra estas culturas.
const CULTURAS = ["soja", "milho"];

function parseNumeroBR(s) {
  return parseFloat(s.trim().replace(/\./g, "").replace(",", "."));
}

async function coletarCultura(page, cultura) {
  console.log(`Buscando frete de ${cultura}...`);
  await page.goto(`https://sifreca.esalq.usp.br/mercado/${cultura}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(1000);

  const linhas = await page.evaluate(() => {
    const tabela = document.querySelector("table");
    if (!tabela) return [];
    return Array.from(tabela.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()),
    );
  });

  const rows = [];
  for (const cols of linhas) {
    // Origem | UF | Destino | UF | Frete (R$/t) | Momento (R$/t.km)
    const [municipioOrigem, ufOrigem, municipioDestino, ufDestino, freteRtStr, freteRtKmStr] = cols;
    if (!municipioOrigem || !ufOrigem || freteRtStr === "Nenhum resultado encontrado") continue;
    const freteRt = parseNumeroBR(freteRtStr ?? "");
    if (Number.isNaN(freteRt)) continue;
    rows.push({
      cultura,
      municipio_origem: municipioOrigem,
      uf_origem: ufOrigem,
      municipio_destino: municipioDestino,
      uf_destino: ufDestino,
      frete_rt: freteRt,
      frete_rt_km: Number.isNaN(parseNumeroBR(freteRtKmStr ?? "")) ? null : parseNumeroBR(freteRtKmStr),
      fonte: "Sifreca/ESALQ-LOG",
    });
  }
  console.log(`  -> ${rows.length} rotas`);
  return rows;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await run(page);
  } catch (err) {
    await page.screenshot({ path: "failure-frete.png", fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

async function run(page) {
  const todasRows = [];
  for (const cultura of CULTURAS) {
    const rows = await coletarCultura(page, cultura);
    todasRows.push(...rows);
  }

  if (todasRows.length === 0) {
    console.log("Nenhuma rota coletada. Abortando sem gravar.");
    return;
  }

  console.log(`\n${todasRows.length} rotas coletadas no total.`);
  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(todasRows.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("fretes")
    .upsert(todasRows, { onConflict: "cultura,uf_origem,municipio_origem,municipio_destino" });

  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", todasRows.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
