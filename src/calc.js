// Núcleo de cálculo do Romaneio de Abate — port fiel de romaneio/calc.py.
// Pesos e valores são inteiros em CENTÉSIMOS (hundredths) de kg/@, reproduzindo
// o Decimal do Python com aritmética inteira exata.
//
// Regras (confirmadas com o Alessandro, verificadas nos 2 PDFs):
//  - 1 arroba (@) = 15 kg.
//  - Peso Líquido = Peso Bruto − Tara.
//  - Média @ (linha) = arredonda(Peso Líquido / 15).
//  - Resumo: Total Líq = Σ; Média kg/Cab = arredonda(TotalLíq/cab);
//            Média @ = arredonda(MédiaKgCab/15); Total @ = ver método.
//  - Arredondamento (regra do usuário): olha SÓ a 3ª casa decimal;
//    0–5 mantém (trunca em 2 casas), 6–9 sobe.

export const KG_POR_ARROBA = 15;
export const METODO_MEDIA_X_CAB = "media_x_cab";
export const METODO_DIV15 = "div15";

/** floor(a/b) exato para inteiros seguros (usa resto, sem erro de float). b>0. */
function floorDivPos(a, b) {
  const r = a % b;
  return (a - r) / b;
}

/**
 * arredonda2 sobre o racional numer/denom (denom>0), devolvendo CENTÉSIMOS (int).
 * Reproduz calc.py: milesimos=floor(valor*1000); 3ª casa 0–5 mantém, 6–9 sobe.
 */
export function arr2Ratio(numer, denom) {
  const neg = numer < 0;
  const a = neg ? -numer : numer;
  const milesimos = floorDivPos(a * 1000, denom);
  const terceira = milesimos % 10;
  let centesimos = (milesimos - terceira) / 10;
  if (terceira >= 6) centesimos += 1;
  return neg ? -centesimos : centesimos;
}

/** arredonda2 de um valor já em centésimos "com sobra" — usado só internamente. */
export function kgParaArrobaH(pesoH) {
  // @ = (pesoH/100) / 15 = pesoH/1500 ; devolve centésimos de @
  return arr2Ratio(pesoH, 1500);
}

// --- Total @ do resumo: duas variantes + detecção ---
export function totalArrobaMediaXCab(mediaArrobaH, cabecas) {
  return mediaArrobaH * cabecas; // média@ (2 casas) × cabeças = exato em centésimos
}
export function totalArrobaDiv15(totalLiquidoH) {
  return arr2Ratio(totalLiquidoH, 1500);
}
export function totalArroba(metodo, totalLiquidoH, mediaArrobaH, cabecas) {
  if (metodo === METODO_DIV15) return totalArrobaDiv15(totalLiquidoH);
  return totalArrobaMediaXCab(mediaArrobaH, cabecas);
}
export function detectarMetodoTotalArroba(totalLiquidoH, cabecas, mediaArrobaH, totalArrobaOriginalH) {
  if (totalArrobaOriginalH == null) return METODO_MEDIA_X_CAB;
  if (totalArrobaDiv15(totalLiquidoH) === totalArrobaOriginalH) return METODO_DIV15;
  if (totalArrobaMediaXCab(mediaArrobaH, cabecas) === totalArrobaOriginalH) return METODO_MEDIA_X_CAB;
  return METODO_MEDIA_X_CAB;
}

// --- Conversão texto BR <-> centésimos ---
/** "4.322,80kg" | "13,10@" | "22CB" -> inteiro em centésimos. */
export function parseBR(texto) {
  let t = String(texto).replace(/kg|@|CB/g, "").trim().replace(/\./g, "");
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1);
  const [i, d = "0"] = t.split(",");
  const dec = (d + "00").slice(0, 2);
  const h = parseInt(i || "0", 10) * 100 + parseInt(dec, 10);
  return neg ? -h : h;
}

/** centésimos -> "1.234,56" (formato BR). */
export function formatBR(h) {
  const neg = h < 0;
  const a = Math.abs(h);
  const dec = String(a % 100).padStart(2, "0");
  let intp = String(Math.floor(a / 100));
  let out = "";
  while (intp.length > 3) {
    out = "." + intp.slice(-3) + out;
    intp = intp.slice(0, -3);
  }
  out = intp + out;
  return (neg ? "-" : "") + out + "," + dec;
}
