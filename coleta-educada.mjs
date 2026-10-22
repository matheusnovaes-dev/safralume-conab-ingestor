import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Boas práticas de coleta para as fontes públicas (Cepea, Datagro, IEA): pedir o mínimo, devagar, identificado e parar quando
 * pedirem. Nada aqui tenta driblar bloqueio: se uma fonte disser "não" (403, 429 repetido, desafio de robô), o script PARA com
 * um erro claro (o job fica vermelho e o GitHub avisa) em vez de insistir, trocar de identidade ou imitar navegador.
 *
 * - identificação própria (SafralumeBot + site), nunca se passa por navegador;
 * - um pedido por vez, com espaço (e variação aleatória) entre eles;
 * - tempo limite e nova tentativa com espera crescente SÓ para falha de rede/5xx; 429 respeita Retry-After;
 * - 401/403/desafio de robô: aborta na hora (BloqueioDetectado), sem repetir;
 * - GET condicional (If-Modified-Since) quando a fonte informa Last-Modified: página que não mudou não é baixada de novo;
 * - não coleta de novo o que já coletou há pouco (jaCaptadoHa), e só vai buscar os dias que faltam (diasSemDado).
 */

export const UA_PADRAO = "SafralumeBot/1.0 (+https://safralume.com.br; coleta educada de dados publicos autorizada)";
const MARCAS_DE_BLOQUEIO = /just a moment|cf-chl|captcha|attention required|access denied|enable javascript and cookies/i;

export class BloqueioDetectado extends Error {
  constructor(url, motivo) {
    super(`Bloqueio detectado em ${url}: ${motivo}. Coleta interrompida de propósito (não insistimos nem contornamos).`);
    this.name = "BloqueioDetectado";
  }
}

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera `base` ms mais até `variacao` ms aleatórios: pedidos com ritmo humano, nunca em rajada. */
export const esperarComVariacao = (base, variacao = base / 2) => esperar(base + Math.random() * variacao);

/** Atraso inicial aleatório: vários jobs não batem na fonte no mesmo segundo. Ignorado em teste (COLETA_SEM_ATRASO=1). */
export async function atrasoInicial(maxMs = 20_000) {
  if (process.env.COLETA_SEM_ATRASO === "1" || process.env.DRY === "1") return;
  await esperar(Math.random() * maxMs);
}

// ---- cache de Last-Modified entre execuções (no GitHub Actions persiste via actions/cache) ----
const DIR_CACHE = process.env.COLETA_CACHE_DIR ?? ".cache-coleta";
const ARQ_CACHE = `${DIR_CACHE}/lastmodified.json`;
const lerCache = () => {
  try {
    return existsSync(ARQ_CACHE) ? JSON.parse(readFileSync(ARQ_CACHE, "utf8")) : {};
  } catch {
    return {};
  }
};
const gravarCache = (c) => {
  try {
    mkdirSync(DIR_CACHE, { recursive: true });
    writeFileSync(ARQ_CACHE, JSON.stringify(c));
  } catch {
    // sem cache em disco só perde a otimização
  }
};

/**
 * GET/POST com cuidado. Devolve { status, texto, naoModificado }.
 * `condicional: true` envia If-Modified-Since com o Last-Modified da última vez e devolve naoModificado=true no 304.
 */
export async function buscarComCuidado(url, { metodo = "GET", headers = {}, corpo, condicional = false, tentativas = 3, timeoutMs = 25_000, ua = UA_PADRAO } = {}) {
  const cache = condicional ? lerCache() : {};
  let ultimoErro;
  for (let n = 1; n <= tentativas; n++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const h = { "User-Agent": ua, ...headers };
      if (condicional && cache[url]) h["If-Modified-Since"] = cache[url];
      const res = await fetch(url, { method: metodo, headers: h, body: corpo, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 304) return { status: 304, texto: "", naoModificado: true };
      if (res.status === 401 || res.status === 403) throw new BloqueioDetectado(url, `HTTP ${res.status}`);
      if (res.status === 429) {
        const espera = Math.min(Number(res.headers.get("retry-after")) || 30, 60) * 1000;
        if (n >= 2) throw new BloqueioDetectado(url, "HTTP 429 repetido (limite de pedidos)");
        await esperar(espera);
        continue;
      }
      if (res.status >= 500) {
        ultimoErro = new Error(`HTTP ${res.status} em ${url}`);
        await esperarComVariacao(2000 * 3 ** (n - 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
      const texto = await res.text();
      if (texto.length < 20_000 && MARCAS_DE_BLOQUEIO.test(texto)) throw new BloqueioDetectado(url, "página de desafio/robô em vez do conteúdo");
      const lm = res.headers.get("last-modified");
      if (condicional && lm) {
        cache[url] = lm;
        gravarCache(cache);
      }
      return { status: res.status, texto, naoModificado: false, res };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof BloqueioDetectado) throw e;
      ultimoErro = e;
      if (n < tentativas) await esperarComVariacao(2000 * 3 ** (n - 1));
    }
  }
  throw ultimoErro ?? new Error(`Falha ao buscar ${url}`);
}

/** Já gravamos esta fonte nas últimas `horas`? (então não pedimos de novo). FORCAR=1 ignora. */
export async function jaCaptadoHa(supabase, { tabela = "precos", fonte, horas }) {
  if (process.env.FORCAR === "1" || !supabase) return false;
  const { data } = await supabase.from(tabela).select("updated_at").eq("fonte", fonte).order("updated_at", { ascending: false }).limit(1);
  const ultimo = data?.[0]?.updated_at;
  return !!ultimo && Date.now() - new Date(ultimo).getTime() < horas * 3_600_000;
}

/** Dias úteis (seg-sex) dos últimos `dias` que ainda NÃO têm dado, para pedir só esses. `datasComDado`: Set de YYYY-MM-DD. */
export function diasSemDado(dias, datasComDado, hoje = new Date()) {
  const out = [];
  for (let n = 0; n < dias; n++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - n));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (!datasComDado.has(iso)) out.push(iso);
  }
  return out;
}

export const isoParaBR = (iso) => iso.split("-").reverse().join("/");

/** Datas (YYYY-MM-DD) que a fonte já tem na tabela, nos últimos `dias`. */
export async function datasJaGravadas(supabase, { tabela = "precos", fonte, filtroProduto, dias = 20 }) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
  let q = supabase.from(tabela).select("data_referencia").eq("fonte", fonte).gte("data_referencia", desde).limit(2000);
  if (filtroProduto) q = q.eq("produto", filtroProduto);
  const { data } = await q;
  return new Set((data ?? []).map((r) => r.data_referencia));
}
