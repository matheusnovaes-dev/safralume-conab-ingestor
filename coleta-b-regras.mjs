/**
 * Regras (puras, testáveis) para decidir se o Fonte B pode ser a fonte principal de um produto/UF.
 *
 * Princípio: o Fonte B só entra no banco como principal onde ele CONCORDA com a fonte que já usamos (mesma definição de preço, diferença
 * pequena nas praças em comum) ou onde não temos dado nenhum. Onde diverge (ex.: PR e RS, 5 a 7% abaixo da BBM na soja), a fonte atual fica
 * até o Matheus decidir qual definição vale: trocar de uma para outra de um dia para o outro faria o preço "pular" e quebraria o sinal de
 * venda, a variação e os alertas de preço dos clientes. Como as linhas do Fonte B são as mais novas (diárias), o app, que sempre usa a data
 * mais recente, passa a mostrá-las sozinho; se o Fonte B parar de atualizar, a data mais nova volta a ser a das outras fontes (reserva).
 */
export const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
export const norm = (s) => semAcento(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();

/** "Sorriso / Lucas do Rio Verde" -> ["sorriso", "lucas do rio verde"]; "Paranaguá - PR (CIF Porto)" -> ["paranagua pr"] */
export function partesDaPraca(regiao) {
  return norm(regiao)
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}
export const ehPracaCif = (regiao) => /cif|porto/i.test(regiao ?? "");

export const LIMITES = {
  minimoDePares: 2, // praças em comum necessárias para comparar
  toleranciaDaMediaPct: 2.5, // |diferença média| máxima (praças em comum)
  toleranciaAbsolutaPct: 3.5, // diferença absoluta média máxima (praças em comum)
  toleranciaDaMediaDaUfPct: 3.0, // comparação pela média da UF (preço oficial do estado, ou poucas praças em comum): margem de 3%. Boi em MT no 1º lote: Fonte B -3,7% do Datagro, ficou de fora
};

/**
 * @param coleta-b [{ cidade, preco }] praças do Fonte B do produto/UF (dia mais recente de cada uma)
 * @param outras [{ regiao, preco, data_referencia }] linhas de OUTRAS fontes (mesmo produto/UF, últimos dias; a mais recente por praça)
 * @returns { decisao: "lacuna" | "concorda" | "diverge" | "sem_como_comparar", pares, mediaPct, absPct }
 */
export function compararComNossasFontes(coleta-b, outras) {
  const usaveis = (outras ?? []).filter((o) => !ehPracaCif(o.regiao) && Number.isFinite(o.preco) && o.preco > 0);
  if (usaveis.length === 0) return { decisao: "lacuna", pares: 0, mediaPct: null, absPct: null };
  const mediaAg = coleta-b.reduce((x, y) => x + y.preco, 0) / coleta-b.length;
  const arred = (n) => Math.round(n * 10) / 10;

  // 1) O que o app SERVE hoje: o preço do estado (fonte oficial: DERAL, EMATER, Conab...) quando está em dia (menos de 7 dias atrás do
  // regional); senão as praças. É contra ISSO que o Fonte B não pode "pular". Ex. real (26/10): soja no PR, DERAL R$ 132,86 (estado),
  // Fonte B R$ 135,15, BBM R$ 145 em só 3 praças: o servido é o da DERAL, e o Fonte B está +1,7% dele.
  const estado = usaveis.filter((o) => !o.regiao);
  const regionais = usaveis.filter((o) => o.regiao);
  const ultima = (xs) => xs.reduce((m, o) => (o.data_referencia > m ? o.data_referencia : m), "");
  const dif = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const estadoEmDia = estado.length > 0 && (regionais.length === 0 || dif(ultima(estado), ultima(regionais)) < 7);
  if (estadoEmDia) {
    const ref = estado.filter((o) => o.data_referencia === ultima(estado));
    const base = ref.reduce((x, o) => x + o.preco, 0) / ref.length;
    const pct = arred(((mediaAg - base) / base) * 100);
    return { decisao: Math.abs(pct) <= LIMITES.toleranciaDaMediaDaUfPct ? "concorda" : "diverge", pares: 0, mediaPct: pct, absPct: Math.abs(pct), baseline: "estado" };
  }

  // 2) O servido são as praças: compara as praças em comum (mesma definição, diferença pequena).
  const ultimaPorParte = new Map(); // parte normalizada da praça -> preço mais recente
  for (const o of [...regionais].sort((a, b) => a.data_referencia.localeCompare(b.data_referencia))) {
    for (const parte of partesDaPraca(o.regiao)) ultimaPorParte.set(parte, o.preco);
  }
  const difs = [];
  for (const a of coleta-b) {
    const ref = ultimaPorParte.get(norm(a.cidade));
    if (ref && Number.isFinite(a.preco)) difs.push(((a.preco - ref) / ref) * 100);
  }
  if (difs.length < LIMITES.minimoDePares) {
    // poucas praças em comum: confere pela média da UF; só aprova se estiver bem perto, senão segura.
    const ultimasPorRegiao = new Map();
    for (const o of [...regionais].sort((a, b) => a.data_referencia.localeCompare(b.data_referencia))) ultimasPorRegiao.set(o.regiao, o.preco);
    const precosOutras = [...ultimasPorRegiao.values()];
    if (precosOutras.length < 3) return { decisao: "sem_como_comparar", pares: difs.length, mediaPct: null, absPct: null, baseline: "praças" };
    const mediaOutras = precosOutras.reduce((x, y) => x + y, 0) / precosOutras.length;
    const pct = arred(((mediaAg - mediaOutras) / mediaOutras) * 100);
    const ok = Math.abs(pct) <= LIMITES.toleranciaDaMediaDaUfPct;
    return { decisao: ok ? "concorda" : "sem_como_comparar", pares: difs.length, mediaPct: pct, absPct: Math.abs(pct), pelaMediaDaUf: true, baseline: "praças" };
  }
  const mediaPct = difs.reduce((x, y) => x + y, 0) / difs.length;
  const absPct = difs.reduce((x, y) => x + Math.abs(y), 0) / difs.length;
  const concorda = Math.abs(mediaPct) <= LIMITES.toleranciaDaMediaPct && absPct <= LIMITES.toleranciaAbsolutaPct;
  return { decisao: concorda ? "concorda" : "diverge", pares: difs.length, mediaPct: arred(mediaPct), absPct: arred(absPct), baseline: "praças" };
}

// ---- praças de porto e densidade ----
/** Cidades-porto: o app só reconhece praça de porto pelo texto "CIF" no nome (convenção da BBM), então o Fonte B recebe o mesmo sufixo. */
const PORTOS = new Set(["paranagua", "rio grande", "santos", "sao francisco do sul", "itaqui", "sao luis", "barcarena", "santarem", "tubarao", "antonina", "imbituba", "cabedelo", "itajai", "aratu", "vitoria"]);
export const nomeDaPraca = (cidade) => (PORTOS.has(norm(cidade)) ? `${cidade} (CIF Porto)` : cidade);

/** No máximo K praças de interior por produto/UF/dia: as que casam com praças das outras fontes primeiro (continuidade), depois ordem de nome (estável). Portos entram à parte (até 2). */
export const MAX_PRACAS_POR_UF = 10;
export function escolherPracas(pracas, outras, k = MAX_PRACAS_POR_UF) {
  const conhecidas = new Set();
  for (const o of outras ?? []) for (const parte of partesDaPraca(o.regiao)) conhecidas.add(parte);
  const interior = pracas.filter((x) => !PORTOS.has(norm(x.cidade)));
  const portos = pracas.filter((x) => PORTOS.has(norm(x.cidade))).slice(0, 2);
  const ordenadas = [...interior].sort((a, b) => Number(conhecidas.has(norm(b.cidade))) - Number(conhecidas.has(norm(a.cidade))) || norm(a.cidade).localeCompare(norm(b.cidade)));
  return [...ordenadas.slice(0, k), ...portos];
}

// ---- grafia e itens que não entram ----
// O app acha o produto por texto COM acento (ilike '%maçã%', '%café%conillon%'); o Fonte B escreve alguns nomes sem acento ou de outro jeito.
const GRAFIA = [
  [/\bArabica\b/gi, "Arábica"], [/\bConilon\b/gi, "Conillon"], [/\bMaça\b/gi, "Maçã"], [/\bMaracuja\b/gi, "Maracujá"], [/\bAçucar\b/gi, "Açúcar"],
  [/\bPessego\b/gi, "Pêssego"], [/\bMelao\b/gi, "Melão"], [/\bAzevem\b/gi, "Azevém"], [/\bHavai\b/gi, "Havaí"], [/\bAlgodao\b/gi, "Algodão"],
  [/^Mel(?=\s+\d)/i, "Mel de Abelha"], [/^Cacau(?=\s+\d)/i, "Cacau"], [/\bFeijao\b/gi, "Feijão"], [/\bPimentao\b/gi, "Pimentão"], [/\bAbobora\b/gi, "Abóbora"], [/\bLimao\b/gi, "Limão"], [/\bMamao\b/gi, "Mamão"],
];
export const corrigirGrafia = (nome) => GRAFIA.reduce((n, [re, certo]) => n.replace(re, certo), String(nome));

/** Fora: atacado (não é preço ao produtor; tem tabela própria), leite (tem fonte e tratamento próprios) e etanol (combustível). */
export const ehProdutoIgnorado = (nome) => /atacado|^leite\b|etanol/i.test(String(nome).trim());
