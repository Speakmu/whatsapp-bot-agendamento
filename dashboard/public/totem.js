// Totem de autoatendimento — tela cheia, sem login, pensado pra rodar em
// Chrome kiosk mode (--kiosk --kiosk-printing) num Windows com impressora
// térmica configurada como padrão. Cliente monta o pedido, confirma, recebe
// uma senha (impressa + na tela) e paga no caixa — o pedido entra como
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

    // ---------- Confirmar pedido ----------
    $('btn-confirmar-pedido').addEventListener('click', async () => {
        if (!carrinho.length) return;
        const btn = $('btn-confirmar-pedido');
        btn.disabled = true;
        btn.textContent = 'Enviando...';
        try {
            const senha = await proximaSenha();
            const itensPedido = carrinho.map(i => ({
                id: i.id,
                nome: i.qtd > 1 ? `${i.qtd}x ${i.nome}` : i.nome,
                nome_exibicao: i.nome_exibicao,
                quantidade: i.qtd,
                preco_unitario: i.preco,
                preco: i.preco * i.qtd
            }));
            const valorTotal = totalCarrinho();
            const agora = new Date();

            await COL_PEDIDOS.add({
                origem: 'TOTEM',
                senha,
                itens: itensPedido,
                nome_cliente: `Totem #${senha}`,
                tipo_entrega: 'RETIRADA',
                tipo_consumo: tipoConsumo || 'RETIRADA',
                endereco: 'Retirada no balcão',
                forma_pagamento: null,
                valor_total: valorTotal,
                status: 'AGUARDANDO_PAGAMENTO',
                hora_pedido: firebase.firestore.FieldValue.serverTimestamp(),
                data_formatada: agora.toLocaleString('pt-BR')
            });

            mostrarConfirmacao(senha, itensPedido, valorTotal);
        } catch (err) {
            alert('Não foi possível enviar o pedido: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Confirmar pedido';
        }
    });

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

    function mostrarConfirmacao(senha, itens, total) {
        $('overlay-carrinho').classList.remove('aberto');
        $('senha-numero').textContent = String(senha).padStart(3, '0');
        $('tela-confirmacao').classList.add('aberta');
        montarCupom(senha, itens, total);
        // kiosk-printing (Chrome --kiosk --kiosk-printing) imprime direto,
        // sem diálogo. Em navegador normal abre o diálogo de impressão —
        // funciona igual, só precisa confirmar manualmente nesse caso.
        setTimeout(() => window.print(), 300);
    }

    function montarCupom(senha, itens, total) {
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
            <div style="text-align:center">Pague no caixa e aguarde sua senha</div>
            <div style="text-align:center">${new Date().toLocaleString('pt-BR')}</div>
        `;
    }

    $('btn-novo-pedido').addEventListener('click', () => {
        carrinho = [];
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
            carrinho = [];
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
