// Processo isolado só pra extrair a manchete via pdfjs-dist — roda separado
// do ingest-imea.mjs de propósito: o `pdf-parse` (usado lá pra extrair a
// tabela de indicadores) carrega sua PRÓPRIA cópia interna do pdfjs-dist com
// a versão do worker fixada no pacote publicado, e colide com a cópia daqui
// não importa a ordem ou deduplicação de node_modules — só rodar em
// processos separados resolve de vez.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

async function acharManchete(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), disableWorker: true }).promise;
  if (doc.numPages < 2) return null;
  const page = await doc.getPage(2);
  const content = await page.getTextContent();

  const linhas = [];
  for (const it of content.items) {
    if (!it.str.trim()) continue;
    const y = it.transform[5];
    let linha = linhas.find((l) => Math.abs(l.y - y) < 2);
    if (!linha) {
      linha = { y, itens: [] };
      linhas.push(linha);
    }
    linha.itens.push(it);
  }
  for (const l of linhas) {
    l.itens.sort((a, b) => a.transform[4] - b.transform[4]);
    l.texto = l.itens.map((i) => i.str).join("");
    l.tamFonte = Math.max(...l.itens.map((i) => Math.abs(i.transform[0])));
  }

  const candidatas = linhas
    .filter((l) => l.tamFonte >= 14)
    .filter((l) => /[a-zà-úA-ZÀ-Ú]/.test(l.texto))
    .filter((l) => {
      const letras = (l.texto.match(/[a-zà-úA-ZÀ-Ú]/g) ?? []).length;
      const digitos = (l.texto.match(/\d/g) ?? []).length;
      return digitos <= letras;
    })
    .filter((l) => /^[A-ZÀ-Ú]/.test(l.texto.trim()))
    .filter((l) => l.texto.trim().length >= 8 && l.texto.trim().length <= 80)
    .sort((a, b) => b.tamFonte - a.tamFonte);

  return candidatas[0]?.texto.trim() ?? null;
}

const caminhoPdf = process.argv[2];
if (!caminhoPdf) {
  console.error("Uso: manchete-worker.mjs <caminho-do-pdf>");
  process.exit(1);
}
const buf = await Bun.file(caminhoPdf).arrayBuffer();
const manchete = await acharManchete(Buffer.from(buf)).catch((err) => {
  console.error("ERRO:", err.message);
  return null;
});
// stdout só a manchete (ou vazio) — stderr fica com log/erro, pra não
// misturar com o resultado que o processo pai vai ler.
process.stdout.write(manchete ?? "");
