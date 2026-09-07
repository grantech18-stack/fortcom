/* =========================================================================
   FORTCOM — Suite de verificação automatizada (jsdom)
   -------------------------------------------------------------------------
   Carrega o index.html REAL num DOM simulado, com stub de Firebase
   (Auth + Firestore em memória), e executa os fluxos do app de verdade:
   boot, PIN, login de nuvem, sync entre 2 aparelhos, exclusão de semana,
   import de backup legado, valores em formato BR, XSS, etc.

   OBS: o estado do app vive em `let obras/currentWeekId/...` no escopo
   léxico do <script> (não em window). Por isso as leituras/escritas de
   estado passam por window.eval(), que enxerga esse escopo.

   Rodar:  cd testes && npm install && npm test
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const SW_PATH = path.join(__dirname, '..', 'sw.js');
const SRC = fs.readFileSync(HTML_PATH, 'utf8');
const SW_SRC = fs.readFileSync(SW_PATH, 'utf8');

let okCount = 0, failCount = 0;
const falhas = [];

function ok(nome, cond, detalhe) {
  if (cond) { okCount++; console.log('  \x1b[32mPASS\x1b[0m  ' + nome); }
  else {
    failCount++;
    falhas.push(nome + (detalhe ? '  ->  ' + detalhe : ''));
    console.log('  \x1b[31mFAIL\x1b[0m  ' + nome + (detalhe ? '\n          -> ' + detalhe : ''));
  }
}
function grupo(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const espera = ms => new Promise(r => setTimeout(r, ms));
// o TypeError do focus do PIN (item 1.9) tem verificação própria; não deve
// contaminar as demais asserções de "nenhum erro de JS"
const ehErroFocoPin = e => /reading 'focus'/.test(e) && /pinInput|setTimeout|_onTimeout/.test(e);
const errosReais = w => w.__erros.filter(e => !ehErroFocoPin(e));
const resumo = a => (a.length ? a.join(' | ').slice(0, 400) : '');
const quase = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

/* ---------- stub do Firebase (Auth + Firestore em memória) ---------- */
function criarStubFirebase(docCompartilhado, opts = {}) {
  // a lista de ouvintes fica no documento compartilhado: é o que faz os
  // "aparelhos" se enxergarem (como os listeners reais do Firestore)
  if (!docCompartilhado._ouv) docCompartilhado._ouv = [];
  const ouvintes = docCompartilhado._ouv;
  const auth = {
    currentUser: opts.jaLogado ? { uid: 'u1', email: 'dono@fortcom.com.br' } : null,
    signInWithEmailAndPassword(email, senha) {
      if (senha === 'errada') {
        const e = new Error('invalid'); e.code = 'auth/invalid-credential';
        return Promise.reject(e);
      }
      this.currentUser = { uid: 'u1', email };
      return Promise.resolve(this.currentUser);
    },
    // como no SDK real: o estado chega de forma assíncrona (restaurado do IndexedDB)
    onAuthStateChanged(cb) { setTimeout(() => { try { cb(this.currentUser); } catch (e) { } }, 20); return () => { }; }
  };
  const offline = () => opts.window && opts.window.navigator && opts.window.navigator.onLine === false;
  const semRede = () => { const e = new Error('unavailable'); e.code = 'unavailable'; return e; };
  const notificar = () => setTimeout(() => ouvintes.forEach(cb => { try { cb(doc); } catch (e) { } }), 0);
  const doc = {
    get exists() { return docCompartilhado.v !== null; },
    data() { return docCompartilhado.v; },
    set(d) {
      // sem internet a escrita falha, como no aparelho real
      if (offline()) return Promise.reject(semRede());
      docCompartilhado.v = d;
      notificar();
      return Promise.resolve();
    },
    onSnapshot(_o, cb, _err) {
      ouvintes.push(cb);
      setTimeout(() => { try { cb(doc); } catch (e) { } }, 0);
      return () => { };
    }
  };
  const stubFirebase = {
    __auth: auth, apps: [],
    auth() {
      // SDK real: firebase.auth() lança enquanto initializeApp não rodou
      if (!this.apps.length) { const e = new Error('No Firebase App'); e.code = 'app/no-app'; throw e; }
      return auth;
    },
    initializeApp() { this.apps.push({}); },
    firestore: () => ({
      enablePersistence: () => Promise.resolve(),
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => doc }) }) }),
      // transação: lê o documento ATUAL, aplica a escrita de forma atômica;
      // offline falha (o SDK real não completa transação sem servidor)
      runTransaction(fn) {
        if (offline()) return Promise.reject(semRede());
        let escrita = null;
        const t = {
          get: d => Promise.resolve({ exists: d.exists, data: () => d.data() }),
          set: (d, val) => { escrita = val; }
        };
        return Promise.resolve().then(() => fn(t)).then(r => {
          if (offline()) throw semRede();
          if (escrita) { docCompartilhado.v = escrita; notificar(); }
          return r;
        });
      }
    })
  };
  return stubFirebase;
}

/* ---------- abre o app num jsdom ---------- */
async function abrirApp(opts = {}) {
  const erros = [];
  const avisos = [];
  const vc = new VirtualConsole();
  // jsdom não implementa <canvas>; esse aviso é do ambiente de teste, não do
  // app (o stub abaixo fornece um 2D context falso para os gráficos).
  const ehRuidoCanvas = s => /Not implemented: HTMLCanvasElement/.test(s);
  vc.on('jsdomError', e => { const s = e.stack || e.message; if (!ehRuidoCanvas(s)) erros.push(s); });
  vc.on('error', (...a) => { const s = a.join(' '); if (!ehRuidoCanvas(s)) erros.push(s); });
  vc.on('warn', (...a) => avisos.push(a.join(' ')));

  const dom = new JSDOM(SRC, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/fortcom/',
    virtualConsole: vc,
    beforeParse(window) {
      Object.assign(window, {
        confirm: () => (opts.confirm === undefined ? true : opts.confirm),
        alert: () => { },
        prompt: () => (opts.promptRespostas ? opts.promptRespostas.shift() : null),
        print: () => { },
        scrollTo: () => { }
      });
      if (!window.matchMedia) {
        window.matchMedia = () => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } });
      }
      if (!window.ResizeObserver) {
        window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
      }
      if (!window.IntersectionObserver) {
        window.IntersectionObserver = class {
          constructor() { } observe() { } unobserve() { } disconnect() { } takeRecords() { return []; }
        };
      }
      // canvas falso (gráficos desenhados de verdade, sem pixel)
      const noop = () => { };
      const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
      if (proto) {
        proto.getContext = function () {
          const alvo = {
            canvas: this,
            measureText: () => ({ width: 10 }),
            getImageData: () => ({ data: [] }),
            createLinearGradient: () => ({ addColorStop: noop }),
            createRadialGradient: () => ({ addColorStop: noop }),
            createPattern: () => ({})
          };
          return new Proxy(alvo, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
        };
        proto.toDataURL = function () { return 'data:image/jpeg;base64,/9j/4AAQ'; };
      }
      if (opts.seed) Object.keys(opts.seed).forEach(k => window.localStorage.setItem(k, opts.seed[k]));
      // cada instância é um "aparelho" diferente: id de device único
      // (o app guarda em localStorage 'fortcom_dev' e usa para filtrar o eco)
      window.localStorage.setItem('fortcom_dev', 'dev_' + Math.random().toString(36).slice(2, 10));
      // opts.sessaoPIN: simula a aba que já passou pela tela de PIN
      if (opts.sessaoPIN) window.sessionStorage.setItem('fortcom_pin_ok', '1');
      opts.window = window;
      const stub = criarStubFirebase(opts.fbDoc || { v: null }, opts);
      window.firebase = stub;
      // FileReader controlado (import de backup / fotos sem disco real)
      window.FileReader = function () {
        const self = this;
        this.result = null;
        this.readAsText = function () {
          self.result = window.__arquivoTexto || '';
          setTimeout(() => self.onload && self.onload(), 0);
        };
        this.readAsDataURL = function () {
          self.result = window.__arquivoData || 'data:image/png;base64,QUJD';
          setTimeout(() => self.onload && self.onload(), 0);
        };
      };
    }
  });

  const w = dom.window;
  await espera(80);
  w.__erros = erros;
  w.__avisos = avisos;
  return w;
}

