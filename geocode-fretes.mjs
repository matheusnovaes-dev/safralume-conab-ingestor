import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Script pra rodar uma vez (não é um cron): geocodifica as ~150 origens de
// frete distintas via Open-Meteo (mesma fonte/lógica já usada em
// src/lib/clima.ts do app principal pra achar coordenada de cidade) e grava
// lat_origem/lon_origem em cada linha de `fretes`. Depois disso, o app
// consegue escolher a rota de frete geograficamente mais próxima do
// produtor em vez de qualquer rota do mesmo estado.
const UF_NOME = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará",
  DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão",
  MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará",
  PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

async function buscarMunicipio(nome, nomeCompletoUf) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nome)}&count=10&language=pt&countryCode=BR`;
  const res = await fetch(url);
  if (!res.ok) return null;
  try {
    const json = await res.json();
    const resultados = json.results ?? [];
    const match = resultados.find((r) => r.admin1 === nomeCompletoUf);
    if (!match) return null;
    return { lat: match.latitude, lon: match.longitude };
  } catch {
    return null;
  }
}

async function run() {
  if (DRY_RUN) {
    console.log("Sem credenciais reais não dá pra simular — esse script só lê/escreve no banco.");
    return;
  }

  const { data: origens, error } = await supabase
    .from("fretes")
    .select("municipio_origem, uf_origem")
    .is("lat_origem", null);
  if (error) {
    console.error("Erro ao buscar origens:", error);
    process.exit(1);
  }

  const distintas = [...new Map((origens ?? []).map((r) => [`${r.municipio_origem}|${r.uf_origem}`, r])).values()];
  console.log(`${distintas.length} origem(ns) distinta(s) sem coordenada.`);

  let ok = 0;
  let falhou = 0;
  for (const { municipio_origem, uf_origem } of distintas) {
    const nomeCompletoUf = UF_NOME[uf_origem];
    if (!nomeCompletoUf) {
      console.log(`  aviso: UF desconhecida "${uf_origem}" pra ${municipio_origem}, pulando.`);
      falhou++;
      continue;
    }
    const coord = await buscarMunicipio(municipio_origem, nomeCompletoUf);
    if (!coord) {
      console.log(`  não achei: ${municipio_origem}/${uf_origem}`);
      falhou++;
      continue;
    }
    const { error: updateError } = await supabase
      .from("fretes")
      .update({ lat_origem: coord.lat, lon_origem: coord.lon })
      .eq("municipio_origem", municipio_origem)
      .eq("uf_origem", uf_origem);
    if (updateError) {
      console.log(`  erro salvando ${municipio_origem}/${uf_origem}:`, updateError.message);
      falhou++;
      continue;
    }
    ok++;
    // Não martelar a API pública sem necessidade.
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`OK. ${ok} geocodificada(s), ${falhou} sem sucesso.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
