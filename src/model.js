// Modelo de dados do Romaneio — port de romaneio/model.py.
// Todos os pesos/valores em CENTÉSIMOS (inteiros). Ver calc.js.

import {
  KG_POR_ARROBA, METODO_MEDIA_X_CAB,
  arr2Ratio, kgParaArrobaH, totalArroba,
} from "./calc.js";

export class Linha {
  constructor({ seq, descricao, brutoH, taraH, hora = "" }) {
    this.seq = seq;
    this.descricao = descricao;
    this.brutoH = brutoH;   // centésimos
    this.taraH = taraH;     // centésimos
    this.hora = hora;
  }
  get liquidoH() { return this.brutoH - this.taraH; }
  get mediaArrobaH() { return kgParaArrobaH(this.liquidoH); }
}

export class ResumoGrupo {
  constructor(descricao, cabecas, totalLiquidoH, mediaKgCabH, mediaArrobaH, totalArrobaH) {
    this.descricao = descricao;
    this.cabecas = cabecas;
    this.totalLiquidoH = totalLiquidoH;
    this.mediaKgCabH = mediaKgCabH;
    this.mediaArrobaH = mediaArrobaH;
    this.totalArrobaH = totalArrobaH;
  }
}

export class Romaneio {
  constructor({ linhas = [], metodoTotalArroba = METODO_MEDIA_X_CAB, cabecalho = {} } = {}) {
    this.linhas = linhas;
    this.metodoTotalArroba = metodoTotalArroba;
    // cabeçalho editável: {romaneio, ferro, cod_ferro, fazendeiro, cidade, municipio, data_abate}
    this.cabecalho = cabecalho;
  }

  /** Soma deltaH (centésimos) ao Peso Bruto de CADA animal. */
  ajustarPeso(deltaH) {
    for (const l of this.linhas) l.brutoH += deltaH;
  }

  get totalLiquidoH() {
    let s = 0;
    for (const l of this.linhas) s += l.liquidoH;
    return s;
  }

  resumoPorDescricao() {
    const grupos = new Map();
    const ordem = [];
    for (const l of this.linhas) {
      if (!grupos.has(l.descricao)) { grupos.set(l.descricao, []); ordem.push(l.descricao); }
      grupos.get(l.descricao).push(l);
    }
    return ordem.map((desc) => this._resumir(desc, grupos.get(desc)));
  }

  resumoGeral() { return this._resumir("Total Geral", this.linhas); }

  _resumir(descricao, linhas) {
    const cabecas = linhas.length;
    let totalLiq = 0;
    for (const l of linhas) totalLiq += l.liquidoH;
    if (cabecas === 0) return new ResumoGrupo(descricao, 0, 0, 0, 0, 0);
    const mediaKg = arr2Ratio(totalLiq, 100 * cabecas);
    const mediaArr = arr2Ratio(mediaKg, 1500);
    const totalArr = totalArroba(this.metodoTotalArroba, totalLiq, mediaArr, cabecas);
    return new ResumoGrupo(descricao, cabecas, totalLiq, mediaKg, mediaArr, totalArr);
  }
}
