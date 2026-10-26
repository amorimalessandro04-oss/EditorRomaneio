// Leitura + edição "por cima" de PDFs de Romaneio (SisAtak) usando MuPDF-WASM.
// Port de romaneio/pdf_io.py (parser) e romaneio/editor.py (editor), adaptado à
// API do mupdf.js e às 3 armadilhas descobertas nos spikes:
//  1) render só reflete mutações após salvar+reabrir;
//  2) o stream original deixa estado gráfico aberto -> encapsular em Form XObject;
//  3) baseline em PDF usa page.getTransform()[5] (topo do MediaBox), não a altura.
import * as mupdf from "mupdf";

// ---------------- Padrões ----------------
const RE_KG = /^\d{1,3}(?:\.\d{3})*,\d{2}kg$/;
const RE_NUM = /^\d{1,3}(?:\.\d{3})*,\d{2}@?$/;
const RE_HORA = /^\d{2}:\d{2}:\d{2}$/;
const RE_SEQ = /^\d{1,4}$/;
const RE_CB = /^\d+CB$/;
const RE_ALPHA = /^\p{L}+$/u;

// ---------------- Palavras (equivalente a get_text("words")) ----------------
// Cada palavra: {texto, x0,y0,x1,y1, size, baseline, fontName, color:[r,g,b]}
export function getWords(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const palavras = [];
  let atual = null;
  const flush = () => {
    if (atual && atual.texto.length) palavras.push(atual);
    atual = null;
  };
  st.walk({
    beginLine() { flush(); },
    endLine() { flush(); },
    endTextBlock() { flush(); },
    onChar(c, origin, font, size, quad, color) {
      if (/\s/.test(c)) { flush(); return; }
      const x0 = Math.min(quad[0], quad[4]);
      const y0 = Math.min(quad[1], quad[3]);
      const x1 = Math.max(quad[2], quad[6]);
      const y1 = Math.max(quad[5], quad[7]);
      if (atual === null) {
        atual = {
          texto: c, x0, y0, x1, y1,
          size, baseline: origin[1], fontName: font.getName(), color,
        };
      } else {
        atual.texto += c;
        atual.x0 = Math.min(atual.x0, x0); atual.y0 = Math.min(atual.y0, y0);
        atual.x1 = Math.max(atual.x1, x1); atual.y1 = Math.max(atual.y1, y1);
      }
    },
  });
  flush();
  for (const p of palavras) { p.cy = (p.y0 + p.y1) / 2; p.rect = [p.x0, p.y0, p.x1, p.y1]; }
  return palavras;
}

function agruparLinhas(palavras, tol = 3.0) {
  const linhas = [];
  const ord = [...palavras].sort((a, b) => (a.cy - b.cy) || (a.x0 - b.x0));
  for (const p of ord) {
    if (linhas.length && Math.abs(p.cy - linhas[linhas.length - 1][0].cy) <= tol) {
      linhas[linhas.length - 1].push(p);
    } else linhas.push([p]);
  }
  for (const ln of linhas) ln.sort((a, b) => a.x0 - b.x0);
  return linhas;
}

function mesclarUnidades(linha) {
  const ord = [...linha].sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const p of ord) {
    const ant = out[out.length - 1];
    if (ant && (p.texto === "kg" || p.texto === "@" || p.texto === "CB") &&
        (p.x0 - ant.x1) < 10.0 && /\d/.test(ant.texto)) {
      out[out.length - 1] = {
        ...ant, texto: ant.texto + p.texto,
        x0: ant.x0, y0: Math.min(ant.y0, p.y0), x1: p.x1, y1: Math.max(ant.y1, p.y1),
        rect: [ant.x0, Math.min(ant.y0, p.y0), p.x1, Math.max(ant.y1, p.y1)],
      };
    } else out.push(p);
  }
  return out;
}

function achar(palavras, texto) { return palavras.find((p) => p.texto === texto) || null; }

function coletarValor(linha, depoisDe, antesDe) {
  const sel = linha.filter((p) => depoisDe <= p.x0 && p.x0 < antesDe).sort((a, b) => a.x0 - b.x0);
  if (!sel.length) return null;
  return {
    texto: sel.map((p) => p.texto).join(" "),
    rect: [Math.min(...sel.map((p) => p.x0)), Math.min(...sel.map((p) => p.y0)),
           Math.max(...sel.map((p) => p.x1)), Math.max(...sel.map((p) => p.y1))],
  };
}

const linhaContem = (linha, alvo) => linha.some((p) => p.texto === alvo);

// ---------------- Parsing de uma página ----------------
export function parsePagina(page, indice) {
  const palavras = getWords(page);
  if (!palavras.length) return null;
  const linhas = agruparLinhas(palavras).map(mesclarUnidades);

  const pag = { indicePagina: indice, cabecalho: {}, linhas: [], resumo: [], _palavras: palavras };

  let idxCab = null, idxResumo = null;
  linhas.forEach((ln, i) => {
    if (idxCab === null && linhaContem(ln, "Bruto") && linhaContem(ln, "Tara")) idxCab = i;
    if (idxResumo === null && linhaContem(ln, "Resumo")) idxResumo = i;
  });
  if (idxCab === null) return null;

  const cab = linhas[idxCab];
  const x1de = (t) => { const p = achar(cab, t); return p ? p.x1 : null; };
  const anc = { bruto: x1de("Bruto"), tara: x1de("Tara"), liquido: x1de("Liq."), media: x1de("@") };

  parseCabecalho(linhas.slice(0, idxCab), pag);

  const fim = idxResumo !== null ? idxResumo : linhas.length;
  for (const ln of linhas.slice(idxCab + 1, fim)) {
    const animal = parseLinhaAnimal(ln, anc);
    if (animal) pag.linhas.push(animal);
  }
  if (idxResumo !== null) parseResumo(linhas.slice(idxResumo + 1), pag);
  return pag;
}

