// Totem de autoatendimento — tela cheia, sem login, pensado pra rodar em
// Chrome kiosk mode (--kiosk --kiosk-printing) num Windows com impressora
// térmica configurada como padrão. Cliente monta o pedido, confirma, recebe
// uma senha (impressa + na tela) e escolhe como pagar: cartão (maquininha
// Point do totem), PIX (QR Code na tela) ou no caixa — este último entra como
// AGUARDANDO_PAGAMENTO, igual às comandas de mesa já funcionam hoje.
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const $ = (id) => document.getElementById(id);

    const COL_CARDAPIO = db.collection('cardapio');
    const COL_PEDIDOS = db.collection('pedidos');
    const DOC_CONTADOR = db.collection('totem_contador').doc('senha');
    const DOC_APP_CFG = db.collection('app_config').doc('geral');
    const DOC_APP_DESTAQUES = db.collection('app_config').doc('destaques');

    let produtos = [];
    let categorias = [];
    let categoriaAtiva = 'Todos';
    let buscaTexto = '';
    let carrinho = []; // [{ id, nome, nome_exibicao, preco, categoria, qtd }]
    let nomeLoja = 'Autoatendimento';
    let tipoConsumo = null; // 'LOCAL' | 'RETIRADA' — escolhido na tela 2
    let tipoCartaoPoint = 'credito'; // 'credito' | 'debito' | 'escolher' (config do painel)

    function money(v) {
        return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // ---------- Marca (reaproveita a config já usada no app do cliente) ----------
    // usaLogotipo: mesma regra do app mobile — mostra OU a logo OU o nome em
    // texto, nunca os dois juntos (identidadeTipo === 'logo' é quem decide).
    DOC_APP_CFG.onSnapshot(snap => {
        const d = snap.exists ? (snap.data() || {}) : {};
        nomeLoja = d.nomeApp || 'Autoatendimento';
        tipoCartaoPoint = d.pointTipoCartao || 'credito';
        // Sem a Point em uso, esconde o Cartão (o cliente ainda tem PIX e caixa).
        const btnCartao = document.querySelector('#tela-pagamento .opcao[data-forma="CARTAO"]');
        if (btnCartao) btnCartao.style.display = d.pointAtiva === false ? 'none' : '';
        if (d.corPrimaria) document.documentElement.style.setProperty('--marca', d.corPrimaria);

        const usaLogotipo = d.identidadeTipo === 'logo' && !!d.logoUrl;
        if (usaLogotipo) {
            $('topo-logo').src = d.logoUrl;
            $('topo-logo').style.display = '';
            $('topo-nome').style.display = 'none';
        } else {
            $('topo-logo').style.display = 'none';
            $('topo-nome').style.display = '';
            $('topo-nome').textContent = nomeLoja;
        }
    }, () => {});

    // Banner de destaque (hero) do app do cliente NÃO aparece aqui de
    // propósito — o totem é presencial, sem cupom pra digitar, então o
    // banner promocional (foco em campanhas/cupons do app) fica só no app.
    DOC_APP_DESTAQUES.onSnapshot(snap => {
        const d = snap.exists ? (snap.data() || {}) : {};
        renderBoasVindas(d.totemBoasVindasUrl || '');
    }, () => {});

    // ---------- Imagem de fundo da tela de boas-vindas (tela 1) ----------
    function renderBoasVindas(url) {
        const tela = $('tela-boas-vindas');
        if (!url) { tela.classList.remove('tem-imagem'); return; }
        tela.style.setProperty('--bv-img', `url('${url}')`);
        tela.classList.add('tem-imagem');
    }

    // ---------- Navegação entre telas 1 → 2 → 3 ----------
    function irParaConsumo() {
        $('tela-boas-vindas').classList.remove('aberta');
        $('tela-consumo').classList.add('aberta');
    }
    function voltarBoasVindas() {
        tipoConsumo = null;
        $('tela-consumo').classList.remove('aberta');
        $('tela-boas-vindas').classList.add('aberta');
    }
    function irParaCardapio(consumo) {
        tipoConsumo = consumo;
        $('tela-consumo').classList.remove('aberta');
    }
    $('tela-boas-vindas').addEventListener('click', irParaConsumo);
    $('btn-voltar-boas-vindas').addEventListener('click', voltarBoasVindas);
    document.querySelectorAll('.tela-consumo .opcao').forEach(btn => {
        btn.addEventListener('click', () => irParaCardapio(btn.dataset.consumo));
    });

    // ---------- Relógio ----------
    function atualizarRelogio() {
        $('relogio').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    atualizarRelogio();
    setInterval(atualizarRelogio, 15000);

    // ---------- Cardápio em tempo real ----------
    // Só considera "disponivel" (o interruptor geral) — é venda presencial,
    // igual ao balcão/mesas, não segue o disponivel_online (app/WhatsApp).
    COL_CARDAPIO.where('disponivel', '==', true).onSnapshot(snap => {
        produtos = [];
        snap.forEach(doc => produtos.push({ id: doc.id, ...doc.data() }));
        categorias = ['Todos', ...new Set(produtos.map(p => p.categoria).filter(Boolean))];
        renderCategorias();
        renderProdutos();
    }, err => {
        $('produtos').innerHTML = `<div class="empty-produtos">Erro ao carregar cardápio: ${escapeHtml(err.message)}</div>`;
    });

    function renderCategorias() {
        $('categorias').innerHTML = categorias.map(cat => `
            <button class="cat-item ${cat === categoriaAtiva ? 'ativa' : ''}" data-cat="${escapeHtml(cat)}">${cat === 'Todos' ? 'Menu Principal' : escapeHtml(cat)}</button>
        `).join('');
        $('categorias').querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                categoriaAtiva = btn.dataset.cat;
                renderCategorias();
                renderProdutos();
            });
        });
    }

    function renderProdutos() {
        let lista = categoriaAtiva === 'Todos' ? produtos : produtos.filter(p => p.categoria === categoriaAtiva);
        if (buscaTexto.trim()) {
            const termo = buscaTexto.trim().toLowerCase();
            lista = lista.filter(p => (p.nome_exibicao || p.nome || '').toLowerCase().includes(termo));
        }

        $('secao-titulo').textContent = buscaTexto.trim()
            ? `Resultados para "${buscaTexto.trim()}"`
            : (categoriaAtiva === 'Todos' ? 'Cardápio' : categoriaAtiva).toUpperCase();

        const wrap = $('produtos');
        if (!lista.length) {
            wrap.innerHTML = '<div class="empty-produtos">Nenhum item encontrado.</div>';
            return;
        }
        wrap.innerHTML = lista.map(p => {
            const nome = p.nome_exibicao || p.nome || 'Item';
            const imgTag = p.imagem_url
                ? `style="background-image:url('${escapeHtml(p.imagem_url)}')"`
                : '';
            const semImg = p.imagem_url ? '' : '🍽️';
            return `<div class="produto-card" data-id="${p.id}">
                <div class="img" ${imgTag}>${semImg}</div>
                <div class="corpo-card">
                    <div class="nome">${escapeHtml(nome)}</div>
                    <div class="rodape-card">
                        <span class="preco">${money(p.preco)}</span>
                        <button class="btn-add" type="button" aria-label="Adicionar">+</button>
                    </div>
                </div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('.produto-card').forEach(card => {
            card.addEventListener('click', () => adicionarAoCarrinho(card.dataset.id));
        });
    }

    // ---------- Sair (equipe) ----------
    // Ícone discreto no cabeçalho — o totem não tem login/menu nenhum de
    // propósito (é tela pública), então isso é só um jeito da equipe voltar
    // pro painel sem precisar fechar o navegador. Confirmação evita que um
    // toque acidental do cliente derrube o totem no meio de um pedido.
    $('btn-sair-totem').addEventListener('click', () => {
        if (confirm('Sair do totem e voltar pro painel?')) {
            window.location.href = '/login.html';
        }
    });

    // ---------- Busca ----------
    $('btn-busca').addEventListener('click', () => {
        $('busca-wrap').classList.toggle('aberta');
        if ($('busca-wrap').classList.contains('aberta')) $('campo-busca').focus();
    });
    $('btn-filtrar').addEventListener('click', () => {
        $('busca-wrap').classList.add('aberta');
        $('campo-busca').focus();
    });
    $('campo-busca').addEventListener('input', (e) => {
        buscaTexto = e.target.value;
        renderProdutos();
    });

    // ---------- Carrinho ----------
    function adicionarAoCarrinho(produtoId) {
        const produto = produtos.find(p => p.id === produtoId);
        if (!produto) return;
        const existente = carrinho.find(i => i.id === produtoId);
        if (existente) {
            existente.qtd += 1;
        } else {
            carrinho.push({
                id: produto.id,
                nome: produto.nome,
                nome_exibicao: produto.nome_exibicao || produto.nome,
                preco: Number(produto.preco) || 0,
                qtd: 1
            });
        }
        atualizarBarraCarrinho();
        piscarCard(produtoId);
    }

    function piscarCard(produtoId) {
        const card = document.querySelector(`.produto-card[data-id="${produtoId}"]`);
        if (!card) return;
        card.style.transform = 'scale(.95)';
        setTimeout(() => { card.style.transform = ''; }, 120);
    }

    function totalCarrinho() {
        return carrinho.reduce((s, i) => s + i.preco * i.qtd, 0);
    }

    function qtdCarrinho() {
        return carrinho.reduce((s, i) => s + i.qtd, 0);
    }

    function atualizarBarraCarrinho() {
        const qtd = qtdCarrinho();
        const btn = $('btn-ver-carrinho');
        if (!qtd) {
            $('carrinho-resumo').textContent = 'Nenhum item selecionado';
            btn.disabled = true;
        } else {
            $('carrinho-resumo').innerHTML = `${qtd} ${qtd === 1 ? 'item' : 'itens'} — <span>${money(totalCarrinho())}</span>`;
            btn.disabled = false;
        }
    }

    function renderCarrinhoModal() {
        const wrap = $('lista-carrinho');
        if (!carrinho.length) {
            wrap.innerHTML = '<p style="color:#7f8c8d;text-align:center;padding:20px 0">Seu carrinho está vazio.</p>';
            return;
        }
        wrap.innerHTML = carrinho.map(i => `
            <div class="carrinho-item" data-id="${i.id}">
                <div class="info">
                    <div class="nome">${escapeHtml(i.nome_exibicao)}</div>
                    <div class="preco-unit">${money(i.preco)} cada</div>
                </div>
                <div class="stepper">
                    <button data-acao="menos">−</button>
                    <span class="qtd">${i.qtd}</span>
                    <button data-acao="mais">+</button>
                </div>
            </div>
        `).join('');
        wrap.querySelectorAll('.carrinho-item').forEach(linha => {
            const id = linha.dataset.id;
            linha.querySelector('[data-acao="mais"]').addEventListener('click', () => alterarQtd(id, 1));
            linha.querySelector('[data-acao="menos"]').addEventListener('click', () => alterarQtd(id, -1));
        });
    }

    function alterarQtd(id, delta) {
        const item = carrinho.find(i => i.id === id);
        if (!item) return;
        item.qtd += delta;
        if (item.qtd <= 0) carrinho = carrinho.filter(i => i.id !== id);
        renderCarrinhoModal();
        atualizarBarraCarrinho();
    }

    $('btn-ver-carrinho').addEventListener('click', () => {
        renderCarrinhoModal();
        $('overlay-carrinho').classList.add('aberto');
    });
    $('fechar-carrinho').addEventListener('click', () => $('overlay-carrinho').classList.remove('aberto'));
    $('btn-continuar-comprando').addEventListener('click', () => $('overlay-carrinho').classList.remove('aberto'));

    // ---------- Confirmar pedido -> forma de pagamento ----------
    const FUNCTIONS_BASE_URL = (window.__CLIENT_CONFIG__ || {}).functionsBaseUrl;
    const TEMPO_ESPERA_CARTAO_MS = 180000;
    const TEMPO_ESPERA_PIX_MS = 240000;
    let pagando = false;       // true enquanto espera cartão/PIX — segura o reset por inatividade
    let senhaAtual = null;     // reaproveitada se o cliente trocar de forma de pagamento
    let aguardaUnsub = null;
    let aguardaTimer = null;
    let aguardaCtx = null;     // { pedidoId, tipo: 'CARTAO' | 'PIX' } do pagamento em andamento

    $('btn-confirmar-pedido').addEventListener('click', () => {
        if (!carrinho.length) return;
        $('overlay-carrinho').classList.remove('aberto');
        abrirTelaPagamento('');
    });

    function abrirTelaPagamento(aviso) {
        $('pag-total').textContent = money(totalCarrinho());
        $('pag-aviso').textContent = aviso;
        $('pag-aviso').style.display = aviso ? '' : 'none';
        $('tela-aguarda-pag').classList.remove('aberta');
        $('tela-pagamento').classList.add('aberta');
    }

    $('btn-pag-voltar').addEventListener('click', () => {
        $('tela-pagamento').classList.remove('aberta');
        $('overlay-carrinho').classList.add('aberto');
    });

    document.querySelectorAll('#tela-pagamento .opcao').forEach(btn => {
        btn.addEventListener('click', async () => {
            const forma = btn.dataset.forma;
            document.querySelectorAll('#tela-pagamento .opcao').forEach(b => { b.disabled = true; });
            try {
                if (forma === 'CAIXA') await pagarNoCaixa();
                else if (forma === 'CARTAO') await pagarCartao();
                else if (forma === 'PIX') await pagarPix();
            } finally {
                document.querySelectorAll('#tela-pagamento .opcao').forEach(b => { b.disabled = false; });
            }
        });
    });

    function itensDoPedido() {
        return carrinho.map(i => ({
            id: i.id,
            nome: i.qtd > 1 ? `${i.qtd}x ${i.nome}` : i.nome,
            nome_exibicao: i.nome_exibicao,
            quantidade: i.qtd,
            preco_unitario: i.preco,
            preco: i.preco * i.qtd
        }));
    }

    function dadosBasePedido(senha, itens, valorTotal) {
        return {
            origem: 'TOTEM',
            senha,
            itens,
            nome_cliente: `Totem #${senha}`,
            tipo_entrega: 'RETIRADA',
            tipo_consumo: tipoConsumo || 'RETIRADA',
            endereco: 'Retirada no balcão',
            valor_total: valorTotal,
            hora_pedido: firebase.firestore.FieldValue.serverTimestamp(),
            data_formatada: new Date().toLocaleString('pt-BR')
        };
    }

    async function obterSenha() {
        if (senhaAtual == null) senhaAtual = await proximaSenha();
        return senhaAtual;
    }

    async function chamarFunction(nome, corpo) {
        const resp = await fetch(`${FUNCTIONS_BASE_URL}/${nome}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(corpo)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.message || data.error || `erro ${resp.status}`);
        return data;
    }

    // Pagar no caixa: comportamento original — pedido fica AGUARDANDO_PAGAMENTO.
    async function pagarNoCaixa() {
        try {
            const senha = await obterSenha();
            const itens = itensDoPedido();
            const total = totalCarrinho();
            await COL_PEDIDOS.add({
                ...dadosBasePedido(senha, itens, total),
                forma_pagamento: null,
                status: 'AGUARDANDO_PAGAMENTO'
            });
            mostrarConfirmacao(senha, itens, total, null);
        } catch (err) {
            abrirTelaPagamento('Não foi possível enviar o pedido: ' + err.message);
        }
    }

    // A Point exige o tipo do cartão. Com a config "escolher", o cliente decide aqui.
    function perguntarTipoCartao() {
        return new Promise(resolve => {
            const tela = $('tela-tipo-cartao');
            const btns = tela.querySelectorAll('.opcao');
            const fechar = valor => {
                tela.classList.remove('aberta');
                btns.forEach(b => b.removeEventListener('click', aoEscolher));
                $('btn-tipo-voltar').removeEventListener('click', aoVoltar);
                resolve(valor);
            };
            const aoEscolher = e => fechar(e.currentTarget.dataset.tipo);
            const aoVoltar = () => fechar(null);
            btns.forEach(b => b.addEventListener('click', aoEscolher));
            $('btn-tipo-voltar').addEventListener('click', aoVoltar);
            $('tela-pagamento').classList.remove('aberta');
            tela.classList.add('aberta');
        });
    }

    async function pagarCartao() {
        let tipoCartao = null;
        if (tipoCartaoPoint === 'escolher') {
            tipoCartao = await perguntarTipoCartao();
            if (!tipoCartao) { abrirTelaPagamento(''); return; }
        }
        const total = totalCarrinho();
        const itens = itensDoPedido();
        const pedidoRef = COL_PEDIDOS.doc();
        mostrarAguarda('Pagamento no cartão', 'Preparando a maquininha...', null, total, false);
        try {
            const senha = await obterSenha();
            const cobranca = await chamarFunction('criarCobrancaPoint', {
                terminal: 'totem',
                tipoCartao,
                amount: total,
                externalReference: pedidoRef.id,
                description: `Totem #${senha}`
            });
            if (!cobranca.id) throw new Error('Resposta inesperada da maquininha.');
            await pedidoRef.set({
                ...dadosBasePedido(senha, itens, total),
                forma_pagamento: 'Cartão',
                status: 'AGUARDANDO_CARTAO',
                status_pos_pagamento: 'PENDENTE_PREPARO',
                pagamento_id: cobranca.id
            });
            mostrarAguarda('Pagamento no cartão', 'Insira, aproxime ou passe o cartão na maquininha.', null, total, true);
            aguardarResultado(pedidoRef, senha, itens, total, 'CARTAO', TEMPO_ESPERA_CARTAO_MS);
        } catch (err) {
            console.warn('totem cartão:', err.message);
            pagando = false;
            abrirTelaPagamento('Não foi possível acionar a maquininha. Escolha outra forma de pagamento.');
        }
    }

    async function pagarPix() {
        const total = totalCarrinho();
        const itens = itensDoPedido();
        const pedidoRef = COL_PEDIDOS.doc();
        mostrarAguarda('Pagamento por PIX', 'Gerando o QR Code...', null, total, false);
        try {
            const senha = await obterSenha();
            const pay = await chamarFunction('processarPagamentoDireto', {
                item: { total: total.toFixed(2), title: `Pedido totem #${senha}` },
                nome: 'Cliente Totem'
            });
            const dados = pay.point_of_interaction && pay.point_of_interaction.transaction_data;
            if (!pay.id || !dados || !dados.qr_code_base64) throw new Error('PIX sem QR Code na resposta.');
            await pedidoRef.set({
                ...dadosBasePedido(senha, itens, total),
                forma_pagamento: 'PIX',
                status: 'AGUARDANDO_PIX',
                pagamento_id: pay.id,
                pix_copia_cola: dados.qr_code || null
            });
            mostrarAguarda('Pagamento por PIX', 'Abra o app do seu banco, escolha pagar com PIX e leia o QR Code.', dados.qr_code_base64, total, true);
            aguardarResultado(pedidoRef, senha, itens, total, 'PIX', TEMPO_ESPERA_PIX_MS);
        } catch (err) {
            console.warn('totem pix:', err.message);
            pagando = false;
            abrirTelaPagamento('Não foi possível gerar o PIX. Escolha outra forma de pagamento.');
        }
    }

    function mostrarAguarda(titulo, msg, qrBase64, total, podeCancelar) {
        pagando = true;
        $('aguarda-titulo').textContent = titulo;
        $('aguarda-msg').textContent = msg;
        $('aguarda-total').textContent = money(total);
        const img = $('pix-qr');
        if (qrBase64) { img.src = 'data:image/png;base64,' + qrBase64; img.style.display = ''; }
        else { img.removeAttribute('src'); img.style.display = 'none'; }
        $('btn-cancelar-pag').style.display = podeCancelar ? '' : 'none';
        $('btn-cancelar-pag').disabled = false;
        $('tela-pagamento').classList.remove('aberta');
        $('tela-aguarda-pag').classList.add('aberta');
    }

    function encerrarAguarda() {
        if (aguardaUnsub) { aguardaUnsub(); aguardaUnsub = null; }
        clearTimeout(aguardaTimer);
        aguardaTimer = null;
        aguardaCtx = null;
        pagando = false;
    }

    // Observa o pedido até o webhook (Point ou PIX) aprovar ou o pagamento ser cancelado.
    function aguardarResultado(pedidoRef, senha, itens, total, tipo, tempoMs) {
        encerrarAguarda();
        pagando = true;
        aguardaCtx = { pedidoId: pedidoRef.id, tipo };
        aguardaUnsub = pedidoRef.onSnapshot(snap => {
            const d = snap.data();
            if (!d || d.status === 'AGUARDANDO_CARTAO' || d.status === 'AGUARDANDO_PIX') return;
            encerrarAguarda();
            if (d.status === 'PENDENTE_PREPARO' || d.status === 'CONCLUIDO') {
                mostrarConfirmacao(senha, itens, total, tipo);
            } else {
                abrirTelaPagamento(d.gateway_state === 'CANCELED_BY_OPERATOR' || d.gateway_state === 'CANCELLED_BY_TOTEM'
                    ? '' : 'O pagamento não foi concluído. Tente novamente ou escolha outra forma.');
            }
        }, err => console.error('totem: erro ao observar pagamento', err));
        aguardaTimer = setTimeout(() => cancelarPagamentoEmAndamento(), tempoMs);
    }

    async function cancelarPagamentoEmAndamento() {
        if (!aguardaCtx) return;
        const { pedidoId, tipo } = aguardaCtx;
        $('btn-cancelar-pag').disabled = true;
        try {
            await chamarFunction(tipo === 'PIX' ? 'cancelarPixTotem' : 'cancelarCobrancaPoint', { pedidoId });
            // O snapshot do pedido (CANCELADO_PAGAMENTO) leva de volta à escolha de pagamento.
            // Se já tinha sido pago (cancelado:false), o snapshot leva à confirmação.
        } catch (err) {
            console.warn('totem: falha ao cancelar pagamento', err.message);
            $('aguarda-msg').textContent = 'Não consegui cancelar agora. Aguarde um instante ou chame um atendente.';
            $('btn-cancelar-pag').disabled = false;
        }
    }
    $('btn-cancelar-pag').addEventListener('click', cancelarPagamentoEmAndamento);

    // Contador de senha: reinicia todo dia (chave = data de hoje), transação
    // atômica pra não repetir número se dois clientes confirmarem junto.
    async function proximaSenha() {
        const hoje = new Date().toISOString().slice(0, 10);
        return db.runTransaction(async (tx) => {
            const snap = await tx.get(DOC_CONTADOR);
            const dados = snap.exists ? snap.data() : {};
            let numero = 1;
            if (dados.data === hoje) numero = (Number(dados.ultima) || 0) + 1;
            tx.set(DOC_CONTADOR, { data: hoje, ultima: numero }, { merge: true });
            return numero;
        });
    }

    function mostrarConfirmacao(senha, itens, total, pago) {
        $('overlay-carrinho').classList.remove('aberto');
        $('tela-pagamento').classList.remove('aberta');
        $('tela-aguarda-pag').classList.remove('aberta');
        $('senha-numero').textContent = String(senha).padStart(3, '0');
        $('conf-msg').textContent = pago
            ? 'Pagamento aprovado! Guarde essa senha e aguarde ser chamado. Seu pedido já foi para a cozinha.'
            : 'Guarde essa senha e dirija-se ao caixa para efetuar o pagamento. Seu pedido vai para a cozinha assim que o pagamento for confirmado.';
        $('tela-confirmacao').classList.add('aberta');
        senhaAtual = null;
        montarCupom(senha, itens, total, pago);
        // kiosk-printing (Chrome --kiosk --kiosk-printing) imprime direto,
        // sem diálogo. Em navegador normal abre o diálogo de impressão —
        // funciona igual, só precisa confirmar manualmente nesse caso.
        setTimeout(() => window.print(), 300);
    }

    function montarCupom(senha, itens, total, pago) {
        const linhas = itens.map(i =>
            `<div class="linha"><span>${escapeHtml(i.nome)}</span><span>${money(i.preco)}</span></div>`
        ).join('');
        const rotuloConsumo = tipoConsumo === 'LOCAL' ? 'COMER AQUI' : 'LEVAR';
        $('cupom-impressao').innerHTML = `
            <h1>${escapeHtml(nomeLoja)}</h1>
            <div style="text-align:center">Autoatendimento — ${rotuloConsumo}</div>
            <div class="senha-grande">SENHA ${String(senha).padStart(3, '0')}</div>
            <hr>
            ${linhas}
            <hr>
            <div class="linha total"><span>TOTAL</span><span>${money(total)}</span></div>
            <hr>
            <div style="text-align:center">${pago ? 'PAGO (' + (pago === 'PIX' ? 'PIX' : 'cartão') + ') — aguarde sua senha' : 'Pague no caixa e aguarde sua senha'}</div>
            <div style="text-align:center">${new Date().toLocaleString('pt-BR')}</div>
        `;
    }

    $('btn-novo-pedido').addEventListener('click', () => {
        carrinho = [];
        senhaAtual = null;
        categoriaAtiva = 'Todos';
        atualizarBarraCarrinho();
        renderCategorias();
        renderProdutos();
        $('tela-confirmacao').classList.remove('aberta');
        voltarBoasVindas();
    });

    // Reset automático de segurança: se o cliente sumir sem tocar em "Novo
    // pedido", a tela de confirmação não pode ficar travada esperando o
    // próximo cliente pra sempre.
    let resetTimer = null;
    document.addEventListener('DOMContentLoaded', () => {});
    const observerReset = new MutationObserver(() => {
        clearTimeout(resetTimer);
        if ($('tela-confirmacao').classList.contains('aberta')) {
            resetTimer = setTimeout(() => $('btn-novo-pedido').click(), 30000);
        }
    });
    observerReset.observe($('tela-confirmacao'), { attributes: true, attributeFilter: ['class'] });

    // Reset por inatividade geral: se o cliente abandonar o totem no meio da
    // navegação (tela 2 ou catálogo, com ou sem itens no carrinho), volta
    // sozinho pra tela de boas-vindas depois de um tempo parado, senão o
    // totem fica "preso" na sessão do cliente anterior.
    let inatividadeTimer = null;
    function reiniciarInatividade() {
        clearTimeout(inatividadeTimer);
        if ($('tela-boas-vindas').classList.contains('aberta')) return;
        inatividadeTimer = setTimeout(() => {
            if (pagando) return; // esperando cartão/PIX: o próprio pagamento tem timeout
            carrinho = [];
            senhaAtual = null;
            $('tela-pagamento').classList.remove('aberta');
            $('tela-tipo-cartao').classList.remove('aberta');
            categoriaAtiva = 'Todos';
            atualizarBarraCarrinho();
            renderCategorias();
            renderProdutos();
            $('overlay-carrinho').classList.remove('aberto');
            voltarBoasVindas();
        }, 90000);
    }
    ['click', 'touchstart'].forEach(evento => document.addEventListener(evento, reiniciarInatividade));
});
