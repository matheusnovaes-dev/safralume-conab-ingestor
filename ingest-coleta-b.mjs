import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { compararComNossasFontes, escolherPracas, nomeDaPraca, norm } from "./coleta-b-regras.mjs";

/**
 * Fonte B (cotações do mercado físico, preço ao produtor por praça): TODOS os produtos, uma vez por dia, navegando como uma pessoa.
 *
 * Autorização: uso do Playwright na plataforma autorizado pelo Fonte B (documento guardado fora do repositório). Por isso: navegador Chromium
 * comum, ritmo e ordem de pessoa (pausas aleatórias, produtos embaralhados), e nenhum truque contra detecção. Se aparecer bloqueio (403/429,
 * captcha, "just a moment"), o script PARA com erro claro: nunca insiste nem contorna.
 *
 * Como o site entrega: a página de cada produto (/cotacoes/<slug>) traz as 20 primeiras praças no HTML; o botão "Carregar mais" busca as
 * próximas 20. Lemos o que o próprio navegador baixa (payload da página + respostas do botão), sem chamar endpoint por fora.
 *
 * Regra de gravação ("complementar"): o Fonte B agrega as mesmas fontes que já temos (BBM, IEA-SP...) e em algumas praças difere 5 a 7%. Para
 * NÃO mudar nenhuma resposta que já funciona, só gravamos o produto/UF que HOJE não tem dado nosso (de outra fonte) nos últimos 14 dias.
 * Nunca sobrescreve linha existente (ignoreDuplicates). Variáveis: FONTE_B_LIMITE=N (só N produtos, para teste), FONTE_B_SO_LER=1
 * (não grava, só analisa), DRY=1 (idem, sem nem ler o banco).
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEM_BANCO = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || process.env.DRY === "1";
const SO_LER = process.env.FONTE_B_SO_LER === "1" || SEM_BANCO;
const supabase = SEM_BANCO ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const LIMITE = Number(process.env.FONTE_B_LIMITE ?? 0);
// UFs em que o Fonte B é a fonte principal MESMO divergindo da fonte atual (decisão do Matheus; ex.: "PR,RS"). Vazio = só onde concorda ou não há dado.
const UFS_FORCADAS = new Set((process.env.FONTE_B_UFS_FORCADAS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));

const FONTE = "Fonte B";
const BASE = "https://www.coleta-b.com.br";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const DIAS_MAXIMOS_DE_ATRASO = 10; // praça com preço mais velho que isso não entra
const DIAS_DO_DADO_NOSSO = 14; // "já temos dado" = linha de outra fonte nos últimos 14 dias
const MARCAS_DE_BLOQUEIO = /just a moment|cf-chl|captcha|attention required|access denied|enable javascript and cookies|too many requests/i;

class BloqueioDetectado extends Error {
  constructor(onde, motivo) {
    super(`Bloqueio detectado em ${onde}: ${motivo}. Coleta interrompida de propósito (não insistimos nem contornamos).`);
    this.name = "BloqueioDetectado";
  }
}

// ---- ritmo de pessoa ----
// Sonda de bloqueio: os primeiros SONDA_PRODUTOS produtos saem num ritmo mais curto (ainda de pessoa que passa rápido), para saber em poucos minutos
// se o IP do GitHub é bloqueado. Para no primeiro sinal de bloqueio (401/403/429/captcha). Depois segue no ritmo humano normal.
const SONDA_PRODUTOS = Number(process.env.FONTE_B_SONDA ?? 12);
let ritmoRapido = false;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const entre = (a, b) => a + Math.random() * (b - a);
const pausa = (a = 2500, b = 6500) => (ritmoRapido ? esperar(entre(a * 0.4, b * 0.4)) : esperar(entre(a, b)));
const embaralhar = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);

async function gestoDeLeitura(p) {
  // uma pessoa mexe o mouse e rola a página enquanto lê
  await p.mouse.move(entre(200, 900), entre(150, 600), { steps: 8 }).catch(() => {});
  if (Math.random() < 0.6) await p.mouse.wheel(0, entre(200, 700)).catch(() => {});
  await esperar(entre(400, 1200));
}

function conferirBloqueio(resposta, onde, texto = "") {
  const status = resposta?.status?.() ?? 200;
  if ([401, 403, 429, 503].includes(status)) throw new BloqueioDetectado(onde, `HTTP ${status}`);
  if (MARCAS_DE_BLOQUEIO.test(texto.slice(0, 4000))) throw new BloqueioDetectado(onde, "desafio de robô / bloqueio na página");
}

// ---- produtos ----
const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const slugDe = (nome) =>
  semAcento(nome).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function listarProdutos(p) {
  await p.goto(`${BASE}/cotacoes/soja-em-grao-sc-60kg`, { waitUntil: "domcontentloaded", timeout: 60_000 }).then((r) => conferirBloqueio(r, "página inicial"));
  await p.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await pausa(2500, 4500);
  await p.getByText("Buscar produtos", { exact: false }).first().click();
  await pausa(1500, 2500);
  const vistos = new Set();
  for (let i = 0; i < 40; i++) {
    const itens = await p.locator("[role=dialog] label, dialog label").evaluateAll((els) => els.map((e) => e.innerText.trim().replace(/\n+/g, " | ")));
    const antes = vistos.size;
    itens.forEach((x) => vistos.add(x));
    if (vistos.size === antes && i > 2) break;
    await p.locator("[role=dialog] label, dialog label").last().scrollIntoViewIfNeeded().catch(() => {});
    await esperar(entre(300, 700));
  }
  return [...vistos]
    .map((x) => {
      const [nome, n] = x.split(" | ");
      return { nome: nome.trim(), series: Number((n ?? "0").replace(/\./g, "")) };
    })
    .filter((x) => x.nome);
}

/** Extrai o array `pracas` do payload embutido na página (primeiras 20). */
function pracasDoHtml(html) {
  const blocos = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)].map((m) => m[1]);
  for (const b of blocos) {
    let txt;
    try {
      txt = JSON.parse(`"${b}"`);
    } catch {
      continue;
    }
    const i = txt.indexOf('"pracas":[');
    if (i < 0) continue;
    const k = txt.indexOf("[", i);
    let d = 0;
    for (let pos = k; pos < txt.length; pos++) {
      if (txt[pos] === "[") d++;
      else if (txt[pos] === "]" && --d === 0) {
        try {
          const total = Number(/"numPracas":(\d+)/.exec(txt)?.[1] ?? 0);
          return { pracas: JSON.parse(txt.slice(k, pos + 1)), total };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function coletarProduto(p, produto) {
  const lotes = [];
  const ouvinte = async (r) => {
    if (r.url().includes("/api/cotacoes/busca/pracas")) {
      try {
        lotes.push(await r.json());
      } catch {
        /* resposta sem JSON: ignora */
      }
    }
  };
  p.on("response", ouvinte);
  try {
    const slug = slugDe(produto.nome);
    const r = await p.goto(`${BASE}/cotacoes/${slug}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await p.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await esperar(entre(800, 1800));
    if (r?.status?.() === 404) return { ...produto, slug, erro: "404 (slug não bate)", pracas: [] };
    const html = await p.content();
    conferirBloqueio(r, produto.nome, html);
    const primeira = pracasDoHtml(html);
    if (!primeira) return { ...produto, slug, erro: "sem payload de praças na página", pracas: [] };
    await gestoDeLeitura(p);
    let cliques = 0;
    while (cliques < 60) {
      const botao = p.getByText("Carregar mais", { exact: false }).first();
      if (!(await botao.count())) break;
      await pausa(2200, 5200);
      await botao.scrollIntoViewIfNeeded().catch(() => {});
      // anúncio ou aviso na frente do botão: fecha com Escape e tenta de novo, como uma pessoa faria; por último, clique direto no elemento
      let clicou = false;
      for (const tentativa of [1, 2, 3]) {
        try {
          await botao.click({ timeout: 8000, force: tentativa === 3 });
          clicou = true;
          break;
        } catch {
          await p.keyboard.press("Escape").catch(() => {});
          await p.mouse.wheel(0, entre(-300, 300)).catch(() => {});
          await esperar(entre(800, 1800));
        }
      }
      if (!clicou) break;
      cliques++;
      await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await esperar(entre(900, 2200));
    }
    const pracas = [...primeira.pracas, ...lotes.flatMap((l) => l.pracas ?? [])];
    return { ...produto, slug, total: primeira.total, cliques, pracas, ok: pracas.length === primeira.total };
  } finally {
    p.off("response", ouvinte);
  }
}

// ---- mapa para o nosso banco ----
// Produtos do nosso banco que o Fonte B também tem: usamos exatamente o nome que o resto do app já procura.
const NOME_NOSSO = {
  "soja em grão sc 60kg": ["SOJA EM GRÃOS (60 kg)", "60 kg"],
  "milho seco sc 60kg": ["MILHO EM GRÃOS (60 kg)", "60 kg"],
  "boi gordo 15kg": ["BOI GORDO (15 kg)", "15 kg"],
};
const UNIDADES = [
  [/sc\s*(\d+(?:[.,]\d+)?)\s*kg/i, (m) => `${m[1]} kg`],
  [/cx\s*(\d+(?:[.,]\d+)?)\s*kg/i, (m) => `cx ${m[1]} kg`],
  [/kg\/vivo\s*1\s*kg/i, () => "kg vivo"],
  [/(\d+(?:[.,]\d+)?)\s*kg$/i, (m) => (m[1] === "1" ? "kg" : `${m[1]} kg`)],
  [/1\s*ton$/i, () => "ton"],
  [/1\s*l$/i, () => "litro"],
  [/1\s*cab$/i, () => "cabeça"],
  [/1\s*@$/i, () => "@"],
];
function mapearProduto(nome) {
  const nosso = NOME_NOSSO[nome.trim().toLowerCase()];
  if (nosso) return { produto: nosso[0], unidade: nosso[1], unificado: true };
  let unidade = "unidade";
  for (const [re, f] of UNIDADES) {
    const m = re.exec(nome.trim());
    if (m) {
      unidade = f(m);
      break;
    }
  }
  return { produto: `${nome.trim().toUpperCase()} (${FONTE})`, unidade, unificado: false };
}
/** Palavra que identifica a cultura do produto, para saber se já temos algo dela naquele estado. */
const chaveDaCultura = (nome) => semAcento(nome).toLowerCase().split(/[\s,/]+/).filter((w) => w.length > 2 && !["sc", "cx", "em", "de", "do", "da", "tipo"].includes(w))[0] ?? "";
const semAcentoMinusculo = (t) => norm(t);
const dia = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);

async function carregarOutrasFontes() {
  // linhas das OUTRAS fontes nos últimos 14 dias: base da comparação e da regra "só onde não temos dado"
  const desde = new Date(Date.now() - DIAS_DO_DADO_NOSSO * 86_400_000).toISOString().slice(0, 10);
  const linhas = [];
  for (let off = 0; off < 60_000; off += 1000) {
    const { data, error } = await supabase.from("precos").select("uf, produto, regiao, preco, data_referencia, fonte").gte("data_referencia", desde).neq("fonte", FONTE).range(off, off + 999);
    if (error) throw new Error(`erro lendo as outras fontes: ${error.message}`);
    if (!data?.length) break;
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  return linhas;
}

async function publicarSonda(dados) {
  if (!supabase) return;
  const corpo = Buffer.from(JSON.stringify({ quando: new Date().toISOString(), ...dados }));
  const { error } = await supabase.storage.from("marketing-temp").upload("coleta-b/sonda.json", corpo, { upsert: true, contentType: "application/json" });
  if (error) console.log(`Aviso: sonda não enviada ao storage (${error.message}).`);
}

async function main() {
  const inicio = Date.now();
  if (process.env.COLETA_SEM_ATRASO !== "1" && !LIMITE && process.env.GITHUB_EVENT_NAME === "schedule") await esperar(entre(0, 15 * 60_000)); // hora de chegada de pessoa, não de relógio
  let navegador, ctx, p;
  const abrir = async () => {
    await navegador?.close().catch(() => {});
    navegador = await chromium.launch();
    ctx = await navegador.newContext({ userAgent: UA, locale: "pt-BR", timezoneId: "America/Sao_Paulo", viewport: { width: 1366 + Math.floor(Math.random() * 400), height: 800 + Math.floor(Math.random() * 200) } });
    p = await ctx.newPage();
  };
  await abrir();
  const coletados = [];
  let bloqueio = null;
  try {
    const todos = await listarProdutos(p);
    console.log(`Fonte B: ${todos.length} produtos no catálogo.`);
    let fila = embaralhar(todos);
    if (LIMITE) fila = fila.slice(0, LIMITE);
    let n = 0;
    const inicioDaSonda = Date.now();
    let sondaPublicada = false;
    for (const produto of fila) {
      ritmoRapido = n < SONDA_PRODUTOS;
      await pausa(3000, 8000);
      if (!ritmoRapido && ++n % 12 === 0) await pausa(15_000, 40_000); // "pausa para o café"
      else if (ritmoRapido) n++;
      let r;
      for (let tentativa = 1; tentativa <= 2 && !r; tentativa++) {
        try {
          r = await coletarProduto(p, produto);
        } catch (e) {
          if (e instanceof BloqueioDetectado) throw e;
          const caiu = /closed|crash|Target page|browser has been/i.test(String(e.message));
          if (caiu && tentativa === 1) {
            await abrir(); // o navegador caiu: abre outro e repete este produto uma vez
            continue;
          }
          r = { ...produto, slug: slugDe(produto.nome), erro: `falha: ${String(e.message).split("\n")[0].slice(0, 90)}`, pracas: [] };
        }
      }
      coletados.push(r);
      console.log(`  [${n}/${fila.length}] ${produto.nome}: ${r.erro ? `ERRO ${r.erro}` : `${r.pracas.length}/${r.total} praças${r.ok ? "" : " (INCOMPLETO)"}`}`);
      if (!sondaPublicada && (n >= SONDA_PRODUTOS || n >= fila.length)) {
        sondaPublicada = true;
        const segundos = Math.round((Date.now() - inicioDaSonda) / 1000);
        const comErro = coletados.filter((x) => x.erro).length;
        console.log(`SONDA OK: ${coletados.length} produtos em ${segundos}s sem bloqueio (${comErro} com erro de leitura).`);
        await publicarSonda({ ok: true, produtos: coletados.length, segundos, comErro, ip: process.env.GITHUB_ACTIONS ? "GitHub Actions" : "local" });
      }
    }
  } catch (e) {
    if (e instanceof BloqueioDetectado) {
      bloqueio = e;
      await publicarSonda({ ok: false, motivo: e.message, produtosAntes: coletados.length, ip: process.env.GITHUB_ACTIONS ? "GitHub Actions" : "local" });
    } else throw e;
  } finally {
    await navegador?.close().catch(() => {});
  }

  // ---- gravação ----
  const outras = SEM_BANCO ? [] : await carregarOutrasFontes();
  const outrasPorProdutoUf = new Map();
  const outrasPorUf = new Map();
  for (const o of outras) {
    const k = `${o.produto}|${o.uf}`;
    if (!outrasPorProdutoUf.has(k)) outrasPorProdutoUf.set(k, []);
    outrasPorProdutoUf.get(k).push(o);
    if (!outrasPorUf.has(o.uf)) outrasPorUf.set(o.uf, []);
    outrasPorUf.get(o.uf).push(o);
  }
  const linhas = [];
  const pulados = { velha: 0, invalida: 0, divergeDaFonteAtual: 0, semComoComparar: 0, jaTemosOutraVariante: 0 };
  const porUf = {};
  const decisoes = [];
  for (const r of coletados) {
    // Preço de ATACADO (Ceasa, central de abastecimento) não é o que o produtor recebe: o app trata `precos` como preço ao produtor e o atacado
    // tem tabela própria (precos_atacado). Produto de atacado do Fonte B fica de fora.
    if (/atacado/i.test(r.nome)) {
      pulados.atacado = (pulados.atacado ?? 0) + (r.pracas?.length ?? 0);
      continue;
    }
    const m = mapearProduto(r.nome);
    const chave = chaveDaCultura(r.nome);
    const porUfDoProduto = new Map();
    for (const x of r.pracas ?? []) {
      if (!x.uf || !x.cidade || !Number.isFinite(x.preco) || x.preco <= 0) {
        pulados.invalida++;
        continue;
      }
      const data = dia(x.dia);
      if ((Date.now() - Date.parse(`${data}T00:00:00Z`)) / 86_400_000 > DIAS_MAXIMOS_DE_ATRASO) {
        pulados.velha++;
        continue;
      }
      if (!porUfDoProduto.has(x.uf)) porUfDoProduto.set(x.uf, []);
      porUfDoProduto.get(x.uf).push({ cidade: x.cidade, preco: x.preco, data });
    }
    for (const [uf, pracas] of porUfDoProduto) {
      let decisao;
      if (m.unificado) {
        decisao = compararComNossasFontes(pracas, outrasPorProdutoUf.get(`${m.produto}|${uf}`) ?? []);
      } else {
        // variante só do Fonte B: grava se não houver nada parecido (mesma cultura) de outra fonte naquela UF
        const parecido = (outrasPorUf.get(uf) ?? []).some((o) => semAcentoMinusculo(o.produto).includes(chave));
        decisao = { decisao: parecido ? "ja_tem_outra_variante" : "lacuna", pares: 0, mediaPct: null, absPct: null };
      }
      decisoes.push({ produto: m.produto, uf, praças: pracas.length, ...decisao });
      if (UFS_FORCADAS.has(uf) && (decisao.decisao === "diverge" || decisao.decisao === "sem_como_comparar")) decisao = { ...decisao, decisao: "forcada" };
      if (decisao.decisao === "diverge") pulados.divergeDaFonteAtual += pracas.length;
      else if (decisao.decisao === "sem_como_comparar") pulados.semComoComparar += pracas.length;
      else if (decisao.decisao === "ja_tem_outra_variante") pulados.jaTemosOutraVariante += pracas.length;
      else {
        const escolhidas = escolherPracas(pracas, m.unificado ? (outrasPorProdutoUf.get(`${m.produto}|${uf}`) ?? []) : (outrasPorUf.get(uf) ?? []));
        for (const x of escolhidas) linhas.push({ produto: m.produto, uf, regiao: nomeDaPraca(x.cidade), nivel_comercializacao: "PRODUTOR", preco: x.preco, unidade: m.unidade, data_referencia: x.data, fonte: FONTE });
        porUf[uf] = (porUf[uf] ?? 0) + escolhidas.length;
      }
    }
  }
  const unicas = [...new Map(linhas.map((l) => [`${l.produto}|${l.uf}|${l.regiao}|${l.data_referencia}`, l])).values()];
  const resumo = {
    produtos: coletados.length,
    produtosComErro: coletados.filter((r) => r.erro).map((r) => `${r.nome}: ${r.erro}`),
    produtosIncompletos: coletados.filter((r) => !r.erro && !r.ok).map((r) => `${r.nome}: ${r.pracas.length}/${r.total}`),
    pracasLidas: coletados.reduce((a, r) => a + (r.pracas?.length ?? 0), 0),
    linhasParaGravar: unicas.length,
    pulados,
    gravandoPorUf: porUf,
    decisoes: decisoes.filter((d) => d.produto.includes("(60 kg)") || d.produto.includes("(15 kg)")).map((d) => `${d.produto} ${d.uf}: ${d.decisao}${d.mediaPct != null ? ` (média ${d.mediaPct}%, abs ${d.absPct}%, ${d.pares} praças em comum)` : ""}`),
    bloqueio: bloqueio?.message ?? null,
    minutos: Math.round((Date.now() - inicio) / 60_000),
  };
  console.log("\nRESUMO", JSON.stringify(resumo, null, 1));
  writeFileSync("coleta-b-snapshot.json", JSON.stringify({ resumo, coletados: coletados.map((r) => ({ nome: r.nome, total: r.total, erro: r.erro, pracas: r.pracas })) }));
  // cópia no storage (bucket marketing-temp) para diagnóstico: os artefatos do GitHub só abrem com login
  if (supabase) {
    const corpo = Buffer.from(JSON.stringify({ quando: new Date().toISOString(), resumo, coletados: coletados.map((r) => ({ nome: r.nome, total: r.total, erro: r.erro, pracas: r.pracas })) }));
    const { error } = await supabase.storage.from("marketing-temp").upload("coleta-b/snapshot.json", corpo, { upsert: true, contentType: "application/json" });
    if (error) console.log(`Aviso: snapshot não enviado ao storage (${error.message}).`);
  }

  if (!SO_LER) {
    for (let i = 0; i < unicas.length; i += 500) {
      const { error } = await supabase.from("precos").upsert(unicas.slice(i, i + 500), { onConflict: "produto,uf,regiao,data_referencia", ignoreDuplicates: true });
      if (error) throw new Error(`erro gravando: ${error.message}`);
    }
    console.log(`Gravadas até ${unicas.length} linhas (existentes não são sobrescritas).`);
  } else console.log("Modo só leitura: nada foi gravado.");
  if (bloqueio) {
    console.error(bloqueio.message);
    process.exit(2);
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("ingest-coleta-b.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
