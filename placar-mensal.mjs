// Job mensal do PLACAR: lê historico_mensal, refaz o teste do padrão do ano (placar-calculo.mjs) e grava o resultado em placar_resultados.
// O app (painel, bot, /placar e a landing) lê sempre a linha mais recente. Se algo falhar, a linha anterior continua valendo. Guarda as 12 últimas.
// Variáveis: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. COLETA_SO_LER=1 só calcula e imprime (não grava).
import { createClient } from "@supabase/supabase-js";
import { calcularPlacar, LIMITE_ACERTO, MIN_CASOS } from "./placar-calculo.mjs";

const SO_LER = process.env.PLACAR_SO_LER === "1";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function lerTudo() {
  const tudo = [];
  for (let off = 0; off < 200000; off += 1000) {
    const { data, error } = await supabase.from("historico_mensal").select("produto, uf, ano, mes, valor").order("produto").order("uf").order("ano").order("mes").range(off, off + 999);
    if (error) throw new Error(`leitura de historico_mensal: ${error.message}`);
    tudo.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return tudo;
}

const rows = await lerTudo();
if (rows.length < 5000) throw new Error(`historico_mensal com só ${rows.length} linhas: não vou sobrescrever o placar com dado incompleto`);
const anoFim = new Date().getUTCFullYear() - 1; // último ano fechado
const { series, acertos, resumo } = calcularPlacar(rows, 2014, anoFim);
// Trava de sanidade: um placar que despenca de uma vez quase sempre é dado quebrado, não mudança do mundo.
const { data: anterior } = await supabase.from("placar_resultados").select("resumo").order("gerado_em", { ascending: false }).limit(1).maybeSingle();
const ant = anterior?.resumo?.geral?.acerto;
if (ant != null && Math.abs(resumo.geral.acerto - ant) > 8) throw new Error(`o acerto geral foi de ${ant}% para ${resumo.geral.acerto}%: variação grande demais, confira historico_mensal antes de publicar`);
if (resumo.geral.series < 30) throw new Error(`só ${resumo.geral.series} séries: dado incompleto`);
console.log(`placar: ${resumo.geral.series} séries, ${resumo.geral.passam} passam, acerto geral ${resumo.geral.acerto}% em ${resumo.geral.casos} afirmações (${rows.length} linhas, 2014-${anoFim})`);
if (SO_LER) process.exit(0);
const { error } = await supabase.from("placar_resultados").insert({ versao: "v1", resumo, acertos, series, parametros: { limite: LIMITE_ACERTO, minCasos: MIN_CASOS, anoIni: 2014, anoFim, linhas: rows.length } });
if (error) throw new Error(`gravação: ${error.message}`);
const { data: antigos } = await supabase.from("placar_resultados").select("id").order("gerado_em", { ascending: false }).range(12, 200);
if (antigos?.length) await supabase.from("placar_resultados").delete().in("id", antigos.map((x) => x.id));
console.log("placar gravado.");
