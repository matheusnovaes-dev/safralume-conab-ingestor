import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Mesma tabela de coordenadas usada pelo dashboard (src/lib/clima.ts) —
// capital de cada UF, o suficiente pra uma tendência regional sem precisar
// geocodificar a cidade exata de cada produtor.
const capitalPorUf = {
  AC: [-9.97, -67.81], AL: [-9.65, -35.72], AP: [0.04, -51.05], AM: [-3.1, -60.02],
  BA: [-12.97, -38.51], CE: [-3.72, -38.54], DF: [-15.78, -47.93], ES: [-20.32, -40.34],
  GO: [-16.68, -49.25], MA: [-2.53, -44.3], MT: [-15.6, -56.1], MS: [-20.44, -54.65],
  MG: [-19.92, -43.94], PA: [-1.46, -48.5], PB: [-7.12, -34.88], PR: [-25.43, -49.27],
  PE: [-8.05, -34.9], PI: [-5.09, -42.8], RJ: [-22.91, -43.17], RN: [-5.79, -35.21],
  RS: [-30.03, -51.23], RO: [-8.76, -63.9], RR: [2.82, -60.67], SC: [-27.6, -48.55],
  SP: [-23.55, -46.63], SE: [-10.91, -37.07], TO: [-10.25, -48.32],
};

// Janela de decisão por condição: chuva/geada/vento são avisos de curto
// prazo (próximos 3 dias, o que dá tempo real de agir); seca prolongada
// olha a semana inteira, porque o ponto dela é "não vai chover tão cedo".
const DIAS_CURTO_PRAZO = 3;
const DIAS_SECA = 7;

async function buscarPrevisao(uf) {
  const coords = capitalPorUf[uf];
  if (!coords) return null;
  const [lat, lon] = coords;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_probability_max,temperature_2m_min,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=${DIAS_SECA}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return {
    chuvaPct: json.daily.precipitation_probability_max,
    tempMin: json.daily.temperature_2m_min,
    ventoMax: json.daily.wind_speed_10m_max,
  };
}

function condicaoDisparou(condicao, limite, previsao) {
  const janelaCurta = (arr) => arr.slice(0, DIAS_CURTO_PRAZO);
  switch (condicao) {
    case "chuva_forte":
      return janelaCurta(previsao.chuvaPct).some((v) => v != null && v >= limite);
    case "geada":
      return janelaCurta(previsao.tempMin).some((v) => v != null && v <= limite);
    case "vento_forte":
      return janelaCurta(previsao.ventoMax).some((v) => v != null && v >= limite);
    case "seca_prolongada":
      return previsao.chuvaPct.every((v) => v != null && v <= limite);
    default:
      return false;
  }
}

async function run() {
  const { data: alertas, error } = DRY_RUN
    ? { data: [], error: null }
    : await supabase
        .from("alertas_clima")
        .select("id, uf, condicao, limite, ultimo_disparo_data")
        .eq("ativo", true);

  if (error) {
    console.error("Erro ao buscar alertas:", error);
    process.exit(1);
  }
  if (!alertas || alertas.length === 0) {
    console.log(DRY_RUN ? "Dry-run: nada a checar." : "Nenhum alerta de clima ativo.");
    return;
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const previsaoPorUf = new Map();
  for (const uf of new Set(alertas.map((a) => a.uf))) {
    previsaoPorUf.set(uf, await buscarPrevisao(uf));
  }

  console.log(`Checando ${alertas.length} alerta(s) de clima ativo(s)...`);
  let disparados = 0;
  for (const alerta of alertas) {
    if (alerta.ultimo_disparo_data === hoje) continue; // já avisou hoje, não repete
    const previsao = previsaoPorUf.get(alerta.uf);
    if (!previsao) {
      console.log(`  ! Sem previsão pra UF "${alerta.uf}" (alerta ${alerta.id}).`);
      continue;
    }
    if (condicaoDisparou(alerta.condicao, Number(alerta.limite), previsao)) {
      disparados++;
      console.log(`  -> Alerta ${alerta.id} disparado: ${alerta.condicao} em ${alerta.uf}`);
      const { error: updErr } = await supabase
        .from("alertas_clima")
        .update({ para_enviar: true })
        .eq("id", alerta.id);
      if (updErr) console.error(`  Erro ao marcar alerta ${alerta.id}:`, updErr);
    }
  }
  console.log(`OK. ${disparados} alerta(s) marcado(s) pra envio.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
