// Editor "por cima": reescreve valores mantendo o visual idêntico (mesma fonte,
// tamanho, cor, alinhamento). Port de romaneio/editor.py + técnica dos spikes:
// redigir -> encapsular conteúdo original em Form XObject -> escrever texto novo
// em espaço identidade referenciando a MESMA fonte do PDF.
import * as mupdf from "mupdf";
import { parsePagina, salvarBytes } from "./pdf.js";
import { Linha, Romaneio } from "./model.js";
import { parseBR, formatBR, METODO_MEDIA_X_CAB } from "./calc.js";

export const CAMPOS_CABECALHO = ["romaneio", "ferro", "cidade", "fazendeiro", "municipio", "data_abate"];

// ---------- helpers ----------
function stripSubset(n) { return (n || "").replace(/^[A-Z]{6}\+/, ""); }
function escapePdf(t) { return t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function corToRgb(c) {
  if (!c || !c.length) return [0, 0, 0];
  if (c.length >= 3) return [c[0], c[1], c[2]];
  if (c.length === 1) return [c[0], c[0], c[0]];
  return [0, 0, 0];
}
function rectIntersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

// ---------- modelo lógico a partir da página parseada ----------
function romaneioDePagina(pag) {
  const linhas = pag.linhas.map((a, i) => new Linha({
    seq: i + 1,
    descricao: a.descricao ? a.descricao.texto : "",
    brutoH: a.bruto ? parseBR(a.bruto.texto) : 0,
    taraH: a.tara ? parseBR(a.tara.texto) : 0,
  }));
  return new Romaneio({ linhas, metodoTotalArroba: METODO_MEDIA_X_CAB });
}
const linhaEhGeral = (r) => r.rotulo.includes("Geral") || r.total_arroba != null;

// ---------- coleta de fontes do PDF (recursiva por XObjects) ----------
function coletarFontes(doc, pageObj) {
  const fontes = new Map();       // baseFont(sem subset) -> {ref, tipo, prog}
  const vistos = new Set();
  function scan(res) {
    if (!res || res.isNull()) return;
    const fd = res.get("Font");
    if (fd && !fd.isNull()) {
      const fdr = fd.resolve();
      fdr.forEach((v, k) => {
        const f = v.resolve();
        const bf = f.get("BaseFont");
        const nome = bf && !bf.isNull() ? stripSubset(bf.asName()) : null;
        if (nome && !fontes.has(nome)) fontes.set(nome, analisarFonte(f, fdr.get(k)));
      });
    }
    const xo = res.get("XObject");
    if (xo && !xo.isNull()) {
      xo.resolve().forEach((v) => {
        const x = v.resolve();
        const sub = x.get("Subtype");
        if (sub && sub.isName && sub.isName() && sub.asName() === "Form") {
          const key = x.asIndirect ? x.asIndirect() : Math.random();
          if (!vistos.has(key)) { vistos.add(key); scan(x.get("Resources")); }
        }
      });
    }
  }
  scan(pageObj.getInheritable("Resources"));
  return fontes;
}

function analisarFonte(f, ref) {
  const sub = f.get("Subtype").asName();
  if (sub === "Type0") {
    const enc = f.get("Encoding");
    const encName = enc.isName && enc.isName() ? enc.asName() : "";
    const df = f.get("DescendantFonts").get(0).resolve();
    const c2g = df.get("CIDToGIDMap");
    const c2gOk = c2g.isNull() || (c2g.isName && c2g.isName() && c2g.asName() === "Identity");
    const fdsc = df.get("FontDescriptor").resolve();
    let ff = fdsc.get("FontFile2");
    if (ff.isNull()) ff = fdsc.get("FontFile3");
    if (encName === "Identity-H" && c2gOk && ff && !ff.isNull()) {
      try {
        const prog = new mupdf.Font("emb", ff.readStream());
        return { ref, tipo: "type0", prog };
      } catch { /* cai no fallback */ }
    }
    return { ref, tipo: "type0-sem-prog", prog: null };
  }
  return { ref, tipo: "simple", prog: null }; // TrueType/Type1 simples (WinAnsi)
}

function acharFonte(fontes, fontName) {
  const n = stripSubset(fontName);
  if (fontes.has(n)) return fontes.get(n);
  for (const [k, v] of fontes) if (k === n || k.endsWith(n) || n.endsWith(k) || k.includes(n) || n.includes(k)) return v;
  return null;
}

// ---------- preparar uma edição (qual token, texto novo, fonte, posição) ----------
function prepararEdicao(palavras, yFlip, cellTexto, cellRect, novoValorOuTexto, alinhamento, fontes) {
  const dentro = palavras.filter((w) => rectIntersects([w.x0, w.y0, w.x1, w.y1], cellRect));
  if (!dentro.length) return null;

  let tokenRect, novoTexto, refX0, refX1, origLen, wEstilo;
  const esquerda = alinhamento === "esquerda";

  if (typeof novoValorOuTexto === "string") {
    tokenRect = [...cellRect];
    novoTexto = novoValorOuTexto;
    refX0 = cellRect[0]; refX1 = cellRect[2];
    origLen = Math.max(dentro.map((w) => w.texto).join("").length, 1);
    wEstilo = dentro.reduce((a, b) => (a.x0 <= b.x0 ? a : b));
  } else {
    const sufixo = cellTexto.endsWith("kg") ? "kg" : (cellTexto.endsWith("@") ? "@" : "");
    const unidades = dentro.filter((w) => ["kg", "@", "CB"].includes(w.texto));
    const numeros = dentro.filter((w) => !["kg", "@", "CB"].includes(w.texto));
    if (unidades.length && numeros.length) {
      const num = numeros.reduce((a, b) => (a.x1 >= b.x1 ? a : b));
      const un = unidades.reduce((a, b) => (a.x0 <= b.x0 ? a : b));
      if (un.x0 - num.x1 > 1.0) {
        tokenRect = [num.x0, num.y0, num.x1, num.y1];
        novoTexto = formatBR(novoValorOuTexto);
        refX0 = num.x0; refX1 = num.x1; origLen = Math.max(num.texto.length, 1); wEstilo = num;
      } else {
        tokenRect = [Math.min(num.x0, un.x0), Math.min(num.y0, un.y0), Math.max(num.x1, un.x1), Math.max(num.y1, un.y1)];
        novoTexto = formatBR(novoValorOuTexto) + sufixo;
        refX0 = num.x0; refX1 = un.x1; origLen = Math.max(num.texto.length + sufixo.length, 1); wEstilo = num;
      }
    } else {
      const tok = dentro.reduce((a, b) => (a.x1 >= b.x1 ? a : b));
      tokenRect = [tok.x0, tok.y0, tok.x1, tok.y1];
      novoTexto = formatBR(novoValorOuTexto) + sufixo;
      refX0 = tok.x0; refX1 = tok.x1; origLen = Math.max(tok.texto.length, 1); wEstilo = tok;
    }
  }

  const info = acharFonte(fontes, wEstilo.fontName);
  const size = wEstilo.size;
  const baselinePdf = yFlip - wEstilo.baseline;
  const cor = corToRgb(wEstilo.color);
  const cw = (refX1 - refX0) / origLen;

  // codificação + largura
  let mode, data, width;
  if (info && info.tipo === "type0" && info.prog) {
    let hex = "", w = 0, faltou = false;
    for (const ch of novoTexto) {
      const g = info.prog.encodeCharacter(ch.codePointAt(0));
      if (g === 0) faltou = true;
      hex += g.toString(16).padStart(4, "0");
      w += info.prog.advanceGlyph(g) * size;
    }
    if (!faltou) { mode = "hex"; data = hex; width = w; }
    else { mode = "text"; data = escapePdf(novoTexto); width = novoTexto.length * cw; } // fallback grosseiro
  } else {
    mode = "text"; data = escapePdf(novoTexto); width = novoTexto.length * cw;
  }

  const xStart = esquerda ? refX0 : (refX1 - width);
  return {
    tokenRect, ref: info ? info.ref : null, fontName: stripSubset(wEstilo.fontName),
    size, xStart, baselinePdf, cor, mode, data,
  };
}

// ---------- editar uma página ----------
function editarPagina(doc, page, pag, novosBrutosH, cabNovo) {
  const rom = romaneioDePagina(pag);
  const origBrutos = rom.linhas.map((l) => l.brutoH);
  const mudou = rom.linhas.map((l, i) =>
    i < novosBrutosH.length && novosBrutosH[i] != null && novosBrutosH[i] !== origBrutos[i]);
  mudou.forEach((m, i) => { if (m) rom.linhas[i].brutoH = novosBrutosH[i]; });
  const algumPeso = mudou.some(Boolean);

  const palavras = pag._palavras;                 // guardado no parse
  const po = page.getObject();
  const yFlip = page.getTransform()[5];
  const fontes = coletarFontes(doc, po);
  const edicoes = [];
  let n = 0;

  const add = (cell, valor, alinhamento = "direita") => {
    if (!cell) return;
    const e = prepararEdicao(palavras, yFlip, cell.texto, cell.rect, valor, alinhamento, fontes);
    if (e) edicoes.push(e);
  };

  pag.linhas.forEach((cel, i) => {
    if (mudou[i]) {
      const nova = rom.linhas[i];
      add(cel.bruto, nova.brutoH);
      add(cel.liquido, nova.liquidoH);
      add(cel.media, nova.mediaArrobaH);
      n += 1;
    }
  });

  if (algumPeso) {
    const grupos = new Map(rom.resumoPorDescricao().map((g) => [g.descricao, g]));
    const geral = rom.resumoGeral();
    for (const r of pag.resumo) {
      let grupo = linhaEhGeral(r) ? geral : null;
      if (!grupo) {
        for (const [desc, g] of grupos) {
          if (desc && (r.rotulo.includes(desc) || desc.includes(r.rotulo))) { grupo = g; break; }
        }
      }
      grupo = grupo || geral;
      add(r.liquido, grupo.totalLiquidoH);
      add(r.media_kg, grupo.mediaKgCabH);
      add(r.media_arroba, grupo.mediaArrobaH);
      add(r.total_arroba, grupo.totalArrobaH);
    }
  }

  for (const campo of Object.keys(cabNovo || {})) {
    const cel = pag.cabecalho[campo];
    const novo = cabNovo[campo];
    if (cel && novo != null && novo !== cel.texto) add(cel, String(novo), "esquerda");
  }

  if (!edicoes.length) return 0;

  // 1) redigir todos os tokens
  for (const e of edicoes) {
    const an = page.createAnnotation("Redact");
    an.setRect([e.tokenRect[0] - 0.5, e.tokenRect[1] - 0.6, e.tokenRect[2] + 0.5, e.tokenRect[3] + 0.6]);
  }
  page.applyRedactions(0, 0, 0);

  // 2) encapsular conteúdo (já redigido) num Form XObject
  const origRes = po.getInheritable("Resources");
  const bytes = contentBytes(po.get("Contents"));
  const formDict = doc.newDictionary();
  formDict.put("Type", doc.newName("XObject"));
  formDict.put("Subtype", doc.newName("Form"));
  formDict.put("FormType", 1);
  const mbox = po.getInheritable("MediaBox");
  const bbox = doc.newArray(); for (let i = 0; i < 4; i++) bbox.push(mbox.get(i).asNumber());
  formDict.put("BBox", bbox);
  formDict.put("Resources", origRes);
  const form = doc.addStream(bytes, formDict);

  // 3) recursos de página novos: Fm0 + fontes usadas nas edições
  const newRes = doc.newDictionary();
  const xdict = doc.newDictionary(); xdict.put("Fm0", form); newRes.put("XObject", xdict);
  const fdict = doc.newDictionary();
  const nomeRecurso = new Map(); // fontName -> Ex
  let idx = 0;
  for (const e of edicoes) {
    if (e.ref && !nomeRecurso.has(e.fontName)) {
      const rn = "Ex" + (idx++);
      nomeRecurso.set(e.fontName, rn);
      fdict.put(rn, e.ref);
    }
  }
  newRes.put("Font", fdict);
  po.put("Resources", newRes);

  // 4) novo /Contents: form isolado + textos novos
  let cs = "q /Fm0 Do Q\n";
  for (const e of edicoes) {
    if (!e.ref || !nomeRecurso.has(e.fontName)) continue;
    const rn = nomeRecurso.get(e.fontName);
    const [r, g, b] = e.cor;
    const glifos = e.mode === "hex" ? `<${e.data}>` : `(${e.data})`;
    cs += `q BT /${rn} ${e.size.toFixed(2)} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ` +
          `1 0 0 1 ${e.xStart.toFixed(2)} ${e.baselinePdf.toFixed(2)} Tm ${glifos} Tj ET Q\n`;
  }
  po.put("Contents", doc.addStream(new TextEncoder().encode(cs), {}));
  return n;
}

function contentBytes(obj) {
  if (obj.isArray()) {
    const parts = [];
    obj.forEach((s) => { parts.push(s.readStream().asUint8Array()); parts.push(new Uint8Array([10])); });
    let total = 0; parts.forEach((p) => (total += p.length));
    const out = new Uint8Array(total); let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }
  return obj.readStream().asUint8Array();
}

// ---------- API pública ----------
// edicoes: Map(indicePagina -> {brutosH:[..|null], cabecalho:{campo:texto}})
export function aplicarEdicoes(doc, edicoes) {
  const rel = { paginas: 0, linhasEditadas: 0 };
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const ed = edicoes.get(i);
    if (!ed) continue;
    const page = doc.loadPage(i);
    const pag = parsePagina(page, i); // já anexa pag._palavras
    if (!pag || !pag.linhas.length) continue;
    rel.paginas += 1;
    rel.linhasEditadas += editarPagina(doc, page, pag, ed.brutosH || [], ed.cabecalho || {});
  }
  return rel;
}

