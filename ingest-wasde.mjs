import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// A USDA bloqueia acesso automatizado direto (403, confirmado testando com
// curl e Playwright). O Mann Library da Cornell espelha os relatórios
// completos (txt/xls/pdf) sem bloqueio — é a fonte real usada aqui.
const LISTAGEM_URL = "https://usda.library.cornell.edu/concern/publications/3t945q76s";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Cada tabela do WASDE tem layout de coluna próprio. Soja e milho
// compartilham a mesma ordem: Beginning | Produção | Imports | Domestico |
// Total | Exportação | Estoque final. Não inclui algodão aqui de propósito
// — a tabela de algodão tem ordem de coluna diferente e outra unidade
// (fardos, não toneladas métricas), risco real de gravar unidade errada.
const TABELAS = {
  milho: "World Corn Supply and Use",
  soja: "World Soybean Supply and Use",
};

async function buscarUrlRelatorioMaisRecente() {
  const res = await fetch(LISTAGEM_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Listagem retornou ${res.status}`);
  const html = await res.text();

  const matches = [...html.matchAll(/href="(\/sites\/default\/release-files\/\d+\/wasde\d{4}[a-z0-9]*\.txt)"/gi)];
  if (matches.length === 0) throw new Error("Nenhum link de relatório .txt encontrado na listagem.");

  // A listagem vem do mais recente pro mais antigo — o primeiro match é o
  // relatório mais novo publicado.
  const caminho = matches[0][1];
  const nomeArquivo = caminho.split("/").pop(); // ex: wasde0826.txt
  const mm = nomeArquivo.slice(5, 7);
  const yy = nomeArquivo.slice(7, 9);
  const relatorioMes = `20${yy}-${mm}-01`;

  return { url: `https://usda.library.cornell.edu${caminho}`, relatorioMes };
}

function extrairBrasil(texto, tituloTabela, cultura) {
  const inicioTabela = texto.indexOf(tituloTabela);
  if (inicioTabela === -1) {
    console.log(`  ! Tabela "${tituloTabela}" não encontrada no relatório.`);
    return null;
  }
  // A próxima tabela começa com uma linha de "====...", usa isso como fim.
  const proximaTabela = texto.indexOf(tituloTabela, inicioTabela + tituloTabela.length);
  const fimTabela = proximaTabela === -1 ? texto.length : proximaTabela;
  const blocoTabela = texto.slice(inicioTabela, fimTabela);

  const linhas = blocoTabela.split("\n");
  let anoSafraAtual = null;
  let ultimoBrasil = null;
  let ultimoAnoSafra = null;

  for (const linha of linhas) {
    const matchAno = linha.match(/^\s*(\d{4}\/\d{2})\s*(Est\.|Proj\.)?\s*$/);
    if (matchAno) {
      anoSafraAtual = matchAno[2] ? `${matchAno[1]} ${matchAno[2]}` : matchAno[1];
      continue;
    }
    const matchBrasil = linha.match(/^\s*Brazil\s+(.+)$/);
    if (matchBrasil) {
      const numeros = matchBrasil[1].trim().split(/\s+/);
      if (numeros.length >= 7) {
        ultimoBrasil = numeros;
        ultimoAnoSafra = anoSafraAtual;
      }
    }
  }

  if (!ultimoBrasil) {
    console.log(`  ! Linha "Brazil" não encontrada na tabela de ${cultura}.`);
    return null;
  }

  const num = (s) => (s === "3/" || s == null ? null : parseFloat(s));
  return {
    cultura,
    ano_safra: ultimoAnoSafra ?? "desconhecido",
    producao_mi_ton: num(ultimoBrasil[1]),
    exportacao_mi_ton: num(ultimoBrasil[5]),
    estoque_final_mi_ton: num(ultimoBrasil[6]),
  };
}

async function run() {
  const { url, relatorioMes } = await buscarUrlRelatorioMaisRecente();
  console.log("Relatório mais recente:", url, "| mês:", relatorioMes);

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Relatório retornou ${res.status}`);
  // O arquivo vem com quebra de linha \r\n — normaliza pra \n, senão o \r
  // sobrando quebra o "$" dos regexes de linha (bug real, achado testando).
  const texto = (await res.text()).replace(/\r\n/g, "\n");

  const rows = [];
  for (const [cultura, tituloTabela] of Object.entries(TABELAS)) {
    console.log(`Extraindo ${cultura}...`);
    const dado = extrairBrasil(texto, tituloTabela, cultura);
    if (!dado) continue;
    console.log(`  -> ${JSON.stringify(dado)}`);
    rows.push({ relatorio_mes: relatorioMes, fonte: "USDA/WASDE", ...dado });
  }

  if (rows.length === 0) {
    console.log("Nenhum dado extraído. Abortando sem gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — não gravando.");
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("wasde_brasil")
    .upsert(rows, { onConflict: "relatorio_mes,cultura" });

  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", rows.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
