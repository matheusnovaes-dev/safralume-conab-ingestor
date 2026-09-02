import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FAZER_BACKFILL = process.argv.includes("--backfill");

const UF = "PR";
const FONTE = "DERAL/SEAB-PR";
const URL_SEMANAL = "https://www.agricultura.pr.gov.br/system/files/publico/Precos/prp.xls";
const URL_HISTORICO = "https://www.agricultura.pr.gov.br/system/files/publico/Precos/sh95recebido.xls";

// Nome do produto como aparece nas planilhas do DERAL -> produto padronizado
// no nosso banco. Soja/milho/boi usam exatamente a mesma string já usada
// pelo Conab (mesma variante comercial) pra virar mais dado do mesmo
// produto, não uma variante nova. Café/feijão/trigo/arroz o Conab já é
// fragmentado em vários TIPOs sem um vencedor claro, então entram como
// variante própria do DERAL em vez de tentar adivinhar qual TIPO bate.
const MAPA_PRODUTOS = {
  "Soja": { produto: "SOJA EM GRÃOS (60 kg)", unidade: "60 kg" },
  "Milho": { produto: "MILHO EM GRÃOS (60 kg)", unidade: "60 kg" },
  "Boi gordo": { produto: "BOI GORDO (15 kg)", unidade: "15 kg" },
  "Café beneficiado produtor": { produto: "CAFÉ BENEFICIADO (DERAL-PR) (60 kg)", unidade: "60 kg" },
  "Feijao de cor": { produto: "FEIJÃO DE COR (DERAL-PR) (60 kg)", unidade: "60 kg" },
  "Feijao preto": { produto: "FEIJÃO PRETO (DERAL-PR) (60 kg)", unidade: "60 kg" },
  "Trigo": { produto: "TRIGO (DERAL-PR) (60 kg)", unidade: "60 kg" },
  "Arroz em casca irrigado": { produto: "ARROZ EM CASCA IRRIGADO (DERAL-PR) (60 kg)", unidade: "60 kg" },
  "Cana de acucar": { produto: "CANA-DE-AÇÚCAR (DERAL-PR) (t)", unidade: "t" },
};

// Aba do arquivo histórico (uma por produto) -> chave do MAPA_PRODUTOS acima.
const MAPA_ABAS_HISTORICO = {
  SOJA: "Soja",
  MILHO: "Milho",
  "BOI GORDO": "Boi gordo",
  "CAFÉ BENEFICIADO": "Café beneficiado produtor",
  "FEIJÃO COR": "Feijao de cor",
  "FEIJÃO PRETO": "Feijao preto",
  TRIGO: "Trigo",
  "ARROZ IRRIGADO": "Arroz em casca irrigado",
  "CANA-DE-AÇÚCAR": "Cana de acucar",
};

const MESES_ABREV = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

async function baixarPlanilha(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return XLSX.read(buf, { type: "array" });
}

async function coletarSemanal() {
  const wb = await baixarPlanilha(URL_SEMANAL);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const headerRow = linhas.find((l) => l[0] === "Produto");
  if (!headerRow) throw new Error("Cabeçalho ('Produto') não encontrado na planilha semanal.");
  const idxMedia = headerRow.indexOf("MÉDIA");
  if (idxMedia === -1) throw new Error("Coluna MÉDIA não encontrada na planilha semanal.");

  const periodoTexto = linhas[0]?.find((c) => typeof c === "string" && c.startsWith("PERÍODO:"));
  const m = periodoTexto?.match(/PERÍODO:\s*\d{2}\/\d{2}\/\d{4}\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) throw new Error(`Não achei o período no cabeçalho: ${JSON.stringify(linhas[0])}`);
  const dataReferencia = `${m[3]}-${m[2]}-${m[1]}`;

  const rows = [];
  for (const linha of linhas) {
    const nomeDeral = typeof linha[1] === "string" ? linha[1].trim() : null;
    const mapeado = nomeDeral && MAPA_PRODUTOS[nomeDeral];
    if (!mapeado) continue;
    const valor = linha[idxMedia];
    if (typeof valor !== "number" || Number.isNaN(valor)) continue;
    rows.push({
      produto: mapeado.produto,
      uf: UF,
      nivel_comercializacao: "PRODUTOR",
      preco: valor,
      unidade: mapeado.unidade,
      data_referencia: dataReferencia,
      fonte: FONTE,
    });
  }
  console.log(`Semanal (${dataReferencia}): ${rows.length} linha(s) coletada(s).`);
  return rows;
}

