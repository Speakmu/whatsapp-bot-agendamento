// Alerta sonoro de "pedido novo" — ÚNICO alarme do painel.
//
// Roda na moldura (admin.html), não dentro de cada tela. Antes cada tela
// (iframe) tinha o seu próprio alarme, e isso falhava de três jeitos:
//  - telas sem alarme nenhum (Atendimento, Fiscal, Estoque, BI, Financeiro,
//    Configurações...): quem estava nelas não ouvia nada;
//  - trocar de tela destruía a página e, com ela, o alarme que estava tocando;
//  - três cópias do mesmo código (app.js, kds.js e este arquivo) que iam
//    ficando diferentes a cada correção.
// A moldura nunca é descarregada ao navegar pelo menu, então o alarme vive
// enquanto o painel estiver aberto, em qualquer tela.
//
// Carregado em admin.html DEPOIS de admin-shell.js. As telas ainda incluem
// este arquivo, mas dentro do iframe ele não faz nada (ver a 1ª linha).
(function () {
    if (window.self !== window.top) return;

    const COLECAO_PEDIDOS = "pedidos";
    const STATUS_ATIVOS_PEDIDOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"];
    // Enquanto o pedido estiver num destes, ainda é "novo" (ninguém aceitou).
    // O alarme só para sozinho quando o pedido SAI deste grupo — trocar de um
    // para outro (ex.: PIX confirmado: AGUARDANDO_PIX -> PENDENTE_PREPARO) não
    // pode silenciar, porque é justamente aí que o pedido passa a valer.
    const STATUS_NOVOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO"];

    function iniciar() {
        if (!window.firebase || !window.__FIREBASE_CONFIG__) return;
        if (!firebase.apps.length) firebase.initializeApp(window.__FIREBASE_CONFIG__);
        const db = firebase.firestore();

        // Conexão própria, sem a persistência offline da moldura/Caixa. Com
        // persistência "multi-aba", só uma página fala com o servidor e as
        // outras recebem por tabela; com o Chrome minimizado essa troca
        // depende de timers que o navegador segura, e o pedido novo podia
        // chegar com atraso. A leitura de pedidos é pública nas regras, então
        // esta conexão não precisa de login.
        let dbPedidos = db;
        try {
            let appAlerta;
            try { appAlerta = firebase.app('alerta-pedidos'); }
            catch (e) { appAlerta = firebase.initializeApp(window.__FIREBASE_CONFIG__, 'alerta-pedidos'); }
            dbPedidos = appAlerta.firestore();
            if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
                try { dbPedidos.useEmulator(location.hostname, 8080); } catch (e) { /* já configurado */ }
            }
        } catch (e) {
            console.warn('Alerta de pedido novo: usando a conexão principal:', e.message);
        }

        // ---- Registro de diagnóstico (coleção alerta_log) ----
        // Cada passo do alarme fica gravado: dá pra saber depois se o painel
        // viu o pedido, com quanto atraso, e se o navegador deixou tocar.
        // Grava pela conexão própria do alarme: a da moldura tem fila de
        // gravação offline e pode segurar o registro por muito tempo.
        const sessao = Math.random().toString(36).slice(2, 10);
        function registrar(evento, extra) {
            try {
                const user = firebase.auth && firebase.auth().currentUser;
                const frame = document.getElementById('admin-frame');
                dbPedidos.collection('alerta_log').add(Object.assign({
                    evento,
                    em: firebase.firestore.FieldValue.serverTimestamp(),
                    hora_local: new Date().toISOString(),
                    sessao,
                    usuario: (user && user.email) || null,
                    tela: (frame && frame.getAttribute('src')) || null,
                    visivel: document.visibilityState,
                    foco: document.hasFocus()
                }, extra || {})).catch(e => console.warn('Registro do alerta (alerta_log):', e.message));
            } catch (e) { console.warn('Registro do alerta (alerta_log):', e.message); }
        }

        // ---- Configuração (Configurações > Alerta sonoro de pedido novo) ----
        const cfg = { ativo: true, som_id: '1004', volume: 1.0, intervalo_segundos: 4 };
        db.collection('configuracoes').doc('alerta_som').onSnapshot(snap => {
            const d = (snap.exists && snap.data()) || {};
            cfg.ativo = d.ativo !== false;
            cfg.som_id = d.som_id || '1004';
            cfg.volume = d.volume != null ? d.volume : 1.0;
            cfg.intervalo_segundos = d.intervalo_segundos || 4;
            if (!cfg.ativo) pararAlertaSom();
        }, e => console.warn('Config de alerta sonoro: usando padrão (erro ao ler):', e.message));

        // A tela da Cozinha tem um botão "Som: ON/OFF". Vale só enquanto ela
        // estiver aberta: ao trocar de tela o som volta sozinho, pra ninguém
        // esquecer o painel mudo.
        let silenciado = false;
        const frameTela = document.getElementById('admin-frame');
        if (frameTela) frameTela.addEventListener('load', () => { silenciado = false; });

        // Navegadores bloqueiam áudio em página que ainda não recebeu nenhum
        // clique/tecla. Avisa na tela e some ao primeiro clique.
        function avisoSomBloqueado(mostrar) {
            let el = document.getElementById('aviso-som-bloqueado');
            if (!mostrar) { if (el) el.remove(); return; }
            if (el) return;
            el = document.createElement('div');
            el.id = 'aviso-som-bloqueado';
            el.textContent = '🔇 Som dos pedidos bloqueado pelo navegador — clique aqui para ativar';
            el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#c0392b;color:#fff;padding:10px 16px;border-radius:8px;font:600 14px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);cursor:pointer;max-width:92vw;text-align:center;';
            document.body.appendChild(el);
        }
        let alertaSomInterval = null;
        let resultadoRegistrado = false; // 1 registro de "tocou/bloqueou" por alarme, não por repetição
        // O navegador recusou tocar o alarme atual. Enquanto isso for verdade
        // o alarme NÃO pode ser dado como "visto": antes, o próprio clique que
        // desbloqueava o som deixava a aba visível+focada e o alarme parava
        // sem nunca ter tocado.
        let tocouNesteAlarme = false;
        ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
            avisoSomBloqueado(false);
            if (alertaSomInterval && !tocouNesteAlarme) tocarAlertaSom();
        }, true));
        // Clique dentro da tela (iframe) não chega aqui como evento, mas
        // libera o som do mesmo jeito — tira o aviso assim que isso acontecer.
        setInterval(() => {
            if (!document.getElementById('aviso-som-bloqueado')) return;
            if (navigator.userActivation && navigator.userActivation.hasBeenActive && !alertaSomInterval) avisoSomBloqueado(false);
        }, 2000);
        function pararAlertaSom() {
            if (alertaSomInterval) {
                clearInterval(alertaSomInterval);
                alertaSomInterval = null;
            }
            avisoPedidoNovo(false);
        }
        // O alarme repete até alguém clicar nesta faixa (que abre a tela de
        // Pedidos) ou até o pedido ser aceito/cancelado. Antes parava sozinho
        // assim que a aba estivesse na frente — com o painel já aberto na
        // tela, tocava uma vez só e passava batido.
        function avisoPedidoNovo(mostrar) {
            let el = document.getElementById('aviso-pedido-novo');
            if (!mostrar) { if (el) el.remove(); return; }
            const qtd = pedidosAlarmando.size;
            const texto = (qtd > 1 ? `🔔 ${qtd} pedidos novos!` : '🔔 Pedido novo!') + ' Clique aqui para ver';
            if (!el) {
                el = document.createElement('button');
                el.id = 'aviso-pedido-novo';
                el.type = 'button';
                el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99998;background:#e67e22;color:#fff;border:3px solid #fff;padding:14px 26px;border-radius:12px;font:700 18px sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);cursor:pointer;max-width:92vw;text-align:center;';
                el.addEventListener('click', () => {
                    registrar('alarme_confirmado_no_clique');
                    // Já vistos: não podem segurar o alarme do próximo pedido.
                    pedidosAlarmando.clear();
                    pararAlertaSom();
                    const link = document.querySelector('#app-sidebar .sb-item[data-href="/painel.html"]');
                    if (link) link.click();
                });
                document.body.appendChild(el);
            }
            el.textContent = texto;
        }
        function registrarResultado(evento, extra) {
            if (resultadoRegistrado) return;
            resultadoRegistrado = true;
            registrar(evento, extra);
        }
        function bipeReserva() {
            try {
                const ctx = window.__ctxAlertaSom || (window.__ctxAlertaSom = new (window.AudioContext || window.webkitAudioContext)());
                if (ctx.state === 'suspended') ctx.resume();
                if (ctx.state !== 'running') { avisoSomBloqueado(true); return; }
                [0, 0.35].forEach(atraso => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'square'; osc.frequency.value = 880;
                    gain.gain.value = Math.min(1, Math.max(0.05, cfg.volume)) * 0.4;
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.start(ctx.currentTime + atraso); osc.stop(ctx.currentTime + atraso + 0.25);
                });
            } catch (e) { console.warn('Bipe de reserva falhou:', e.message); }
        }
        // Um Audio NOVO a cada toque: reutilizar um único elemento fazia o som
        // "morrer" pra sempre depois de qualquer falha de rede/carregamento.
        function tocarAlertaSom() {
            try {
                const audio = new Audio(`https://assets.mixkit.co/active_storage/sfx/${cfg.som_id}/${cfg.som_id}-preview.mp3`);
                audio.volume = cfg.volume;
                audio.addEventListener('error', () => {
                    registrarResultado('som_arquivo_falhou_bipe');
                    bipeReserva();
                }, { once: true });
                const p = audio.play();
                if (p && p.then) p.then(() => {
                    tocouNesteAlarme = true;
                    avisoSomBloqueado(false);
                    registrarResultado('som_tocou');
                }).catch(err => {
                    if (err && err.name === 'NotAllowedError') {
                        avisoSomBloqueado(true);
                        registrarResultado('som_bloqueado_navegador');
                    } else {
                        console.warn('Alerta sonoro falhou, usando bipe:', err && err.message);
                        registrarResultado('som_falhou_bipe', { erro: String((err && (err.name + ': ' + err.message)) || err) });
                        bipeReserva();
                    }
                });
            } catch (e) { bipeReserva(); }
        }

        const pedidosAlarmando = new Set();
        function conferirAlarme(docs) {
            const status = new Map(docs.map(d => [d.id, (d.data() || {}).status]));
            pedidosAlarmando.forEach(id => { if (!STATUS_NOVOS.includes(status.get(id))) pedidosAlarmando.delete(id); });
            if (!pedidosAlarmando.size) pararAlertaSom();
        }
        function iniciarAlertaSom() {
            if (!cfg.ativo || silenciado) return;
            resultadoRegistrado = false;
            tocouNesteAlarme = false;
            pararAlertaSom();
            alertaSomInterval = setInterval(tocarAlertaSom, cfg.intervalo_segundos * 1000);
            avisoPedidoNovo(true);
            tocarAlertaSom();
        }

        function pedidoNovo(docs, via) {
            const agora = Date.now();
            docs.forEach(d => pedidosAlarmando.add(d.id));
            registrar('pedido_novo', {
                via,
                silenciado,
                som_ativo: cfg.ativo,
                pedidos: docs.map(d => {
                    const p = d.data() || {};
                    const hora = p.hora_pedido && p.hora_pedido.toDate ? p.hora_pedido.toDate().getTime() : null;
                    return {
                        id: d.id,
                        origem: p.origem || null,
                        status: p.status || null,
                        atraso_segundos: hora ? Math.round((agora - hora) / 1000) : null
                    };
                })
            });
            iniciarAlertaSom();
        }

        // Só toca a partir do segundo snapshot: o primeiro traz os pedidos que
        // já existiam, todos como "added".
        let primeiroSnapshotPedidos = true;
        // Rede de segurança: se a escuta em tempo real travar, uma consulta
        // simples a cada 30s acha pedido que o painel ainda não conhecia.
        const idsConhecidos = new Set();
        let pollIniciado = false;
        setInterval(async () => {
            try {
                const snap = await dbPedidos.collection(COLECAO_PEDIDOS).where("status", "in", STATUS_ATIVOS_PEDIDOS).get();
                const novos = snap.docs.filter(d => !idsConhecidos.has(d.id));
                snap.docs.forEach(d => idsConhecidos.add(d.id));
                if (pollIniciado && novos.length) pedidoNovo(novos, 'verificacao_30s');
                conferirAlarme(snap.docs);
                pollIniciado = true;
            } catch (e) { console.warn('Verificação de pedidos novos:', e.message); }
        }, 30000);

        function ouvirPedidos() {
            dbPedidos.collection(COLECAO_PEDIDOS)
                .where("status", "in", STATUS_ATIVOS_PEDIDOS)
                .onSnapshot(snapshot => {
                    const novos = primeiroSnapshotPedidos ? [] : snapshot.docChanges()
                        .filter(change => change.type === "added" && !idsConhecidos.has(change.doc.id))
                        .map(change => change.doc);
                    snapshot.forEach(doc => idsConhecidos.add(doc.id));
                    primeiroSnapshotPedidos = false;
                    if (novos.length) pedidoNovo(novos, 'tempo_real');
                    conferirAlarme(snapshot.docs);
                }, error => {
                    console.warn("Alerta de pedido novo:", error.message);
                    registrar('escuta_caiu', { erro: String(error && (error.code || error.message)) });
                    primeiroSnapshotPedidos = true; // a nova escuta traz tudo como "added" de novo
                    setTimeout(ouvirPedidos, 5000);
                });
        }
        ouvirPedidos();

        window.GestorChefAlerta = {
            silenciar(valor) { silenciado = !!valor; if (silenciado) pararAlertaSom(); },
            testar() { resultadoRegistrado = false; tocarAlertaSom(); }
        };

        // O registro precisa de login; a escuta de pedidos acima não espera por isso.
        let carregamentoRegistrado = false;
        firebase.auth().onAuthStateChanged(user => {
            if (!user || carregamentoRegistrado) return;
            carregamentoRegistrado = true;
            registrar('painel_carregou', {
                aba_descartada_pelo_navegador: !!document.wasDiscarded,
                ja_teve_clique: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
                navegador: navigator.userAgent
            });
        });
        // Depois de um recarregamento sem clique (atualização automática, aba
        // descartada pelo navegador, F5) o Chrome bloqueia o som até alguém
        // clicar. Testa isso logo ao abrir, com volume zero, e já mostra o
        // aviso — em vez de só descobrir quando um pedido chega mudo.
        setTimeout(() => {
            try {
                const sonda = new Audio(`https://assets.mixkit.co/active_storage/sfx/${cfg.som_id}/${cfg.som_id}-preview.mp3`);
                sonda.volume = 0;
                sonda.play().then(() => sonda.pause()).catch(err => {
                    if (!err || err.name !== 'NotAllowedError') return;
                    avisoSomBloqueado(true);
                    registrar('som_bloqueado_ao_abrir');
                });
            } catch (e) { /* sem áudio neste navegador */ }
        }, 2500);
        document.addEventListener('freeze', () => registrar('aba_congelada_pelo_navegador'));
        document.addEventListener('resume', () => registrar('aba_descongelada'));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
})();
