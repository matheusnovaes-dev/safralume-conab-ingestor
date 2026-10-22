import { createClient } from "@supabase/supabase-js";

// Vigia de frescor das fontes de preço. Achado 2026-10-15: a Conab ficou fora do ar por vezes e o
// Emater/RS roda numa VM Oracle fora do GitHub (o Actions dele é só manual e aparece vermelho), então
// "tudo verde no Actions" não prova que o dado está chegando. Aqui o teste é no próprio dado: a
// data de referência mais recente de cada fonte na tabela `precos` e, nas fontes diárias, quando
// foi a última gravação. Passou do limite, o job falha e o GitHub avisa por e-mail.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes.");
  process.exit(2);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// maxDiasRef: idade máxima da data de referência. maxHorasGravacao: idade máxima da última gravação
// (só nas fontes que rodam todo dia). Os limites seguem a periodicidade real de cada fonte.
const FONTES = [
  { fonte: "BBM", maxDiasRef: 5, maxHorasGravacao: 72 },
  { fonte: "Conab", maxDiasRef: 16, maxHorasGravacao: 36 },
  { fonte: "IEA-SP", maxDiasRef: 16, maxHorasGravacao: 72 },
  // Série mensal do IEA: a fonte publica com ~4 meses de atraso (jun/2026 em out/2026) e a data gravada é o dia 1 do mês.
  { fonte: "IEA-SP (mensal)", maxDiasRef: 175, maxHorasGravacao: 240 },
  { fonte: "DERAL/SEAB-PR", maxDiasRef: 14 },
  { fonte: "EMATER/RS-Ascar", maxDiasRef: 12 },
  { fonte: "Imea", maxDiasRef: 14 },
  { fonte: "EPAGRI/CEPA-SC", maxDiasRef: 50 },
  { fonte: "Conseleite-MG (projeção)", maxDiasRef: 60 },
];

const DIA = 86_400_000;
const agora = Date.now();
const problemas = [];

for (const f of FONTES) {
  const { data: ref } = await supabase
    .from("precos")
    .select("data_referencia")
    .eq("fonte", f.fonte)
    .lte("data_referencia", new Date().toISOString().slice(0, 10))
    .order("data_referencia", { ascending: false })
    .limit(1);
  const { data: gravado } = await supabase
    .from("precos")
    .select("updated_at")
    .eq("fonte", f.fonte)
    .order("updated_at", { ascending: false })
    .limit(1);

  const dataRef = ref?.[0]?.data_referencia;
  const idadeRef = dataRef ? (agora - new Date(`${dataRef}T12:00:00Z`).getTime()) / DIA : Infinity;
  const ultimaGravacao = gravado?.[0]?.updated_at;
  const horas = ultimaGravacao ? (agora - new Date(ultimaGravacao).getTime()) / 3_600_000 : Infinity;

  let status = "ok";
  if (!dataRef) {
    status = "SEM DADO";
    problemas.push(`${f.fonte}: nenhuma linha na tabela precos`);
  } else if (idadeRef > f.maxDiasRef) {
    status = "DEFASADO";
    problemas.push(
      `${f.fonte}: dado mais recente é de ${dataRef} (${idadeRef.toFixed(0)} dias; limite ${f.maxDiasRef})`,
    );
  } else if (f.maxHorasGravacao && horas > f.maxHorasGravacao) {
    status = "SEM GRAVAÇÃO";
    problemas.push(
      `${f.fonte}: última gravação há ${horas.toFixed(0)}h (limite ${f.maxHorasGravacao}h), o robô pode estar parado`,
    );
  }
  console.log(
    `${status.padEnd(12)} ${f.fonte.padEnd(26)} ref ${dataRef ?? "-"} (${Number.isFinite(idadeRef) ? idadeRef.toFixed(0) : "?"}d) gravado há ${Number.isFinite(horas) ? horas.toFixed(0) : "?"}h`,
  );
}

if (problemas.length > 0) {
  console.error("\nFontes com problema:\n- " + problemas.join("\n- "));
  process.exit(1);
}
console.log("\nTodas as fontes dentro do prazo.");