async function coletarHistorico() {
  const wb = await baixarPlanilha(URL_HISTORICO);
  const rows = [];

  for (const [nomeAba, nomeDeral] of Object.entries(MAPA_ABAS_HISTORICO)) {
    const ws = wb.Sheets[nomeAba];
    if (!ws) {
      console.log(`  aviso: aba "${nomeAba}" não encontrada no arquivo histórico, pulando.`);
      continue;
    }
    const mapeado = MAPA_PRODUTOS[nomeDeral];
    const linhas = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const idxHeader = linhas.findIndex((l) => l[1] === "ANO");
    if (idxHeader === -1) {
      console.log(`  aviso: cabeçalho ANO não encontrado na aba "${nomeAba}", pulando.`);
      continue;
    }

    let coletadasNestaAba = 0;
    for (let i = idxHeader + 1; i < linhas.length; i++) {
      const linha = linhas[i];
      const ano = linha?.[1];
      if (typeof ano !== "number" || ano < 1990 || ano > 2100) continue;
      for (let mes = 1; mes <= 12; mes++) {
        const valor = linha[1 + mes];
        if (typeof valor !== "number" || Number.isNaN(valor)) continue;
        rows.push({
          produto: mapeado.produto,
          uf: UF,
          nivel_comercializacao: "PRODUTOR",
          preco: valor,
          unidade: mapeado.unidade,
          data_referencia: ultimoDiaDoMes(ano, mes),
          fonte: FONTE,
        });
        coletadasNestaAba++;
      }
    }
    console.log(`  ${nomeAba} -> ${nomeDeral}: ${coletadasNestaAba} linha(s).`);
  }
  console.log(`Histórico: ${rows.length} linha(s) coletada(s) no total.`);
  return rows;
}

async function checkAlertas(precoRows) {
  const latestByProdutoUf = new Map();
  for (const row of precoRows) {
    const chave = `${row.produto}|${row.uf}`;
    const atual = latestByProdutoUf.get(chave);
    if (!atual || row.data_referencia > atual.data_referencia) {
      latestByProdutoUf.set(chave, row);
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
    if (alerta.uf !== UF) continue;
    const preco = [...latestByProdutoUf.values()].find(
      (p) => p.uf === alerta.uf && p.produto.toUpperCase().includes(alerta.cultura.toUpperCase()),
    );
    if (!preco) continue;

    const disparou =
      alerta.direcao === "acima" ? preco.preco >= alerta.limite : preco.preco <= alerta.limite;

    if (disparou) {
      console.log(`  alerta ${alerta.id} (${alerta.cultura}/${alerta.uf}) disparado: preço ${preco.preco}`);
    }
  }
}

async function gravar(rows, rotulo) {
  if (rows.length === 0) {
    console.log(`Nenhuma linha de ${rotulo} pra gravar.`);
    return;
  }

  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.produto}|${row.uf}|${row.data_referencia}`, row);
  }
  const dedupedRows = [...byKey.values()];
  console.log(
    `${dedupedRows.length} linha(s) de ${rotulo} prontas pra gravar (${rows.length} coletadas, ${rows.length - dedupedRows.length} duplicadas removidas).`,
  );

  if (DRY_RUN) {
    console.log(`DRY RUN (${rotulo}) — amostra de 5 linhas:`);
    console.log(JSON.stringify(dedupedRows.slice(0, 5), null, 2));
    return;
  }

  const CHUNK = 1000;
  let gravadas = 0;
  for (let i = 0; i < dedupedRows.length; i += CHUNK) {
    const chunk = dedupedRows.slice(i, i + CHUNK);
    const { error } = await supabase.from("precos").upsert(chunk, {
      onConflict: "produto,uf,data_referencia",
    });
    if (error) {
      console.error(`Erro ao gravar lote ${i}-${i + chunk.length} (${rotulo}):`, error);
      process.exit(1);
    }
    gravadas += chunk.length;
  }
  console.log(`OK (${rotulo}). Linhas gravadas: ${gravadas}`);

  if (!DRY_RUN) await checkAlertas(dedupedRows);
}

async function run() {
  const semanal = await coletarSemanal();
  await gravar(semanal, "semanal");

  if (FAZER_BACKFILL) {
    console.log("\n--backfill informado — coletando histórico completo (1995-hoje)...");
    const historico = await coletarHistorico();
    await gravar(historico, "histórico");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
