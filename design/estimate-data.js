// Deterministic sample estimates for the document viewer.
export const RATE = { DA: 430, LV: 24 };
const CAT = {
  kab: [['Kabel NOIKLX 3G1,5','m',0.06,9.8],['Kabel NOIKLX 3G2,5','m',0.07,13.4],['Kabel NOIKLX 5G2,5','m',0.09,21.9],['Kabel PFXP 5G10','m',0.14,88],['Kabelbakke 300 mm, galv.','m',0.30,212],['Kabelstige 500 mm','m',0.42,368],['Installationsrør 20 mm','m',0.05,6.2]],
  inst: [['Stikkontakt 2-stik m/jord, IP44','stk',0.45,148],['Stikkontakt 1-stik m/jord','stk',0.35,64],['Afbryder 1-polet, indbygning','stk',0.35,96],['Korrespondanceafbryder','stk',0.40,118],['Samledåse IP65','stk',0.20,38],['CEE-udtag 16A 5-polet','stk',0.60,285],['Gulvdåse 3×2 stik','stk',1.20,1240]],
  tav: [['Gruppetavle 12 moduler','stk',3.0,4200],['Fejlstrømsafbryder 4P 40A 30mA','stk',0.5,1185],['Automatsikring C16 1P','stk',0.15,62],['Automatsikring C32 3P','stk',0.25,310],['Overspændingsbeskyttelse type 2','stk',0.6,1480]],
  jord: [['Jordleder 16 mm²','m',0.08,22],['Potentialudligningsskinne','stk',1.0,380],['Jordspyd 1,5 m','stk',0.8,240]],
  svag: [['Datakabel Cat6A U/FTP','m',0.05,11.5],['Dataudtag 2×RJ45','stk',0.4,210],['Patchpanel 24 porte','stk',2.0,1650]],
  brand: [['Røgdetektor, adresserbar','stk',0.5,640],['Brandtryk, rød','stk',0.5,420],['Brandtætning, kabelgennemføring EI60','stk',0.4,185]],
  adg: [['Adgangskontrol, kortlæser','stk',1.5,2850],['Dørautomatik, tilslutning','stk',2.0,960]],
  lys: [['LED panel 60×60, 4000K','stk',0.6,412],['Downlight LED 12W','stk',0.4,265],['Lysbånd LED 1500 mm','stk',0.7,690],['Bevægelsessensor 360°','stk',0.5,520]],
  nod: [['Nødlysarmatur, flugtvej','stk',0.7,890],['Nødlys, antipanik','stk',0.6,760]],
  styr: [['Lysstyring DALI-modul','stk',1.0,1320],['DALI-kabel 2×1,5','m',0.05,8.4]],
  hov: [['Hovedtavle 400A','stk',24,86000],['Gruppetavle 24 moduler','stk',4.5,9800]],
  maal: [['Energimåler, MID','stk',1.0,1850],['Strømtransformer 400/5A','stk',0.5,640]],
  lvk: [['Kabelis NYM-J 3x1,5','m',0.06,0.62],['Kabelis NYM-J 3x2,5','m',0.07,0.94],['Kabeļu renes 200 mm','m',0.28,11.8],['Gofrētā caurule 20 mm','m',0.05,0.32]],
  lvi: [['Rozete divvietīga ar zemējumu, IP44','gab.',0.45,6.85],['Slēdzis 1-polīgs, zemapmetuma','gab.',0.35,3.85],['Sadales kārba IP65','gab.',0.20,2.3],['Kustības sensors 360°','gab.',0.5,39.9]],
  lvs: [['Sadalne 36 moduļi','gab.',6.0,640],['Automātslēdzis C16 1P','gab.',0.15,3.9],['Noplūdes strāvas slēdzis 4P 40A','gab.',0.5,54]],
  lvv: [['Datu kabelis Cat6 U/UTP','m',0.05,0.48],['Datu rozete 2xRJ45','gab.',0.4,9.6]],
};
const SPECS = {
  estimate: { lang: 'DA', seed: 11, priced: true, flags: true, sheets: [
    ['EL', [['1','Installationsmateriel','inst',50],['2','Gruppetavler','tav',40],['3','Kabler og kabelføring','kab',480],['4','Jord og potentialudligning','jord',242]]],
    ['ELT', [['1','Data og netværk','svag',120],['2','Brandalarm','brand',70],['3','Adgangskontrol','adg',46]]],
    ['Belysning', [['1','Almen belysning','lys',90],['2','Nødbelysning','nod',30],['3','Lysstyring','styr',22]]],
    ['Tavler', [['1','Hovedtavle','hov',30],['2','Måling','maal',28]]] ] },
  blank: { lang: 'DA', seed: 11, priced: false, sheets: null },
  datacenter: { lang: 'DA', seed: 7, priced: true, sheets: [
    ['EL', [['1','Installationsmateriel','inst',160],['2','Gruppetavler','tav',60],['3','Kabler og kabelføring','kab',420]]],
    ['ELT', [['1','Data og netværk','svag',80],['2','Brandalarm','brand',40]]],
    ['Belysning', [['1','Almen belysning','lys',70],['2','Nødbelysning','nod',26]]] ] },
  braila: { lang: 'LV', seed: 3, priced: true, sheets: [
    ['EL', [['1','Kabeļi','lvk',120],['2','Instalācijas izstrādājumi','lvi',140],['3','Sadales','lvs',40]]],
    ['ELT', [['1','Vājstrāvas','lvv',60]]] ] },
};
SPECS.blank.sheets = SPECS.estimate.sheets;
export const CATALOG = CAT;
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const WEB = ['lemu.dk', 'solar.dk', 'ao.dk', 'elektroimportoeren.dk'];
const cache = {};
export function getDoc(id) {
  if (cache[id]) return cache[id];
  const sp = SPECS[id]; if (!sp) return null;
  const R = rng(sp.seed), rate = RATE[sp.lang], lv = sp.lang === 'LV';
  const sheets = sp.sheets.map(([name, secs], si) => {
    const rows = []; let n = 2;
    secs.forEach(([sn, title, cat, len]) => {
      const items = CAT[cat]; const secStart = rows.length;
      rows.push({ n: n++, type: 'sec', nr: sn, d: title });
      let k = 0;
      for (let i = 0; i < len - 2; i++) {
        let it = items[Math.floor(R() * items.length)], sfx = true;
        if (id !== 'datacenter' && id !== 'braila' && name === 'EL' && n === 42) { it = CAT.inst[0]; sfx = false; }
        if (id !== 'datacenter' && id !== 'braila' && name === 'EL' && n === 58) { it = ['Gruppetavle 36 moduler','stk',6.0,14900]; sfx = false; }
        if (id !== 'datacenter' && id !== 'braila' && name === 'ELT' && n === 130) { it = ['Brandtætning, kabelgennemføring EI60','stk',0.4,0]; sfx = false; }
        const [d, u, norm, um] = it; k++;
        let q = u === 'm' ? Math.round((10 + R() * 590) / 5) * 5 : Math.max(1, Math.round(R() * (cat === 'hov' ? 1 : cat === 'tav' || cat === 'lvs' ? 10 : 60)));
        if (n === 42 && name === 'EL' && !lv) q = 80;
        if (n === 58 && name === 'EL' && !lv) q = 1;
        const loc = lv ? `, ${1 + Math.floor(R() * 3)}. stāvs` : u === 'm' ? `, føring plan ${1 + Math.floor(R() * 3)}` : `, rum ${1 + Math.floor(R() * 3)}.${String(1 + Math.floor(R() * 24)).padStart(2, '0')}`;
        const row = { n: n++, type: 'item', nr: `${sn}.${String(k).padStart(2, '0')}`, d: d + (sfx ? loc : ''), u, q, norm, sec: sn, secTitle: title };
        const r = R();
        let flag = null;
        if (sp.flags) { if (row.n === 42 && name === 'EL') flag = 'web'; else if (row.n === 58 && name === 'EL') flag = null; else if (um === 0) flag = 'none'; else if (r < 0.012) flag = 'web'; else if (r < 0.02) flag = 'att'; else if (r < 0.023) flag = 'man'; }
        row.flag = flag;
        if (sp.priced) {
          row.hrs = q * norm; row.lab = Math.round(row.hrs * rate * 100) / 100;
          row.um = um; row.mat = Math.round(q * um * 100) / 100; row.tot = row.lab + row.mat;
          row.conf = flag === 'att' ? 0.48 + R() * 0.15 : flag === 'none' ? 0.2 : flag === 'web' ? 0.7 + R() * 0.1 : 0.9 + R() * 0.09;
          row.ref = `data-center.xlsx · ${name} row ${40 + Math.floor(R() * 560)}`;
          row.psrc = flag === 'web' ? WEB[Math.floor(R() * WEB.length)] : flag === 'none' ? 'No price found' : row.ref;
          if (flag === 'att') row.reason = R() < 0.5 ? 'Quantity differs from the drawing count in the work list.' : 'Two reference rows match with different prices.';
          if (flag === 'none') row.reason = 'Not found in references or on supplier sites.';
          if (flag === 'man') row.reason = 'Changed by Mārtiņš Kalniņš, 10:58.';
        }
        rows.push(row);
      }
      const its = rows.slice(secStart + 1).filter(r => r.type === 'item');
      const sub = { n: n++, type: 'sub', nr: '', d: lv ? `Kopā ${sn}. ${title}` : `I alt ${sn} ${title}`, sec: sn };
      if (sp.priced) { sub.hrs = its.reduce((a, r) => a + r.hrs, 0); sub.lab = its.reduce((a, r) => a + r.lab, 0); sub.mat = its.reduce((a, r) => a + r.mat, 0); sub.tot = sub.lab + sub.mat; }
      rows.push(sub);
      rows.slice(secStart).forEach(r => { r.subRef = sub; });
    });
    const its = rows.filter(r => r.type === 'item');
    return { name, rows, items: its.length, lab: its.reduce((a, r) => a + (r.lab || 0), 0), mat: its.reduce((a, r) => a + (r.mat || 0), 0) };
  });
  const doc = { id, lang: sp.lang, priced: sp.priced, flags: !!sp.flags, rate, sheets, rows: sheets.reduce((a, s) => a + s.rows.length, 0), lab: sheets.reduce((a, s) => a + s.lab, 0), mat: sheets.reduce((a, s) => a + s.mat, 0) };
  cache[id] = doc; return doc;
}
