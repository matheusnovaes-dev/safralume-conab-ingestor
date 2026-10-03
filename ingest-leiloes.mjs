import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run (não grava nada).");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Agenda de leilões de gado, achado 2026-10-02. Fonte: ArrobaPlay
// (arrobaplay.com.br) — agregador de leilões de pecuária com transmissão ao
// vivo (Canal do Boi, AgroCanal), HTML server-rendered (sem precisar de
// browser), sem login. Cobre leilão de genética/reprodutores majoritariamente
// (não achamos fonte estruturada pra leilão comercial de boi gordo em si) —
// mas é agenda real, com local/data/hora/leiloeira confirmados.
const BASE = "https://www.arrobaplay.com.br";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const MESES = {
  janeiro: 1, fevereiro: 2, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function decodificarEntidades(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&#8203;/g, "");
}

async function buscarHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} buscando ${url}`);
  return res.text();
}

/** Extrai os cards da listagem /leiloes — cada <a class="auction-card"
 * href="/leiloes/SLUG">...</a> vira um candidato, com o status (ao vivo /
 * em breve) vindo do texto do badge. */
function extrairCardsDaListagem(html) {
  const cards = [];
  const regexCard = /<a href="(\/leiloes\/[^"]+)" class="auction-card">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = regexCard.exec(html))) {
    const [, href, bloco] = m;
    const statusMatch = bloco.match(/card-badge[^>]*>([^<]+)</);
    cards.push({
      slug: href,
      status: statusMatch ? decodificarEntidades(statusMatch[1]).trim() : null,
    });
  }
  return cards;
}

/** Extrai os campos estruturados da página de detalhe de um leilão. */
function extrairDetalhe(html) {
  const titulo = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
  // "sábado, 10/outubro/2026 - 14:00"
  const dataMatch = html.match(
    /<span style="text-transform: capitalize;">([^,]+),\s*(\d{1,2})\/([a-zç]+)\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})<\/span>/i,
  );
  // Local vem logo depois, no mesmo bloco de ícones (ícone de pin -> <span>...</span>)
  const localMatch = html.match(
    /<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"><\/path>\s*<circle[^>]*><\/circle>\s*<\/svg>\s*<span>([^<]+)<\/span>/,
  );
  const leiloeiraMatch = html.match(/Leiloeira\s*<\/div>\s*<div[^>]*>([^<]+)<\/div>/);
  const telefoneMatch = html.match(/href="https:\/\/wa\.me\/(\d+)"/);
  const websiteMatch = html.match(
    /<a href="(https?:\/\/(?!wa\.me)[^"]+)"[^>]*target="_blank"[^>]*>\s*<svg[^>]*>\s*<circle cx="12" cy="12" r="10">/,
  );
  const canalMatch = html.match(/upload\/canais\/([^-."]+)/);
  // Bloco "Oferta" (o que vai ser leiloado) — texto livre do leiloeiro,
  // às vezes já vem com a quantidade (ex: "OFERTA DE 200 TOUROS CEIP"),
  // às vezes só raça/categoria (ex: "OFERTA DE TOUROS NELORE PO"). A seção
  // "Lotes" (lote a lote) existe no HTML mas testamos em várias páginas e
  // vem sempre vazia — não dá pra contar com ela.
  const ofertaMatch = html.match(/Oferta\s*<\/h2>\s*<p[^>]*>([^<]+)<\/p>/);

  let dataHora = null;
  if (dataMatch) {
    const [, , dia, mesNome, ano, hora, minuto] = dataMatch;
    const mes = MESES[decodificarEntidades(mesNome).toLowerCase()];
    if (mes) {
      dataHora = new Date(
        Date.UTC(Number(ano), mes - 1, Number(dia), Number(hora) + 3, Number(minuto)),
      ).toISOString();
    }
  }

  let municipio = null;
  let uf = null;
  const localTexto = localMatch ? decodificarEntidades(localMatch[1]).trim() : null;
  if (localTexto) {
    const ufMatch = localTexto.match(/\/([A-Z]{2})\s*$/);
    if (ufMatch) {
      uf = ufMatch[1];
      municipio = localTexto.slice(0, ufMatch.index).replace(/[-–]\s*$/, "").trim();
    }
  }

  return {
    titulo: titulo ? decodificarEntidades(titulo).trim() : null,
    data_hora: dataHora,
    local_texto: localTexto,
    municipio,
    uf,
    leiloeira: leiloeiraMatch ? decodificarEntidades(leiloeiraMatch[1]).trim() : null,
    telefone_leiloeira: telefoneMatch ? telefoneMatch[1] : null,
    website_leiloeira: websiteMatch ? websiteMatch[1] : null,
    canal_transmissao: canalMatch ? canalMatch[1] : null,
    oferta: ofertaMatch ? decodificarEntidades(ofertaMatch[1]).trim() : null,
  };
}

async function run() {
  console.log("Buscando listagem de leilões...");
  const htmlListagem = await buscarHtml(`${BASE}/leiloes`);
  const cards = extrairCardsDaListagem(htmlListagem);
  console.log(`${cards.length} leilões encontrados na listagem.`);

  const linhas = [];
  for (const card of cards) {
    const url = `${BASE}${card.slug}`;
    try {
      const htmlDetalhe = await buscarHtml(url);
      const detalhe = extrairDetalhe(htmlDetalhe);
      if (!detalhe.titulo) {
        console.log(`  aviso: não achei título em ${url}, pulando.`);
        continue;
      }
      linhas.push({
        titulo: detalhe.titulo,
        data_hora: detalhe.data_hora,
        local_texto: detalhe.local_texto,
        municipio: detalhe.municipio,
        uf: detalhe.uf,
        leiloeira: detalhe.leiloeira,
        telefone_leiloeira: detalhe.telefone_leiloeira,
        website_leiloeira: detalhe.website_leiloeira,
        canal_transmissao: detalhe.canal_transmissao,
        oferta: detalhe.oferta,
        status: card.status,
        url,
        fonte: "ArrobaPlay",
      });
      console.log(`  ok: ${detalhe.titulo} — ${detalhe.uf ?? "?"} — ${detalhe.data_hora ?? "sem data"}`);
    } catch (err) {
      console.log(`  erro em ${url}:`, err.message);
    }
  }

  console.log(`Total processado: ${linhas.length} leilões.`);

  if (linhas.length === 0) {
    console.log("Nada pra gravar.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — amostra:");
    console.log(JSON.stringify(linhas.slice(0, 5), null, 2));
    return;
  }

  console.log("Gravando no projeto Supabase:", new URL(SUPABASE_URL).host);
  const { error } = await supabase
    .from("leiloes_agendados")
    .upsert(
      linhas.map((l) => ({ ...l, updated_at: new Date().toISOString() })),
      { onConflict: "url" },
    );
  if (error) {
    console.error("Erro ao gravar:", error);
    process.exit(1);
  }
  console.log("OK. Linhas gravadas:", linhas.length);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
