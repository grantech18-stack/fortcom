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
    }
  };
  const doc = {
    get exists() { return docCompartilhado.v !== null; },
    data() { return docCompartilhado.v; },
    set(d) {
      // sem internet a escrita falha, como no aparelho real
      if (opts.window && opts.window.navigator && opts.window.navigator.onLine === false) {
        const e = new Error('unavailable'); e.code = 'unavailable';
        return Promise.reject(e);
      }
      docCompartilhado.v = d;
      setTimeout(() => ouvintes.forEach(cb => { try { cb(doc); } catch (e) { } }), 0);
      return Promise.resolve();
    },
    onSnapshot(_o, cb, _err) {
      ouvintes.push(cb);
      setTimeout(() => { try { cb(doc); } catch (e) { } }, 0);
      return () => { };
    }
  };
  const firestore = () => ({
    enablePersistence: () => Promise.resolve(),
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => doc }) }) })
  });
  return { __auth: auth, auth: () => auth, initializeApp() { }, firestore };
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
  ok('8.13 (L8) exportCSV protege campos com aspas/quebra de linha',
    /csvCell|csvEsc|escCSV|function celCSV/.test(SRC),
    'campos continuam sem aspas de campo');

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
