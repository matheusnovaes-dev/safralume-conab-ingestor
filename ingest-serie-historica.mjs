import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Painel "Série Histórica de Safra - Grãos" do Portal de Informações da Conab
// (achado 2026-09-30, ver https://www.conab.gov.br — painel público nº 78,
// categoria Produção agrícola). É Pentaho/CDA por trás do iframe: a mesma
// URL pública do wcdf embute o login "pentaho:password" como guest — sem
// sessão de browser nem Playwright, só fetch com Basic Auth direto no
// endpoint /plugin/cda/api/doQuery. Área plantada, produção e produtividade
// por cultura, por UF e nacional, voltando até a safra 1976/77 — histórico
// que a Conab expõe pra série de grãos, não é a % semanal de plantio em
// andamento (esse dado só existe em texto corrido dentro do boletim mensal
// em PDF da Conab, não como consulta estruturada — decidido não perseguir
// isso agora por ser um parsing muito mais frágil que o resto desta base).
const CDA_URL = "https://pentahoportaldeinformacoes.conab.gov.br/pentaho/plugin/cda/api/doQuery?";
const CDA_PATH = "/home/SIMASA2/SerieHistorica/SerieHistorica.cda";
const AUTH = "Basic " + Buffer.from("pentaho:password").toString("base64");

// As 18 culturas de grãos que esse painel cobre (confirmado direto na API,
// dataAccessId=produto) — só grãos, não é o catálogo inteiro da Conab.
const PRODUTOS = [
  "ALGODAO EM CAROCO", "ALGODAO EM PLUMA", "AMENDOIM", "ARROZ", "AVEIA", "CANOLA",
  "CAROCO DE ALGODAO", "CENTEIO", "CEVADA", "FEIJAO", "GERGELIM", "GIRASSOL",
  "MAMONA EM BAGA", "MILHO", "SOJA", "SORGO GRANIFERO", "TRIGO", "TRITICALE",
];

// UF -> região (chave hierárquica que o Mondrian/Pentaho exige: [UF].[REGIAO].[SIGLA]).
const UF_REGIAO = {
  DF: "CENTRO-OESTE", GO: "CENTRO-OESTE", MS: "CENTRO-OESTE", MT: "CENTRO-OESTE",
  AL: "NORDESTE", BA: "NORDESTE", CE: "NORDESTE", MA: "NORDESTE", PB: "NORDESTE",
  PE: "NORDESTE", PI: "NORDESTE", RN: "NORDESTE", SE: "NORDESTE",
  AC: "NORTE", AM: "NORTE", AP: "NORTE", PA: "NORTE", RO: "NORTE", RR: "NORTE", TO: "NORTE",
  ES: "SUDESTE", MG: "SUDESTE", RJ: "SUDESTE", SP: "SUDESTE",
  PR: "SUL", RS: "SUL", SC: "SUL",
};
const UFS = Object.keys(UF_REGIAO);

const CONCORRENCIA = 5;

async function chamarCda(params) {
  const body = new URLSearchParams({
    path: CDA_PATH,
    outputIndexId: "1",
    pageSize: "0",
    pageStart: "0",
    sortBy: "",
    paramsearchBox: "",
    ...params,
  });
  const res = await fetch(CDA_URL, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`CDA respondeu ${res.status} para dataAccessId=${params.dataAccessId}`);
  return res.json();
}

// Descobre a safra mais antiga E mais recente disponíveis de verdade, em vez
// de chumbar "1976/77" / "2025/26" no código — se a Conab estender a série
// (pra trás ou pra frente, com a safra seguinte) isso continua correto
// sozinho, sem precisar editar o script todo ano.
async function buscarLimitesDeSafra() {
  const json = await chamarCda({
    dataAccessId: "AnoAgricola_filtro",
    paramproduto: "[Produto].[MILHO]",
  });
  // resultset[i] = ["[Ano Agricola].[1976/77]", "1976/77"] — coluna 1 é o
  // rótulo puro que os outros parâmetros esperam dentro de [Ano Agricola].[...].
  // Vem do mais recente pro mais antigo.
  const labels = json.resultset.map((r) => r[1].trim());
  return { safraInicial: labels[labels.length - 1], safraFinal: labels[0] };
}

// Cada dataAccessId devolve uma série [ "2022/23", valor ] — funde as 3
// métricas (área/produção/produtividade) pela chave de safra.
function mesclarSeries(area, producao, produtividade) {
  const porSafra = new Map();
  const add = (json, campo) => {
    for (const [safra, valor] of json.resultset) {
      const s = safra.trim();
      if (!porSafra.has(s)) porSafra.set(s, {});
      porSafra.get(s)[campo] = valor;
    }
  };
  add(area, "area_plantada_mil_ha");
  add(producao, "producao_mil_t");
  add(produtividade, "produtividade_kg_ha");
  return porSafra;
}

