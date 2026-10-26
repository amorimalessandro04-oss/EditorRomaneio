// Editor de Romaneio — app mobile (PWA offline). Usa o motor em src/ + MuPDF-WASM.
import * as mupdf from "mupdf";
import { abrirDoc, parsePagina, salvarBytes } from "./src/pdf.js";
import { aplicarEdicoes, separarDoc, dividirPorRomaneio, CAMPOS_CABECALHO } from "./src/editor.js";
import { Linha, Romaneio } from "./src/model.js";
import { parseBR, formatBR } from "./src/calc.js";

const ROTULOS = {
  romaneio: "Romaneio", ferro: "Ferro", cidade: "Cidade",
  fazendeiro: "Fazendeiro", municipio: "Município", data_abate: "Data de Abate",
};
const app = document.getElementById("app");
let state = null; // {nome, bytes, paginas:[{indice, romaneio, cab, temCampo}], aba}

// ============================ Biblioteca (IndexedDB) ============================
function abrirBanco() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("romaneios", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pdfs", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function bibSalvar(item) {
  const d = await abrirBanco();
  return new Promise((res, rej) => {
    const tx = d.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put(item);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function bibListar() {
  const d = await abrirBanco();
  return new Promise((res) => {
    const req = d.transaction("pdfs", "readonly").objectStore("pdfs").getAll();
    req.onsuccess = () => res((req.result || []).sort((a, b) => b.criadoEm - a.criadoEm));
  });
}
async function bibObter(id) {
  const d = await abrirBanco();
  return new Promise((res) => {
    const req = d.transaction("pdfs", "readonly").objectStore("pdfs").get(id);
    req.onsuccess = () => res(req.result);
  });
}
async function bibRemover(id) {
  const d = await abrirBanco();
  return new Promise((res) => {
    const tx = d.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").delete(id);
    tx.oncomplete = res;
  });
}

// ============================ Utilidades ============================
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function toast(msg) {
  const t = el(`<div class="toast">${msg}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
async function compartilhar(bytes, nome) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  try {
    const file = new File([blob], nome, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: nome });
      return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: nome });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6000);
}

// ============================ Modelo de tela por página ============================
function modeloDaPagina(pag) {
  const linhas = pag.linhas.map((a, i) => new Linha({
    seq: i + 1,
    hora: a.hora ? a.hora.texto : "",
    descricao: a.descricao ? a.descricao.texto : "",
    brutoH: a.bruto ? parseBR(a.bruto.texto) : 0,
    taraH: a.tara ? parseBR(a.tara.texto) : 0,
  }));
  const cab = {}, temCampo = {};
  for (const c of CAMPOS_CABECALHO) {
    cab[c] = pag.cabecalho[c] ? pag.cabecalho[c].texto : "";
    temCampo[c] = !!pag.cabecalho[c];
  }
  return { indice: pag.indicePagina, romaneio: new Romaneio({ linhas }), cab, temCampo };
}

function carregarPdf(nome, bytes) {
  const doc = abrirDoc(bytes);
  const paginas = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const pag = parsePagina(doc.loadPage(i), i);
    if (pag && pag.linhas.length) paginas.push(modeloDaPagina(pag));
  }
  if (!paginas.length) { toast("Este PDF não parece um Romaneio de Abate do SisAtak."); return false; }
  state = { nome, bytes, paginas, aba: 0 };
  telaEditor();
  return true;
}

// ============================ Tela: HOME ============================
async function telaHome() {
  state = null;
  const lista = await bibListar();
  app.innerHTML = "";
  app.appendChild(el(`
    <div class="topo"><h1>Editor de Romaneio</h1></div>
  `));
  const c = el(`<div class="conteudo"></div>`);
  c.appendChild(el(`
    <div class="abrir-area">
      <h2>Abrir um romaneio</h2>
      <p>Escolha um PDF de Romaneio de Abate (SisAtak) do seu celular.</p>
      <button class="btn-grande" id="btn-abrir">📄 Abrir PDF</button>
      <input type="file" id="file" accept="application/pdf,.pdf" hidden />
    </div>
  `));
  c.appendChild(el(`<div class="secao-titulo">Guardados no aparelho</div>`));
  const bib = el(`<div class="biblioteca"></div>`);
  if (!lista.length) bib.appendChild(el(`<div class="vazio">Nada guardado ainda. Os PDFs que você abrir ou exportar ficam aqui, mesmo sem internet.</div>`));
  for (const it of lista) {
    const data = new Date(it.criadoEm).toLocaleDateString("pt-BR");
    const item = el(`
      <div class="item-bib">
        <span class="icone">${it.editado ? "✏️" : "📄"}</span>
        <div class="info"><div class="nome">${it.nome}</div><div class="sub">${it.editado ? "editado · " : ""}${data}</div></div>
        <div class="acoes">
          <button class="icon-btn abrir">Abrir</button>
          <button class="icon-btn compart">⤴︎</button>
          <button class="icon-btn perigo apagar">🗑</button>
        </div>
      </div>`);
    item.querySelector(".abrir").onclick = () => carregarPdf(it.nome, it.bytes);
    item.querySelector(".compart").onclick = () => compartilhar(it.bytes, it.nome);
    item.querySelector(".apagar").onclick = async () => { await bibRemover(it.id); telaHome(); };
    bib.appendChild(item);
  }
  c.appendChild(bib);
  app.appendChild(c);

  const file = c.querySelector("#file");
  c.querySelector("#btn-abrir").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const nome = f.name;
    if (carregarPdf(nome, bytes)) {
      await bibSalvar({ id: "orig-" + Date.now(), nome, bytes, criadoEm: Date.now(), editado: false });
    }
  };
}

// ============================ Tela: EDITOR ============================
function telaEditor() {
  app.innerHTML = "";
  const topo = el(`<div class="topo"></div>`);
  const voltar = el(`<button class="voltar">‹</button>`);
  voltar.onclick = () => telaHome();
  topo.appendChild(voltar);
  topo.appendChild(el(`<h1>${state.nome}</h1>`));
  app.appendChild(topo);

  const c = el(`<div class="conteudo"></div>`);
  if (state.paginas.length > 1) {
    const abas = el(`<div class="abas"></div>`);
    state.paginas.forEach((p, i) => {
      const num = p.cab.romaneio || `Romaneio ${i + 1}`;
      const b = el(`<button class="aba ${i === state.aba ? "ativa" : ""}">${num}</button>`);
      b.onclick = () => { state.aba = i; telaEditor(); };
      abas.appendChild(b);
    });
    c.appendChild(abas);
  }
  c.appendChild(painelPagina(state.paginas[state.aba]));
  app.appendChild(c);

  const acoes = el(`<div class="acoes-fixas">
    <button class="previa">👁 Ver prévia</button>
    <button class="exportar">💾 Exportar PDF</button>
  </div>`);
  acoes.querySelector(".previa").onclick = () => verPrevia();
  acoes.querySelector(".exportar").onclick = () => exportar();
  app.appendChild(acoes);
}

function painelPagina(p) {
  const wrap = el(`<div></div>`);

  // --- cabeçalho editável ---
  const campos = el(`<div class="cartao"><h3>Cabeçalho</h3><div class="campos"></div></div>`);
  const grid = campos.querySelector(".campos");
  for (const campo of CAMPOS_CABECALHO) {
    if (!p.temCampo[campo]) continue;
    const largo = (campo === "fazendeiro");
    const f = el(`<div class="campo ${largo ? "largo" : ""}">
      <label>${ROTULOS[campo]}</label>
      <input type="text" value="${(p.cab[campo] || "").replace(/"/g, "&quot;")}" />
    </div>`);
    f.querySelector("input").oninput = (e) => { p.cab[campo] = e.target.value; };
    grid.appendChild(f);
  }
  wrap.appendChild(campos);

  // --- ajuste em massa ---
  const massa = el(`<div class="cartao"><h3>Ajustar peso de CADA animal</h3>
    <div class="massa">
      <input type="text" inputmode="decimal" placeholder="0,00" id="massa-val" />
      <span class="un">kg</span>
      <button class="tirar">− Tirar de cada</button>
      <button class="add">+ Adicionar a cada</button>
    </div>
    <div class="sub" style="color:var(--txt-fraco);font-size:.78rem;margin-top:8px">Aplica o mesmo valor no Peso Bruto de todos os ${p.romaneio.linhas.length} animais.</div>
  </div>`);
  const massaVal = massa.querySelector("#massa-val");
  const aplicarMassa = (sinal) => {
    const v = parseBR(massaVal.value || "0");
    if (!v) { toast("Digite um valor em kg."); return; }
    p.romaneio.ajustarPeso(sinal * v);
    massaVal.value = "";
    redesenharTabelaResumo(p, wrap);
    toast(`${sinal < 0 ? "Tirado" : "Adicionado"} ${formatBR(v)} kg de cada animal.`);
  };
  massa.querySelector(".tirar").onclick = () => aplicarMassa(-1);
  massa.querySelector(".add").onclick = () => aplicarMassa(1);
  wrap.appendChild(massa);

  // --- tabela + resumo (área redesenhável) ---
  const area = el(`<div class="area-tabela"></div>`);
  wrap.appendChild(area);
  desenharTabelaResumo(p, area);

  return wrap;
}

function redesenharTabelaResumo(p, wrap) {
  const area = wrap.querySelector(".area-tabela");
  area.innerHTML = "";
  desenharTabelaResumo(p, area);
}

function desenharTabelaResumo(p, area) {
  const linhas = p.romaneio.linhas;
  const tab = el(`<div class="cartao"><h3>Animais</h3>
    <div class="tabela-wrap"><table class="animais">
      <thead><tr>
        <th class="esq">Seq</th><th class="esq">Hora</th><th class="esq">Descrição</th>
        <th>Peso Bruto</th><th>Tara</th><th>Peso Líq.</th><th>Média @</th>
      </tr></thead><tbody></tbody>
    </table></div>
  </div>`);
  const tbody = tab.querySelector("tbody");
  linhas.forEach((l, i) => {
    const tr = el(`<tr>
      <td class="esq">${l.seq}</td>
      <td class="esq">${l.hora || ""}</td>
      <td class="esq">${l.descricao || ""}</td>
      <td><input type="text" inputmode="decimal" value="${formatBR(l.brutoH)}" /></td>
      <td class="calc">${formatBR(l.taraH)}</td>
      <td class="calc liq">${formatBR(l.liquidoH)}</td>
      <td class="calc med">${formatBR(l.mediaArrobaH)}</td>
    </tr>`);
    const inp = tr.querySelector("input");
    inp.oninput = () => {
      l.brutoH = parseBR(inp.value || "0");
      tr.querySelector(".liq").textContent = formatBR(l.liquidoH);
      tr.querySelector(".med").textContent = formatBR(l.mediaArrobaH);
      tr.classList.add("mudou");
      atualizarResumo(p, area);
    };
    inp.onblur = () => { inp.value = formatBR(l.brutoH); };
    tbody.appendChild(tr);
  });
  area.appendChild(tab);

  const resumo = el(`<div class="cartao"><h3>Resumo</h3><div class="resumo"></div></div>`);
  area.appendChild(resumo);
  atualizarResumo(p, area);
}

function atualizarResumo(p, area) {
  const g = p.romaneio.resumoGeral();
  const box = area.querySelector(".resumo");
  box.innerHTML = `
    <div class="box"><div class="rot">Cabeças</div><div class="val">${g.cabecas}</div></div>
    <div class="box"><div class="rot">Total Líq.</div><div class="val">${formatBR(g.totalLiquidoH)}</div></div>
    <div class="box"><div class="rot">Média kg/Cab</div><div class="val">${formatBR(g.mediaKgCabH)}</div></div>
    <div class="box"><div class="rot">Média @</div><div class="val">${formatBR(g.mediaArrobaH)}</div></div>
    <div class="box"><div class="rot">Total @</div><div class="val">${formatBR(g.totalArrobaH)}</div></div>`;
}

// ============================ Exportar / Prévia ============================
function coletarEdicoes() {
  const edic = new Map();
  for (const p of state.paginas) {
    const cab = {};
    for (const c of CAMPOS_CABECALHO) if (p.temCampo[c]) cab[c] = p.cab[c];
    edic.set(p.indice, { brutosH: p.romaneio.linhas.map((l) => l.brutoH), cabecalho: cab });
  }
  return edic;
}

function docEditado() {
  const doc = abrirDoc(state.bytes);
  aplicarEdicoes(doc, coletarEdicoes());
  return doc;
}

function verPrevia() {
  const overlay = modal("Gerando prévia…", el(`<div style="text-align:center;padding:20px"><div class="spinner"></div></div>`));
  setTimeout(() => {
    try {
      const doc = docEditado();
      const page = doc.loadPage(state.paginas[state.aba].indice);
      const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
      const blob = new Blob([pix.asPNG()], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      overlay.remove();
      const img = el(`<div><h3>Prévia (idêntica ao PDF)</h3><img class="previa-img" src="${url}" /></div>`);
      const m = modal(null, img);
      m.addEventListener("remove", () => URL.revokeObjectURL(url), { once: true });
    } catch (e) {
      overlay.remove();
      toast("Não consegui gerar a prévia: " + e.message);
    }
  }, 30);
}

function nomeBase() { return state.nome.replace(/\.pdf$/i, ""); }

async function exportar() {
  const grupos = dividirPorRomaneio(abrirDoc(state.bytes));
  const conteudo = el(`<div><h3>Exportar</h3><div class="opcoes"></div></div>`);
  const ops = conteudo.querySelector(".opcoes");

  const btnJunto = el(`<button><b>Salvar tudo junto</b><small>Um PDF com ${grupos.length > 1 ? "todos os romaneios" : "o romaneio"}.</small></button>`);
  btnJunto.onclick = () => { fechaModais(); fazerExport(false); };
  ops.appendChild(btnJunto);

  if (grupos.length > 1) {
    const btnSep = el(`<button><b>Separar por romaneio</b><small>Gera ${grupos.length} arquivos (um por romaneio), guardados no aparelho.</small></button>`);
    btnSep.onclick = () => { fechaModais(); fazerExport(true); };
    ops.appendChild(btnSep);
  }
  const m = modal(null, conteudo);
  m.appendChild(el(`<button class="fechar">Cancelar</button>`));
  m.querySelector(".fechar").onclick = () => fechaModais();
}

async function fazerExport(separar) {
  const carregando = modal("Gerando PDF…", el(`<div style="text-align:center;padding:20px"><div class="spinner"></div></div>`));
  await new Promise((r) => setTimeout(r, 30));
  try {
    const doc = docEditado();
    if (separar) {
      const partes = separarDoc(doc);
      for (const parte of partes) {
        await bibSalvar({ id: "sep-" + Date.now() + "-" + parte.rotulo, nome: `${nomeBase()}_${parte.rotulo}.pdf`, bytes: parte.bytes, criadoEm: Date.now(), editado: true });
      }
      carregando.remove();
      toast(`${partes.length} romaneios salvos no aparelho.`);
      telaHome();
    } else {
      const bytes = salvarBytes(doc);
      const nome = `${nomeBase()}_editado.pdf`;
      await bibSalvar({ id: "edit-" + Date.now(), nome, bytes, criadoEm: Date.now(), editado: true });
      carregando.remove();
      await compartilhar(bytes, nome);
      toast("PDF exportado e guardado no aparelho.");
    }
  } catch (e) {
    carregando.remove();
    toast("Erro ao exportar: " + e.message);
  }
}

// ============================ Modal ============================
function modal(titulo, conteudo) {
  const bg = el(`<div class="modal-bg"></div>`);
  const m = el(`<div class="modal"></div>`);
  if (titulo) m.appendChild(el(`<h3>${titulo}</h3>`));
  m.appendChild(conteudo);
  bg.appendChild(m);
  bg.onclick = (e) => { if (e.target === bg) fechaModais(); };
  document.body.appendChild(bg);
  // permite listeners de "remove"
  const origRemove = bg.remove.bind(bg);
  bg.remove = () => { bg.dispatchEvent(new Event("remove")); origRemove(); };
  return bg;
}
function fechaModais() { document.querySelectorAll(".modal-bg").forEach((m) => m.remove()); }

// ============================ Início ============================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
telaHome();