// ---------- separar por romaneio ----------
export function dividirPorRomaneio(doc) {
  const grupos = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const pag = parsePagina(doc.loadPage(i), i);
    const num = pag && pag.cabecalho.romaneio ? pag.cabecalho.romaneio.texto : null;
    if (grupos.length && num != null && grupos[grupos.length - 1].num === num) {
      grupos[grupos.length - 1].paginas.push(i);
    } else grupos.push({ num, paginas: [i] });
  }
  return grupos;
}

function rotuloArquivo(num, idx) {
  if (!num) return `parte${idx}`;
  const m = num.match(/RAA[\w-]*/);
  const base = m ? m[0] : num;
  return base.replace(/[^\w-]/g, "_").replace(/^_+|_+$/g, "") || `parte${idx}`;
}

/** Devolve [{num, rotulo, bytes}] — um PDF por romaneio (páginas consecutivas de mesmo nº juntas). */
export function separarDoc(doc) {
  const grupos = dividirPorRomaneio(doc);
  return grupos.map((g, idx) => {
    const novo = new mupdf.PDFDocument();
    g.paginas.forEach((p, k) => novo.graftPage(k, doc, p));
    return { num: g.num, rotulo: rotuloArquivo(g.num, idx + 1), bytes: salvarBytes(novo) };
  });
}

export function editarUniforme(doc, deltaH) {
  const edic = new Map();
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const pag = parsePagina(doc.loadPage(i), i);
    if (!pag || !pag.linhas.length) continue;
    const brutosH = pag.linhas.map((a) => (a.bruto ? parseBR(a.bruto.texto) + deltaH : null));
    edic.set(i, { brutosH, cabecalho: {} });
  }
  return aplicarEdicoes(doc, edic);
}