// "Nacional" (AreaPlantadaNacional etc.) só devolve o valor mais recente,
// uma linha só, sem série — achado testando direto. A série histórica
// nacional de verdade sai pelos MESMOS dataAccessIds de UF, passando
// paramuf=[UF].[All UFs] (confirmado: agrega tudo igual ao card "Visão
// Nacional" do painel) — por isso não existe mais um branch "Nacional"
// separado aqui, "BR" é só mais uma chave de uf no loop.
async function buscarSerie(produto, ufChave, safraInicial, safraFinal) {
  const [area, producao, produtividade] = await Promise.all([
    chamarCda({
      dataAccessId: "AreaPlantadaUF",
      paramproduto: `[Produto].[${produto}]`,
      paramsafraInicial: `[Ano Agricola].[${safraInicial}]`,
      paramsafraFinal: `[Ano Agricola].[${safraFinal}]`,
      paramsafra: "[Safra].[All Safras]",
      paramuf: ufChave,
    }),
    chamarCda({
      dataAccessId: "ProducaoUF",
      paramproduto: `[Produto].[${produto}]`,
      paramsafraInicial: `[Ano Agricola].[${safraInicial}]`,
      paramsafraFinal: `[Ano Agricola].[${safraFinal}]`,
      paramsafra: "[Safra].[All Safras]",
      paramuf: ufChave,
    }),
    chamarCda({
      dataAccessId: "ProdutividadeUF",
      paramproduto: `[Produto].[${produto}]`,
      paramsafraInicial: `[Ano Agricola].[${safraInicial}]`,
      paramsafraFinal: `[Ano Agricola].[${safraFinal}]`,
      paramsafra: "[Safra].[All Safras]",
      paramuf: ufChave,
    }),
  ]);
  return mesclarSeries(area, producao, produtividade);
}

// Fila com concorrência limitada — 18 produtos x (27 UFs + 1 nacional) x 3
// chamadas passa de 1500 requisições; educado com o servidor da Conab
// processar aos poucos, não tudo de uma vez.
async function comConcorrencia(itens, worker, limite) {
  const resultados = [];
  let indice = 0;
  async function proximo() {
    while (indice < itens.length) {
      const i = indice++;
      resultados[i] = await worker(itens[i], i);
    }
  }
  await Promise.all(Array.from({ length: limite }, proximo));
  return resultados;
}

async function run() {
  console.log("Descobrindo os limites de safra disponíveis...");
  const { safraInicial, safraFinal } = await buscarLimitesDeSafra();
  console.log(`Safras disponíveis: ${safraInicial} até ${safraFinal}`);

  const tarefas = [];
  for (const produto of PRODUTOS) {
    tarefas.push({ produto, uf: "BR", ufChave: "[UF].[All UFs]" });
    for (const uf of UFS) {
      tarefas.push({ produto, uf, ufChave: `[UF].[${UF_REGIAO[uf]}].[${uf}]` });
    }
  }
  console.log(`${tarefas.length} combinações produto x UF (incl. nacional) a buscar...`);

  const linhas = [];
  let concluidas = 0;
  let descartadas = 0;
  await comConcorrencia(
    tarefas,
    async (tarefa) => {
      try {
        // Achado em produção: instabilidade passageira de rede (socket
        // fechado) derruba uma combinação isolada de vez em quando, entre
        // 500+ chamadas — 1 nova tentativa antes de desistir de verdade.
        let serie;
        try {
          serie = await buscarSerie(tarefa.produto, tarefa.ufChave, safraInicial, safraFinal);
        } catch (err) {
          console.error(`  ! ${tarefa.produto}/${tarefa.uf} falhou, tentando de novo:`, err.message);
          serie = await buscarSerie(tarefa.produto, tarefa.ufChave, safraInicial, safraFinal);
        }
        for (const [safra, valores] of serie) {
          // Achado testando: culturas de inverno (aveia, canola...) são
          // acompanhadas pela Conab por ANO CALENDÁRIO ("1977"), não por
          // safra cruzando dois anos ("1976/77") como soja/milho — faz
          // sentido agronômico (plantio e colheita no mesmo ano), não é
          // dado quebrado. Só descarta o que não bate com NENHUM dos dois
          // formatos de verdade.
          if (!/^\d{4}\/\d{2}$/.test(safra) && !/^\d{4}$/.test(safra)) {
            descartadas++;
            continue;
          }
          linhas.push({
            produto: tarefa.produto,
            uf: tarefa.uf,
            safra,
            area_plantada_mil_ha: valores.area_plantada_mil_ha ?? null,
            producao_mil_t: valores.producao_mil_t ?? null,
            produtividade_kg_ha: valores.produtividade_kg_ha ?? null,
            fonte: "Conab",
          });
        }
      } catch (err) {
        console.error(`  ! Falhou ${tarefa.produto}/${tarefa.uf}:`, err.message);
      }
      concluidas++;
      if (concluidas % 50 === 0) console.log(`  ${concluidas}/${tarefas.length} combinações processadas...`);
    },
    CONCORRENCIA,
  );

  console.log(
    `\n${linhas.length} linhas coletadas (produto x uf x safra), ${descartadas} descartadas por safra malformada.`,
  );
  if (linhas.length === 0) {
    console.log("Nenhum dado coletado. Abortando sem gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — amostra de 5 linhas:");
    console.log(JSON.stringify(linhas.slice(0, 5), null, 2));
    console.log("Produtos distintos:", new Set(linhas.map((r) => r.produto)).size);
    console.log("UFs distintas (incl. BR):", new Set(linhas.map((r) => r.uf)).size);
    const ufsVistas = [...new Set(linhas.map((r) => r.uf))].sort();
    console.log("UFs vistas:", ufsVistas.join(","));
    const safrasVistas = [...new Set(linhas.map((r) => r.safra))].sort();
    console.log("Safras distintas:", safrasVistas.length);
    console.log("Safras vistas:", JSON.stringify(safrasVistas));
    return;
  }

  console.log("\nGravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const CHUNK = 1000;
  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += CHUNK) {
    const chunk = linhas.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("producao_historica_conab")
      .upsert(chunk, { onConflict: "produto,uf,safra" });
    if (error) {
      console.error(`Erro ao gravar lote ${i}-${i + chunk.length}:`, error);
      process.exit(1);
    }
    gravadas += chunk.length;
    console.log(`  gravado lote ${i}-${i + chunk.length} (${gravadas}/${linhas.length})`);
  }
  console.log("OK. Linhas gravadas:", gravadas);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