/* ---------- acesso ao estado léxico do app ---------- */
const chamar = (w, expr) => w.eval(expr);
const estado = w => w.eval('({obras:obras, currentObraId:currentObraId, currentWeekId:currentWeekId, fotos:fotos, weeks:weeks})');
const semanaAtual = w => w.eval('(function(){var o=obras.find(function(x){return x.id===currentObraId;});return o?o.semanas.find(function(x){return x.id===currentWeekId;}):null;})()');
const lerLS = (w, k) => { try { return JSON.parse(w.localStorage.getItem(k)); } catch (e) { return null; } };

async function entrarPIN(w, pin) {
  w.document.getElementById('pinInput').value = pin;
  w.document.getElementById('pinBtn').click();
  await espera(120);
}

function importar(w, conteudo, nome) {
  w.__arquivoTexto = conteudo;
  w.eval('importFile({target:{files:[{name:' + JSON.stringify(nome || 'backup.json') + '}],value:""}})');
}

/* ===================================================================== */
(async function main() {
  console.log('\n\x1b[1mFORTCOM — verificação automatizada (jsdom)\x1b[0m');
  console.log('index.html: ' + SRC.split('\n').length + ' linhas · sw.js: ' + SW_SRC.split('\n').length + ' linhas');

  /* ---------- 1. BOOT / PIN ---------- */
  grupo('1. Primeira abertura, PIN e estado inicial');
  const A = await abrirApp({});
  ok('1.1 nenhum erro de JS na primeira abertura', errosReais(A).length === 0, resumo(errosReais(A)));
  ok('1.2 tela de PIN é exibida antes de autenticar', !!A.document.getElementById('pinWrap'));
  await entrarPIN(A, '0000');
  ok('1.3 PIN errado não libera o app',
    A.document.getElementById('pinErr').textContent.indexOf('incorreta') > -1 &&
    !!A.document.getElementById('pinWrap'), A.document.getElementById('pinErr').textContent);
  await entrarPIN(A, '2604');
  ok('1.4 PIN 2604 libera o app', !A.document.getElementById('pinWrap'));
  ok('1.5 sessão de PIN gravada em sessionStorage', A.sessionStorage.getItem('fortcom_pin_ok') === '1');
  const stA = estado(A);
  ok('1.6 app seeda obra vazia "MINHA PRIMEIRA OBRA"',
    stA.obras.length === 1 && stA.obras[0].nome === 'MINHA PRIMEIRA OBRA',
    JSON.stringify(stA.obras.map(o => o.nome)));
  ok('1.7 seed cria 8 semanas', stA.obras[0].semanas.length === 8, 'qtd=' + stA.obras[0].semanas.length);
  const hoje = new Date().toISOString().slice(0, 10);
  const sAtual = semanaAtual(A);
  ok('1.8 (L3) 1º acesso abre na semana que cobre hoje',
    !!sAtual && sAtual.inicio <= hoje && hoje <= sAtual.fim,
    sAtual ? (sAtual.inicio + '..' + sAtual.fim + ' hoje=' + hoje) : 'sem semana');

  grupo('1b. Bug: timer de foco da tela de PIN');
  const A2 = await abrirApp({});
  await entrarPIN(A2, '2604');            // entra em < 350 ms
  await espera(500);                      // deixa o setTimeout(…,350) disparar
  ok('1.9 entrar rápido não deixa TypeError no console (pinInput já removido)',
    A2.__erros.filter(e => /pinInput|reading 'focus'/.test(e)).length === 0,
    A2.__erros.filter(e => /focus/.test(e)).join(' | ').split('\n')[0]);

  /* ---------- 2. DADOS PERSISTEM ---------- */
  grupo('2. Persistência em localStorage (obra_control_v4)');
  chamar(A, "obras[0].cliente='CLIENTE TESTE'; obras[0].semanas[0].funcionarios.push({id:'f_fixo',nome:'JOSE DA SILVA',funcao:'Pedreiro',diaria:200,pix:'62999998888',extras:0,adiantamento:0,dias:{seg:1,ter:1,qua:1,qui:1,sex:1,sab:0,dom:0}}); saveNow();");
  const dump1 = A.localStorage.getItem('obra_control_v4');
  ok('2.1 saveNow grava obra_control_v4', !!dump1 && dump1.indexOf('CLIENTE TESTE') > -1);
  const B = await abrirApp({ seed: { 'obra_control_v4': dump1, 'obra_control_v4_week': stA.currentWeekId } });
  ok('2.2 reload não gera erro de JS', errosReais(B).length === 0, resumo(errosReais(B)));
  const stB0 = estado(B);
  ok('2.3 dados preservados após reload (cliente)', stB0.obras[0].cliente === 'CLIENTE TESTE', stB0.obras[0].cliente);
  ok('2.4 dados preservados após reload (funcionário)',
    stB0.obras[0].semanas[0].funcionarios.length === 1 &&
    stB0.obras[0].semanas[0].funcionarios[0].nome === 'JOSE DA SILVA',
    JSON.stringify(stB0.obras[0].semanas[0].funcionarios.map(f => f.nome)));
  ok('2.5 semana selecionada é restaurada', stB0.currentWeekId === stA.currentWeekId, stB0.currentWeekId + ' vs ' + stA.currentWeekId);

  /* ---------- 3. M1 — excluir semana ---------- */
  grupo('3. (M1) Exclusão de semana persiste de verdade');
  const antesExcl = estado(B).obras[0].semanas.length;
  const alvoExcl = estado(B).obras[0].semanas[antesExcl - 1].id;
  chamar(B, 'removeWeek(' + JSON.stringify(alvoExcl) + ')');
  await espera(700); // save() tem debounce de 400 ms
  ok('3.1 semana some do estado em memória', estado(B).obras[0].semanas.length === antesExcl - 1,
    antesExcl + ' -> ' + estado(B).obras[0].semanas.length);
  ok('3.2 semana some do localStorage',
    (lerLS(B, 'obra_control_v4').obras[0].semanas || []).findIndex(w => w.id === alvoExcl) === -1);
  const C = await abrirApp({ seed: { 'obra_control_v4': B.localStorage.getItem('obra_control_v4') } });
  const stC = estado(C);
  ok('3.3 semana NÃO ressuscita após reload',
    stC.obras[0].semanas.length === antesExcl - 1 && !stC.obras[0].semanas.find(w => w.id === alvoExcl),
    'qtd=' + stC.obras[0].semanas.length);
  ok('3.4 bloqueio: não deixa excluir a última semana', await (async () => {
    const w1 = await abrirApp({
      seed: {
        'obra_control_v4': JSON.stringify({
          obras: [{
            id: 'o1', nome: 'OBRA ÚNICA', valorTotal: 0, cliente: '', endereco: '', inicio: '', fim: '',
            semanas: [{ id: 's1', numero: 1, inicio: hoje, fim: hoje, status: 'aberta', funcionarios: [], valorRecebido: 0, custosExtras: [] }],
            etapas: [], diario: [], despesas: []
          }], currentObraId: 'o1', currentWeekId: 's1'
        })
      }
    });
    chamar(w1, "removeWeek('s1')");
    await espera(600);
    return estado(w1).obras[0].semanas.length === 1;
  })());

  /* ---------- 4. M3 — valores em formato BR ---------- */
  grupo('4. (M3) Valores em formato brasileiro');
  ok('4.1 parseVal("150,50") = 150.5', quase(chamar(C, "parseVal('150,50')"), 150.5), chamar(C, "parseVal('150,50')"));
  ok('4.2 parseVal("1.234,56") = 1234.56', quase(chamar(C, "parseVal('1.234,56')"), 1234.56), chamar(C, "parseVal('1.234,56')"));
  ok('4.3 parseVal("R$ 99,9") = 99.9', quase(chamar(C, "parseVal('R$ 99,9')"), 99.9), chamar(C, "parseVal('R$ 99,9')"));
  ok('4.4 parseVal("1,50") = 1.5 (não 1)', quase(chamar(C, "parseVal('1,50')"), 1.5), chamar(C, "parseVal('1,50')"));
  ok('4.5 parseVal(250) = 250', quase(chamar(C, 'parseVal(250)'), 250), chamar(C, 'parseVal(250)'));
  ok('4.6 parseVal("") = NaN', Number.isNaN(chamar(C, "parseVal('')")));
  // fluxo real: custo extra digitado em BR
  const D = await abrirApp({ promptRespostas: ['ALMOCO', '1.234,56'] });
  await entrarPIN(D, '2604');
  chamar(D, 'addCustoExtra()');
  await espera(80);
  const sD = semanaAtual(D);
  ok('4.7 custo extra "1.234,56" grava 1234.56',
    sD.custosExtras.length === 1 && quase(sD.custosExtras[0].valor, 1234.56),
    JSON.stringify(sD.custosExtras));
  // fluxo real: diária de funcionário em BR
  D.document.getElementById('fNome').value = 'MARIA';
  D.document.getElementById('fFuncao').value = 'Servente';
  D.document.getElementById('fDiaria').value = '150,50';
  D.document.getElementById('fPix').value = 'maria@pix.com';
  D.document.getElementById('fExtras').value = '100,25';
  D.document.getElementById('fAdiant').value = '50,10';
  ok('4.8 (L12) os 7 campos de dinheiro aceitam "150,50" digitado',
    D.document.getElementById('fDiaria').value === '150,50',
    'o campo devolveu "' + D.document.getElementById('fDiaria').value +
    '" — com <input type="number"> o parseVal nunca vê a vírgula e o app responde "Informe a diária"');
  chamar(D, 'saveFuncionario()');
  await espera(150);
  const fD = semanaAtual(D).funcionarios.find(f => f.nome === 'MARIA');
  ok('4.9 diária "150,50" grava 150.5', !!fD && quase(fD.diaria, 150.5), fD && fD.diaria);
  ok('4.10 extras "100,25" e adiantamento "50,10" gravam certo',
    !!fD && quase(fD.extras, 100.25) && quase(fD.adiantamento, 50.1),
    fD && (fD.extras + ' / ' + fD.adiantamento));
  ok('4.11 total = 5 dias*150.5 + 100.25 - 50.1',
    !!fD && quase(chamar(D, 'totalFunc(obras[0].semanas.find(function(w){return w.id===currentWeekId;}).funcionarios.find(function(f){return f.nome==="MARIA";}))'), 5 * 150.5 + 100.25 - 50.1));
  // L12 nos outros campos de dinheiro: valor recebido, etapa, despesa e valor da obra
  const D2 = await abrirApp({});
  await entrarPIN(D2, '2604');
  chamar(D2, 'openWeekModal(currentWeekId)');
  D2.document.getElementById('wRecebido').value = '2.500,75';
  chamar(D2, 'saveWeek()');
  await espera(150);
  ok('4.13 (L12) "Valor recebido" 2.500,75 grava 2500.75',
    quase(semanaAtual(D2).valorRecebido, 2500.75), semanaAtual(D2).valorRecebido);
  chamar(D2, 'openEtapaModal(null)');
  D2.document.getElementById('eNome').value = 'ALVENARIA';
  D2.document.getElementById('eOrcado').value = '12.345,67';
  chamar(D2, 'saveEtapa()');
  await espera(150);
  ok('4.14 (L12) "Valor orçado" da etapa 12.345,67 grava 12345.67',
    quase(chamar(D2, 'obras.find(function(o){return o.id===currentObraId;}).etapas[0].orcado'), 12345.67),
    chamar(D2, 'obras.find(function(o){return o.id===currentObraId;}).etapas[0].orcado'));
  chamar(D2, 'openDespesaModal(null)');
  D2.document.getElementById('pDescricao').value = 'CIMENTO';
  D2.document.getElementById('pValor').value = '1.099,90';
  chamar(D2, 'saveDespesa()');
  await espera(150);
  ok('4.15 (L12) despesa 1.099,90 grava 1099.9',
    quase(chamar(D2, 'obras.find(function(o){return o.id===currentObraId;}).despesas[0].valor'), 1099.9),
    chamar(D2, 'obras.find(function(o){return o.id===currentObraId;}).despesas[0].valor'));
  chamar(D2, 'openObraModal()');
  D2.document.getElementById('oValor').value = '85.000,00';
  chamar(D2, 'saveObra()');
  await espera(150);
  ok('4.16 (L12) "Valor da obra" 85.000,00 grava 85000',
    quase(estado(D2).obras[0].valorTotal, 85000), estado(D2).obras[0].valorTotal);
  ok('4.17 nenhum erro de JS nos fluxos de valor', errosReais(D2).length === 0, resumo(errosReais(D2)));

  /* ---------- 5. M2 — import de backup ---------- */
  grupo('5. (M2) Import de backup (legado e v4)');
  const legado = JSON.stringify({
    obra: { nome: 'OBRA ANTIGA', valorTotal: 12345, cliente: 'SEU ZÉ' },
    weeks: [{ id: 'w_antiga_1', numero: 1, inicio: '2024-01-01', fim: '2024-01-07', funcionarios: [{ nome: 'JOAO', diaria: 100 }] }]
  });
  const F = await abrirApp({});
  await entrarPIN(F, '2604');
  importar(F, legado);
  await espera(150);
  ok('5.1 import {obra, weeks} sem status/dias não quebra o app', errosReais(F).length === 0, resumo(errosReais(F)));
  const stF = estado(F);
  ok('5.2 obra importada assume o nome do backup', stF.obras[0].nome === 'OBRA ANTIGA', stF.obras[0].nome);
  ok('5.3 semana importada ganha status/dias/custosExtras',
    stF.obras[0].semanas[0].status === 'aberta' && !!stF.obras[0].semanas[0].funcionarios[0].dias &&
    Array.isArray(stF.obras[0].semanas[0].custosExtras), JSON.stringify(stF.obras[0].semanas[0]).slice(0, 200));
  ok('5.4 currentWeekId aponta para semana existente após import',
    !!stF.obras[0].semanas.find(w => w.id === stF.currentWeekId), stF.currentWeekId);
  await espera(700);
  ok('5.5 import legado é persistido (não fica só na memória)',
    (lerLS(F, 'obra_control_v4') || { obras: [] }).obras[0] &&
    lerLS(F, 'obra_control_v4').obras[0].nome === 'OBRA ANTIGA',
    JSON.stringify((lerLS(F, 'obra_control_v4') || {}).obras || []).slice(0, 120));
  const G = await abrirApp({ seed: { 'obra_control_v4': F.localStorage.getItem('obra_control_v4') } });
  ok('5.6 reload após import legado abre sem erro e mantém a obra',
    errosReais(G).length === 0 && estado(G).obras[0].nome === 'OBRA ANTIGA', resumo(errosReais(G)));
  // backup v4 completo
  const v4 = JSON.stringify({
    obras: [{
      id: 'o9', nome: 'OBRA V4', valorTotal: 999, cliente: 'X', endereco: '', inicio: '', fim: '',
      semanas: [{ id: 's9', numero: 1, inicio: hoje, fim: hoje, status: 'paga', funcionarios: [], valorRecebido: 10, custosExtras: [] }],
      etapas: [{ id: 'e1', nome: 'ETAPA 1', valor: 500 }], diario: [], despesas: []
    }],
    currentObraId: 'o9', currentWeekId: 's9',
    fotos: [{ id: 'ft1', obraId: 'o9', obraNome: 'OBRA V4', semana: 1, semanaId: 's9', inicio: hoje, nome: 'a.jpg', data: hoje, hora: '10:00', iso: hoje, src: 'data:image/png;base64,QUJD' }]
  });
  const H = await abrirApp({});
  await entrarPIN(H, '2604');
  importar(H, v4);
  await espera(200);
  ok('5.7 import v4 não gera erro', errosReais(H).length === 0, resumo(errosReais(H)));
  ok('5.8 import v4 restaura obra/etapa', estado(H).obras[0].nome === 'OBRA V4' && estado(H).obras[0].etapas.length === 1);
  ok('5.9 import v4 restaura fotos', estado(H).fotos.length === 1 && estado(H).fotos[0].id === 'ft1');
  ok('5.10 import v4 grava fotos no localStorage', (lerLS(H, 'obra_control_v4_fotos') || []).length === 1);
  const I2 = await abrirApp({});
  await entrarPIN(I2, '2604');
  importar(I2, '{ isso não é json');
  await espera(100);
  ok('5.11 JSON inválido não derruba o app', errosReais(I2).length === 0 && estado(I2).obras.length > 0, resumo(errosReais(I2)));

  /* ---------- 6. A4 — XSS ---------- */
  grupo('6. (A4) XSS armazenado — dados do usuário viram HTML?');
  const J = await abrirApp({});
  await entrarPIN(J, '2604');
  chamar(J, "obras[0].semanas.find(function(w){return w.id===currentWeekId;}).funcionarios.push({id:'f_xss',nome:'<img src=x onerror=\"window.__xssNome=1\">',funcao:'Pedreiro',diaria:100,pix:\"' + (window.__xssPix=1) + '\",extras:0,adiantamento:0,dias:{seg:1,ter:0,qua:0,qui:0,sex:0,sab:0,dom:0}}); render();");
  await espera(120);
  const htmlTabela = J.document.getElementById('tbody').innerHTML;
  ok('6.1 nome com HTML é ESCAPADO na tabela da semana',
    htmlTabela.indexOf('<img src=x') === -1, 'innerHTML contém a tag <img> crua');
  const nosImgInjetados = J.document.querySelectorAll('#tbody img[src="x"]').length;
  ok('6.2 nenhum nó <img> injetado foi criado (0 = nome saiu como texto)',
    nosImgInjetados === 0, nosImgInjetados + ' nó(s) <img src=x> criados a partir do nome digitado');
  ok('6.3 handler onerror do nome NÃO executou', chamar(J, 'window.__xssNome') === undefined);
  ok('6.4 chave PIX com aspas não quebra o onclick',
    htmlTabela.indexOf("writeText('' + (window.__xssPix=1)") === -1,
    'onclick montado por concatenação de aspas');
  ok('6.5 existe helper de escape (esc/escapeHTML) no fonte',
    /function\s+(esc|escapeHTML|escHtml)\s*\(/.test(SRC), 'nenhum helper de escape definido');

  /* ---------- 7. Nuvem: PIN + Firebase Auth + sync ---------- */
  grupo('7. Nuvem (Firebase Auth + Firestore) e sincronização');
  const fbDoc = { v: null };
  const K = await abrirApp({ fbDoc });
  await entrarPIN(K, '2604');
  await espera(80);
  ok('7.1 overlay "Nuvem FORTCOM" aparece após o PIN',
    !K.document.getElementById('authWrap').classList.contains('hidden'));
  ok('7.1b o e-mail já vem preenchido com a conta do dono (gran.tech18@gmail.com)',
    K.document.getElementById('authEmail').value === 'gran.tech18@gmail.com',
    'campo veio com "' + K.document.getElementById('authEmail').value + '"');
  K.document.getElementById('authEmail').value = 'dono@fortcom.com.br';
  K.document.getElementById('authSenha').value = 'errada';
  K.document.getElementById('authBtn').click();
  await espera(150);
  ok('7.2 senha errada mostra mensagem amigável',
    K.document.getElementById('authErr').textContent.indexOf('incorretos') > -1,
    K.document.getElementById('authErr').textContent);
  K.document.getElementById('authSenha').value = 'certa';
  K.document.getElementById('authBtn').click();
  await espera(250);
  ok('7.3 login correto fecha o overlay', K.document.getElementById('authWrap').classList.contains('hidden'));
  chamar(K, 'saveNow()');
  await espera(1400);
  ok('7.4 documento criado no Firestore após 1º envio', fbDoc.v !== null);
  ok('7.5 payload enviado contém as obras', !!fbDoc.v && fbDoc.v.payload.indexOf('MINHA PRIMEIRA OBRA') > -1);
  ok('7.6 "Usar só offline" mantém o app funcional', await (async () => {
    const L2 = await abrirApp({ fbDoc: { v: null } });
    await entrarPIN(L2, '2604');
    await espera(80);
    L2.document.getElementById('authSkip').click();
    await espera(80);
    return L2.document.getElementById('authWrap').classList.contains('hidden') && estado(L2).obras.length === 1;
  })());

  // ---- dois aparelhos ----
  const M = await abrirApp({ fbDoc, jaLogado: true, sessaoPIN: true });
  await espera(250);
  const N = await abrirApp({ fbDoc, jaLogado: true, sessaoPIN: true });
  await espera(250);
  ok('7.7 aparelho B recebe o estado do aparelho A',
    estado(N).obras.length === 1 && estado(N).obras[0].nome === 'MINHA PRIMEIRA OBRA',
    JSON.stringify(estado(N).obras.map(o => o.nome)));
  chamar(M, "obras[0].cliente='EDITADO NO APARELHO A'; saveNow();");
  await espera(1600);
  ok('7.8 edição em A chega em B', estado(N).obras[0].cliente === 'EDITADO NO APARELHO A', estado(N).obras[0].cliente);
  // conflito REAL: um aparelho edita sem internet (como no canteiro) e o
  // outro grava na nuvem; quando o primeiro volta, sobe o estado inteiro
  const setOnline = (w, v) => Object.defineProperty(w.navigator, 'onLine', { value: v, configurable: true });
  setOnline(M, false);                                   // M fica sem internet
  chamar(M, "obras[0].cliente='LANCADO OFFLINE EM M'; saveNow();");
  await espera(1300);
  ok('7.9a aparelho offline NÃO consegue gravar na nuvem',
    !!fbDoc.v && fbDoc.v.payload.indexOf('LANCADO OFFLINE EM M') === -1,
    'a escrita offline chegou ao documento');
  chamar(N, "obras[0].cliente='GRAVADO NA NUVEM POR N'; saveNow();");
  await espera(1600);
  ok('7.9b aparelho online grava na nuvem',
    !!fbDoc.v && fbDoc.v.payload.indexOf('GRAVADO NA NUVEM POR N') > -1);
  setOnline(M, true);                                    // M volta do canteiro
  M.dispatchEvent(new M.Event('online'));
  await espera(1800);
  ok('7.9c (A3) o lançamento OFFLINE de M sobrevive à sincronização',
    !!fbDoc.v && fbDoc.v.payload.indexOf('LANCADO OFFLINE EM M') > -1,
    'o estado inteiro de M subiu e derrubou o que N tinha gravado na nuvem — ' +
    'ou a escrita de N apagou o lançamento offline de M (last-write-wins, sem aviso)');
  ok('7.10 app trata conflito em vez de sobrescrever em silêncio',
    /conflito/i.test(SRC), 'nenhum tratamento de conflito no fonte');
  ok('7.11 (M5) há monitoramento do tamanho do payload (limite 1 MB)',
    /payload\.length/.test(SRC), 'nenhum monitoramento de tamanho do documento');

  /* ---------- 8. Itens em aberto (estáticos) ---------- */
  grupo('8. Verificações estáticas dos itens da auditoria');
  ok('8.1 (M8) beacon do Cloudflare Insights removido', SRC.indexOf('beacon.min.js') === -1);
  ok('8.2 (M8) script de challenge /cdn-cgi removido', SRC.indexOf('cdn-cgi') === -1);
  ok('8.3 HTML termina corretamente com </html>', /<\/html>\s*$/.test(SRC.trim()));
  ok('8.4 (L1) nenhum ano hardcoded no nome do mês', !/new Date\(2026,\s*\d+\s*,\s*\d+\)[\s\S]{0,80}toLocaleDateString/.test(SRC) && SRC.indexOf("new Date(2026, 0, mes") === -1);
  ok('8.5 (A2) PIN não é mais literal fixo no fonte', !/var\s+PIN\s*=\s*'2604'/.test(SRC), "var PIN = '2604' continua no código");
  ok('8.6 (A2) existe rota de troca/recuperação de PIN',
    /trocarPin|alterarPin|redefinirPin|resetPin/i.test(SRC), 'nenhuma função de troca de PIN');
  ok('8.7 (M4) save grava só quando houve mudança',
    /_ultimoGravado|_ultimoPacote|pacote\(\)!==/.test(SRC),
    'saveNow grava a cada 30 s mesmo sem alteração');
  ok('8.8 (M6) fotos são comprimidas antes de salvar',
    /drawImage\(/.test(SRC) && /toDataURL\(/.test(SRC),
    'handleFotos grava o base64 cru (2-4 MB por foto)');
  ok('8.9 (M7) service worker limita o cache (teto/LRU)',
    /MAX_ENTRADAS|MAX_ITEMS|limite|teto/i.test(SW_SRC) && /\.delete\(\s*(?:entrada|ks\.pop|maisAntiga)/.test(SW_SRC),
    'sw.js faz c.put de qualquer GET, sem teto de entradas nem LRU');
  ok('8.10 (L2) código morto removido',
    SRC.indexOf('obrasModelo') === -1 && SRC.indexOf('LOGO_BRANCA') === -1 && SRC.indexOf('OBRA_KEY') === -1,
    ['obrasModelo:' + (SRC.indexOf('obrasModelo') > -1),
      'LOGO_BRANCA:' + (SRC.indexOf('LOGO_BRANCA') > -1),
      'OBRA_KEY:' + (SRC.indexOf('OBRA_KEY') > -1)].join(' '));
  ok('8.11 (L5) selectWeek valida semana existente',
    /function selectWeek\(id\)\{[\s\S]{0,120}if\s*\(!/.test(SRC),
    'selectWeek chama .numero sem checar se a semana existe');
  ok('8.12 (L4) openWeekModal tolera obra com 0 semanas',
    !/const last=weeks\[weeks\.length-1\];\s*\n\s*const d=new Date\(last\.fim\)/.test(SRC),
    'new Date(last.fim) com last undefined');
  const camposDinheiro = ['eOrcado', 'pValor', 'fDiaria', 'fExtras', 'fAdiant', 'wRecebido', 'oValor'];
  const aindaNumber = camposDinheiro.filter(id =>
    new RegExp('id="' + id + '"[^>]*type="number"').test(SRC));
  ok('8.14 (L12) nenhum campo de dinheiro é type="number"', aindaNumber.length === 0,
    'ainda type=number: ' + aindaNumber.join(', '));
  ok('8.15 (L12) campos de dinheiro usam inputmode="decimal" (teclado numérico no celular)',
    camposDinheiro.every(id => new RegExp('id="' + id + '"[^>]*inputmode="decimal"').test(SRC)));
  ok('8.16 (L11) focus() do PIN tem guarda de elemento nulo',
    /setTimeout\(function\(\)\{\s*var _pin=document\.getElementById\('pinInput'\);\s*if\(_pin\) _pin\.focus\(\);/.test(SRC),
    'o timer ainda chama .focus() sem checar se a tela existe');
  // ---- A1: as regras versionadas têm que bater com o que o app faz ----
  const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
  const temRules = fs.existsSync(RULES_PATH);
  const RULES = temRules ? fs.readFileSync(RULES_PATH, 'utf8') : '';
  const docPathApp = (SRC.match(/var DOCPATH = \[([^\]]+)\]/) || [])[1] || '';
  const caminhoApp = docPathApp.split(',').map(x => x.trim().replace(/'/g, '')).join('/');
  ok('8.17 (A1) firestore.rules está versionado no repo', temRules, 'arquivo firestore.rules ausente');
  ok('8.18 (A1) as regras cobrem exatamente o documento que o app usa',
    temRules && caminhoApp === 'empresas/fortcom/dados/principal' &&
    RULES.indexOf('match /empresas/fortcom/dados/{doc}') > -1,
    'app usa "' + caminhoApp + '"');
  const soComentarios = RULES.split('\n').filter(l => l.trim().indexOf('//') !== 0).join('\n');
  ok('8.19 (A1) as regras não são mais "if true" (e negam todo o resto)',
    temRules && soComentarios.indexOf('if true') === -1 &&
    /allow read, write: if dono\(\)/.test(soComentarios) &&
    /match \/\{document=\*\*\} \{[\s\S]{0,60}if false;/.test(soComentarios),
    'regras efetivas: ' + JSON.stringify(soComentarios.replace(/\s+/g, ' ').slice(0, 160)));
  ok('8.20 (A1) dono nas regras = conta do Firebase gran.tech18@gmail.com',
    /'gran\.tech18@gmail\.com'/.test(RULES), 'e-mail do dono ausente/nas regras');
  ok('8.21 (A1) o login pré-preenche a conta do dono (não o contato da empresa)',
    /EMAIL_PADRAO='gran\.tech18@gmail\.com'/.test(SRC.replace(/\s+/g, '')),
    'EMAIL_PADRAO continua vindo de EMPRESA.email');
  ok('8.22 (A1) o contato da empresa segue no relatório (não foi trocado)',
    /email: 'fernandogpi92@gmail\.com'/.test(SRC) && /EMPRESA\.email|_empresa:EMPRESA/.test(SRC));
  // ---- M7 (parcial): o cache do service worker precisa acompanhar o deploy ----
  const CACHE_ESPERADO = 'fortcom-v9';   // ← subir junto com cada deploy
  const cacheNoSw = (SW_SRC.match(/const CACHE='([^']+)'/) || [])[1];
  ok('8.23 (M7) sw.js bumpou o cache neste deploy (' + CACHE_ESPERADO + ')',
    cacheNoSw === CACHE_ESPERADO,
    "sw.js está em '" + cacheNoSw + "' — sem o bump, o celular que já instalou o " +
    'app continua servindo o index.html antigo do cache');
  ok('8.13 (L8) exportCSV protege campos com aspas/quebra de linha',
    /csvCell|csvEsc|escCSV|function celCSV/.test(SRC),
    'campos continuam sem aspas de campo');

  /* ---------- 9. A2 — PIN com hash, troca, resgate e bloqueio ---------- */
  grupo('9. (A2) PIN: hash em vez de literal, troca, resgate e limite de tentativas');
  const P = await abrirApp({});
  await entrarPIN(P, '2604');
  ok('9.1 PIN de fábrica continua abrindo o app (hash padrão)', !P.document.getElementById('pinWrap'));
  ok('9.2 sha256Hex confere com o hash padrão gravado no fonte',
    chamar(P, "sha256Hex('fortcom|2604')") === 'dc572defb8c7ead6c2b24b032ff9c0d27ee8f6233eccef4822ca549739b0210d');
  ok('9.3 hash de "abc" bate com a referência oficial do SHA-256',
    chamar(P, "sha256Hex('abc')") === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // troca de PIN via prompt(): atual, novo, repete
  P.prompt = (() => { const r = ['2604', '1357', '1357']; return () => r.shift(); })();
  let alertaTroca = ''; P.alert = m => { alertaTroca = String(m); };
  chamar(P, 'trocarPin()');
  const hashNovo = P.localStorage.getItem('fortcom_pin_hash');
  ok('9.4 trocarPin grava o HASH do novo PIN (não o PIN)',
    hashNovo === chamar(P, "sha256Hex('fortcom|1357')") && hashNovo.indexOf('1357') === -1, hashNovo);
  const codigo = P.localStorage.getItem('fortcom_pin_resgate') || '';
  ok('9.5 a troca gera um código de resgate (XXXX-XXXX) e mostra ao dono',
    /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codigo) && alertaTroca.indexOf(codigo) > -1, codigo);
  ok('9.6 o código de resgate vai dentro do backup .json (_resgate)',
    chamar(P, 'montarBackup()._resgate') === codigo);
  const seedPin = { fortcom_pin_hash: hashNovo, fortcom_pin_resgate: codigo };
  const P2 = await abrirApp({ seed: seedPin });
  await entrarPIN(P2, '2604');
  ok('9.7 PIN antigo (2604) NÃO abre mais depois da troca', !!P2.document.getElementById('pinWrap'));
  await entrarPIN(P2, '1357');
  ok('9.8 PIN novo abre', !P2.document.getElementById('pinWrap'));
  // resgate: esqueci o PIN -> código -> define outro
  const P3 = await abrirApp({ seed: seedPin });
  P3.confirm = () => true;                                   // "tenho o código"
  P3.prompt = (() => { const r = [codigo.toLowerCase(), '2468', '2468']; return () => r.shift(); })();
  P3.alert = () => { };
  P3.document.getElementById('pinEsqueci').click();
  await espera(150);
  ok('9.9 "Esqueci o PIN" + código de resgate cria PIN novo e entra',
    !P3.document.getElementById('pinWrap') &&
    P3.localStorage.getItem('fortcom_pin_hash') === chamar(P3, "sha256Hex('fortcom|2468')"),
    P3.document.getElementById('pinErr') ? P3.document.getElementById('pinErr').textContent : 'entrou');
  ok('9.10 o resgate troca o código (o antigo não vale duas vezes)',
    P3.localStorage.getItem('fortcom_pin_resgate') !== codigo);
  // bloqueio progressivo
  const P4 = await abrirApp({ seed: seedPin });
  for (let i = 0; i < 5; i++) await entrarPIN(P4, '0000');
  const msgBloq = P4.document.getElementById('pinErr').textContent;
  ok('9.11 5 erros seguidos bloqueiam a tela por um tempo', /aguarde/i.test(msgBloq), msgBloq);
  await entrarPIN(P4, '1357');
  ok('9.12 bloqueado: nem o PIN certo entra até o tempo passar', !!P4.document.getElementById('pinWrap'));
  ok('9.13 código de resgate errado não abre',
    await (async () => {
      const P5 = await abrirApp({ seed: seedPin });
      P5.confirm = () => true; P5.prompt = () => 'ZZZZ-ZZZZ'; P5.alert = () => { };
      P5.document.getElementById('pinEsqueci').click(); await espera(100);
      return !!P5.document.getElementById('pinWrap') && /inválido/i.test(P5.document.getElementById('pinErr').textContent);
    })());

  /* ---------- 10. A3 — sincronização com merge (sem perda) ---------- */
  grupo('10. (A3) Sync com merge de 3 vias: nada se perde, conflito é avisado');
  const fb2 = { v: null };
  const S1 = await abrirApp({ fbDoc: fb2, jaLogado: true, sessaoPIN: true });
  await espera(1600);
  ok('10.1 aparelho A cria o documento com rev', !!fb2.v && Number(fb2.v.rev) >= 1, JSON.stringify(fb2.v && fb2.v.rev));
  const S2 = await abrirApp({ fbDoc: fb2, jaLogado: true, sessaoPIN: true });
  await espera(600);
  ok('10.2 aparelho B adota o estado da nuvem', estado(S2).obras[0].id === estado(S1).obras[0].id);
  const setOn = (w, v) => Object.defineProperty(w.navigator, 'onLine', { value: v, configurable: true });
  // A offline edita a semana 1; B online edita a semana 2 (campos diferentes) e o cliente
  setOn(S1, false);
  chamar(S1, "obras[0].semanas[0].funcionarios.push({id:'f_off',nome:'OFFLINE A',funcao:'Pedreiro',diaria:180,pix:'',extras:0,adiantamento:0,dias:{seg:1,ter:1,qua:0,qui:0,sex:0,sab:0,dom:0}}); obras[0].endereco='RUA A'; saveNow();");
  await espera(1400);
  chamar(S2, "obras[0].semanas[1].valorRecebido=3000; obras[0].cliente='CLIENTE B'; obras[0].endereco='RUA B'; saveNow();");
  await espera(1600);
  ok('10.3 B gravou na nuvem enquanto A estava offline', !!fb2.v && fb2.v.payload.indexOf('CLIENTE B') > -1);
  setOn(S1, true); S1.dispatchEvent(new S1.Event('online'));
  await espera(2600);
  const nuvem = JSON.parse(fb2.v.payload).obras[0];
  ok('10.4 lançamento OFFLINE de A sobreviveu (funcionário na semana 1)',
    nuvem.semanas[0].funcionarios.some(f => f.id === 'f_off'), JSON.stringify(nuvem.semanas[0].funcionarios.map(f => f.nome)));
  ok('10.5 edição de B sobreviveu (recebido da semana 2 + cliente)',
    Number(nuvem.semanas[1].valorRecebido) === 3000 && nuvem.cliente === 'CLIENTE B');
  await espera(800);
  ok('10.6 B recebeu o funcionário lançado offline por A',
    estado(S2).obras[0].semanas[0].funcionarios.some(f => f.id === 'f_off'));
  ok('10.7 A recebeu o recebido lançado por B',
    Number(estado(S1).obras[0].semanas[1].valorRecebido) === 3000 && estado(S1).obras[0].cliente === 'CLIENTE B');
  const confA = JSON.parse(S1.localStorage.getItem('fortcom_conflitos') || '[]');
  const confB = JSON.parse(S2.localStorage.getItem('fortcom_conflitos') || '[]');
  ok('10.8 o campo editado nos DOIS lados (endereço) gerou registro de conflito',
    confA.some(c => /endereco/.test(c.campo)) || confB.some(c => /endereco/.test(c.campo)),
    JSON.stringify(confA.concat(confB).map(c => c.campo)));
  ok('10.9 endereço ficou com UM dos valores (não sumiu, não virou lixo)',
    ['RUA A', 'RUA B'].indexOf(nuvem.endereco) > -1 && estado(S1).obras[0].endereco === nuvem.endereco && estado(S2).obras[0].endereco === nuvem.endereco,
    nuvem.endereco + ' / A=' + estado(S1).obras[0].endereco + ' / B=' + estado(S2).obras[0].endereco);
  ok('10.10 o registro de conflito também foi para o documento (outro aparelho vê)',
    Array.isArray(fb2.v.conflitos) && fb2.v.conflitos.some(c => /endereco/.test(c.campo)),
    JSON.stringify(fb2.v.conflitos));
  ok('10.11 existe função para o dono ver os conflitos (mostrarConflitos)', typeof S1.mostrarConflitos === 'function');
  // exclusão de um lado, sem edição do outro: some dos dois
  const antesQtd = estado(S1).obras[0].semanas.length;
  const alvo = estado(S1).obras[0].semanas[antesQtd - 1].id;
  chamar(S1, 'removeWeek(' + JSON.stringify(alvo) + ')');
  await espera(2200);
  ok('10.12 semana excluída em A some em B (sem ressuscitar no merge)',
    !estado(S2).obras[0].semanas.find(w => w.id === alvo), 'qtd B=' + estado(S2).obras[0].semanas.length);
  ok('10.13 (M5) tamanho do payload é monitorado (limite 1 MB)',
    /LIMITE_DOC=1048576/.test(SRC) && /payload\.length>LIMITE_DOC/.test(SRC));
  ok('10.14 (M5) alerta antes de estourar (~800 KB)', /AVISO_DOC=800\*1024/.test(SRC));

  /* ---------- 11. M6 — compressão de fotos ---------- */
  grupo('11. (M6) Fotos comprimidas antes de ir para o localStorage');
  const FO = await abrirApp({});
  await entrarPIN(FO, '2604');
  // imagem "grande": 3000x2000 (o Image do jsdom não decodifica; simulamos as dimensões)
  const ImgOrig = FO.Image;
  FO.Image = function () {
    const el = new ImgOrig();
    Object.defineProperty(el, 'naturalWidth', { value: 3000 });
    Object.defineProperty(el, 'naturalHeight', { value: 2000 });
    Object.defineProperty(el, 'src', { set() { setTimeout(() => el.onload && el.onload(), 0); } });
    return el;
  };
  let dimsCanvas = null;
  FO.HTMLCanvasElement.prototype.toDataURL = function (tipo, q) { dimsCanvas = { w: this.width, h: this.height, tipo, q }; return 'data:image/jpeg;base64,' + 'A'.repeat(1000); };
  FO.__arquivoData = 'data:image/png;base64,' + 'B'.repeat(200000);
  chamar(FO, "handleFotos({target:{files:[{name:'obra.png'}],value:''}})");
  await espera(200);
  const fotoSalva = (lerLS(FO, 'obra_control_v4_fotos') || [])[0];
  ok('11.1 a foto salva é a versão comprimida (JPEG), não o base64 cru',
    !!fotoSalva && fotoSalva.src.indexOf('data:image/jpeg') === 0 && fotoSalva.src.length < 2000,
    fotoSalva ? fotoSalva.src.slice(0, 30) + ' len=' + fotoSalva.src.length : 'nenhuma foto');
  ok('11.2 redimensiona para no máximo 1280 px no maior lado (3000x2000 → 1280x853)',
    !!dimsCanvas && dimsCanvas.w === 1280 && dimsCanvas.h === 853, JSON.stringify(dimsCanvas));
  ok('11.3 JPEG com qualidade ~0.72', !!dimsCanvas && dimsCanvas.tipo === 'image/jpeg' && quase(dimsCanvas.q, 0.72, 0.01));
  ok('11.4 galeria mostra o uso de memória', /MB usados/.test(FO.document.getElementById('galeriaCount').textContent),
    FO.document.getElementById('galeriaCount').textContent);

  /* ---------- 12. L4/L5 — obra sem semanas e ids obsoletos ---------- */
  grupo('12. (L4/L5) Obra com 0 semanas e semana inexistente não derrubam o app');
  const Z = await abrirApp({ seed: { 'obra_control_v4': JSON.stringify({ obras: [{ id: 'o1', nome: 'VAZIA', valorTotal: 1000, semanas: [], etapas: [], diario: [], despesas: [] }], currentObraId: 'o1' }) } });
  await entrarPIN(Z, '2604');
  ok('12.1 abre obra sem semanas sem erro de JS', errosReais(Z).length === 0, resumo(errosReais(Z)));
  let quebrou = null;
  try { chamar(Z, 'openWeekModal()'); } catch (e) { quebrou = e.message; }
  ok('12.2 "+ Nova semana" abre com obra vazia (sugere a semana atual)',
    !quebrou && Z.document.getElementById('modalWeek').classList.contains('open') && /^\d{4}-\d{2}-\d{2}$/.test(Z.document.getElementById('wInicio').value), quebrou || '');
  quebrou = null;
  try { chamar(Z, "selectWeek('nao_existe')"); chamar(Z, 'changeWeek(1)'); } catch (e) { quebrou = e.message; }
  ok('12.3 selectWeek/changeWeek com id inexistente não quebram', !quebrou, quebrou || '');
  ok('12.4 topo mostra estado vazio em vez de quebrar', /SEM SEMANA/.test(Z.document.getElementById('weekLabel').textContent));
  chamar(Z, "document.getElementById('wNumero').value='1'; document.getElementById('wInicio').value='2026-09-07'; document.getElementById('wFim').value='2026-09-13'; saveWeek();");
  await espera(600);
  ok('12.5 criar a 1ª semana numa obra vazia funciona', estado(Z).obras[0].semanas.length === 1 && estado(Z).currentWeekId === estado(Z).obras[0].semanas[0].id);

  /* ---------- 13. L8 — CSV ---------- */
  grupo('13. (L8) CSV seguro para Excel BR');
  const X = await abrirApp({});
  await entrarPIN(X, '2604');
  // o Blob do jsdom não tem .text(): captura o conteúdo na construção
  let txtCsv = '';
  const BlobOrig = X.Blob;
  X.Blob = function (partes, o) { txtCsv = (partes || []).join(''); return new BlobOrig(partes, o); };
  X.URL.createObjectURL = () => 'blob:x'; X.URL.revokeObjectURL = () => { };
  X.HTMLAnchorElement.prototype.click = function () { };
  chamar(X, "obras[0].nome='OBRA \"TESTE\"; RUA'; obras[0].semanas[0].funcionarios.push({id:'f1',nome:'JOAO;SILVA',funcao:'Pedreiro',diaria:150.5,pix:'=cmd|x',extras:0,adiantamento:0,dias:{seg:1,ter:0,qua:0,qui:0,sex:0,sab:0,dom:0}}); exportCSV();");
  ok('13.1 campo com ; e aspas vai entre aspas (aspas dobradas)', txtCsv.indexOf('"OBRA ""TESTE""; RUA"') > -1, txtCsv.split('\n')[0]);
  ok('13.2 nome com ; não quebra a coluna', txtCsv.indexOf('"JOAO;SILVA"') > -1);
  ok('13.3 decimal com vírgula (150,5) para o Excel BR', /;150,5;/.test(txtCsv));
  ok('13.4 célula começando com = não vira fórmula (injeção de CSV)', txtCsv.indexOf("'=cmd|x") > -1);
  ok('13.5 relatórios (aba) passam a ser renderizados', X.document.getElementById('resumoFinanceiro').innerHTML.length > 0);

  /* ---------- resumo ---------- */
  console.log('\n\x1b[1m---------------------------------------------\x1b[0m');
  console.log('\x1b[1m ' + (okCount + failCount) + ' verificações · ' +
    okCount + ' ok · ' + failCount + ' falhando\x1b[0m');
  if (falhas.length) {
    console.log('\n\x1b[1m\x1b[31mItens reprovados:\x1b[0m');
    falhas.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  }
  console.log('');
  process.exit(failCount ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31mERRO NA SUITE:\x1b[0m', e); process.exit(2); });