function parseCabecalho(linhasCab, pag) {
  const GRANDE = 1e9;
  for (const ln of linhasCab) {
    const rot = {};
    for (const p of [...ln].sort((a, b) => a.x0 - b.x0)) if (!(p.texto in rot)) rot[p.texto] = p;
    if ("Romaneio" in rot) {
      const lim = "Data" in rot ? rot["Data"].x0 : GRANDE;
      const c = coletarValor(ln, rot["Romaneio"].x1, lim);
      if (c) pag.cabecalho.romaneio = c;
      if ("Abate:" in rot) pag.cabecalho.data_abate = coletarValor(ln, rot["Abate:"].x1, GRANDE);
    }
    if ("Ferro:" in rot) {
      const lim = "Cod." in rot ? rot["Cod."].x0 : GRANDE;
      const c = coletarValor(ln, rot["Ferro:"].x1, lim);
      if (c) pag.cabecalho.ferro = c;
    }
    if ("Cidade:" in rot) pag.cabecalho.cidade = coletarValor(ln, rot["Cidade:"].x1, GRANDE);
    if ("Fazendeiro:" in rot) {
      const lim = "Município:" in rot ? rot["Município:"].x0 : GRANDE;
      const c = coletarValor(ln, rot["Fazendeiro:"].x1, lim);
      if (c) pag.cabecalho.fazendeiro = c;
      if ("Município:" in rot) pag.cabecalho.municipio = coletarValor(ln, rot["Município:"].x1, GRANDE);
    }
  }
}

function maisProxima(x1, ancoras) {
  let melhor = null, menor = 1e9;
  for (const [nome, ax] of Object.entries(ancoras)) {
    if (ax == null) continue;
    const d = Math.abs(x1 - ax);
    if (d < menor) { menor = d; melhor = nome; }
  }
  return menor <= 6.0 ? melhor : null;
}

function parseLinhaAnimal(ln, anc) {
  const kgs = ln.filter((p) => RE_KG.test(p.texto));
  const nums = ln.filter((p) => RE_NUM.test(p.texto) && !RE_KG.test(p.texto));
  if (!kgs.length) return null;
  const animal = { seq: null, hora: null, descricao: null, bruto: null, tara: null, liquido: null, media: null };
  const seqs = ln.filter((p) => RE_SEQ.test(p.texto));
  if (seqs.length) { const s = seqs.reduce((a, b) => (a.x0 <= b.x0 ? a : b)); animal.seq = { texto: s.texto, rect: s.rect }; }
  for (const p of ln) if (RE_HORA.test(p.texto)) { animal.hora = { texto: p.texto, rect: p.rect }; break; }
  const desc = ln.filter((p) => RE_ALPHA.test(p.texto)).sort((a, b) => a.x0 - b.x0);
  if (desc.length) animal.descricao = {
    texto: desc.map((p) => p.texto).join(" "),
    rect: [Math.min(...desc.map((p) => p.x0)), Math.min(...desc.map((p) => p.y0)),
           Math.max(...desc.map((p) => p.x1)), Math.max(...desc.map((p) => p.y1))],
  };
  for (const p of kgs) {
    const col = maisProxima(p.x1, { bruto: anc.bruto, tara: anc.tara, liquido: anc.liquido });
    if (col) animal[col] = { texto: p.texto, rect: p.rect };
  }
  for (const p of nums) if (anc.media != null && Math.abs(p.x1 - anc.media) <= 8.0) animal.media = { texto: p.texto, rect: p.rect };
  return animal;
}

function parseResumo(linhasRes, pag) {
  for (const ln of linhasRes) {
    const cbs = ln.filter((p) => RE_CB.test(p.texto));
    if (!cbs.length) continue;
    const res = { rotulo: "", cabecas: null, liquido: null, media_kg: null, media_arroba: null, total_arroba: null };
    const rotulos = ln.filter((p) => RE_ALPHA.test(p.texto) || p.texto === ":").sort((a, b) => a.x0 - b.x0);
    res.rotulo = rotulos.map((p) => p.texto).join(" ").replace(" :", ":").trim();
    res.cabecas = { texto: cbs[0].texto, rect: cbs[0].rect };
    const kgs = ln.filter((p) => RE_KG.test(p.texto));
    if (kgs.length) res.liquido = { texto: kgs[0].texto, rect: kgs[0].rect };
    const arrobas = ln.filter((p) => p.texto.endsWith("@")).sort((a, b) => a.x0 - b.x0);
    const planos = ln.filter((p) => RE_NUM.test(p.texto) && !p.texto.endsWith("@") && !RE_KG.test(p.texto)).sort((a, b) => a.x0 - b.x0);
    if (planos.length) res.media_kg = { texto: planos[0].texto, rect: planos[0].rect };
    if (arrobas.length >= 1) res.media_arroba = { texto: arrobas[0].texto, rect: arrobas[0].rect };
    if (arrobas.length >= 2) res.total_arroba = { texto: arrobas[1].texto, rect: arrobas[1].rect };
    pag.resumo.push(res);
  }
}

// ---------------- Carregar ----------------
export function abrirDoc(bytes) {
  return mupdf.PDFDocument.openDocument(bytes, "application/pdf");
}
/** Salva o doc e devolve uma cópia ESTÁVEL dos bytes (fora do heap WASM, que desanexa). */
export function salvarBytes(doc) {
  const buf = doc.saveToBuffer("");
  return new Uint8Array(buf.asUint8Array());
}
export function carregarPaginas(doc) {
  const out = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const pag = parsePagina(doc.loadPage(i), i);
    if (pag) out.push(pag);
  }
  return out;
}
