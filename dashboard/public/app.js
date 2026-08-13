// Redimensiona/comprime a foto do produto no navegador antes de enviar pro
// Storage — sem isso, fotos de câmera de celular (vários MB cada) são
// baixadas em tamanho real toda vez que a grade de produtos aparece
// (Cardápio, Caixa, Mesas, Totem, app do cliente), pesando muito numa
// conexão/computador mais fraco. 900px de lado maior é sobra pra exibição
// em card — resultado tipicamente sai abaixo de 200KB.
function redimensionarImagem(file, maxDim = 900, qualidade = 0.82) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
                if (width >= height) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                } else {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error('Falha ao comprimir imagem')),
                'image/jpeg',
                qualidade
            );
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler a imagem')); };
        img.src = url;
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Apenas a configuração do Firebase é definida fora do DOMContentLoaded
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    // Configuração do áudio de notificação
    const somNotificacao = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    // Preview da imagem ao selecionar
    document.getElementById('product-image').addEventListener('change', function (e) {
        const reader = new FileReader();
        const preview = document.getElementById('image-preview');

        reader.onload = function (event) {
            preview.src = event.target.result;
            preview.style.display = 'block';
        }

        if (e.target.files[0]) {
            reader.readAsDataURL(e.target.files[0]);
        }
    });

    // Permite colar (Ctrl+V) um print da área de transferência como imagem do produto
    document.addEventListener('paste', function (e) {
        const productImageInput = document.getElementById('product-image');
        if (!productImageInput) return;

        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file) continue;

                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                productImageInput.files = dataTransfer.files;
                productImageInput.dispatchEvent(new Event('change'));
                break;
            }
        }
    });

    // Inicializa Firebase apenas se ainda não foi iniciado
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
    let menuItems = [];
    const db = firebase.firestore();
    const auth = firebase.auth();

    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
        .catch((error) => {
            console.error("Erro de persistência:", error);
        });
    const COLECAO_PEDIDOS = "pedidos";
    const COLECAO_CARDAPIO = "cardapio";
    const COLECAO_ENTREGADORES = "entregadores";
    // Backend real do bot no Render — antes apontava pra um túnel ngrok
    // antigo e morto (as notificações de "pedido pronto" nunca chegavam).
    const ngrokUrl = "https://whatsapp-bot-agendamento.onrender.com";
    const STATUS_ATIVOS_PEDIDOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"];
    const STATUS_NAO_FATURA = new Set(["CANCELADO", "AGUARDANDO_PAGAMENTO", "AGUARDANDO_PIX"]);
    const moneyBR = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');

    // --- ELEMENTOS DO PAINEL E CARDÁPIO ---
    const logoutButton = document.getElementById('logout-button');
    const ordersList = document.getElementById('orders-list');
    const totalPedidosSpan = document.getElementById('total-pedidos');

    // Elementos da Troca de Tela
    const ordersView = document.getElementById('pedidos-ativos');
    const menuView = document.getElementById('cardapio-manager');
    const btnPedidos = document.getElementById('btn-pedidos');
    const btnCardapio = document.getElementById('btn-cardapio');

    // Elementos do Formulário
    const productForm = document.getElementById('product-form');
    const productMessage = document.getElementById('product-message');

    //ELEMENTOS DE RELATÓRIOS
    const btnRelatorios = document.getElementById('btn-relatorios');
    const reportsView = document.getElementById('reports-view');
    const btnAplicarFiltro = document.getElementById('btn-aplicar-filtro');
    const btnExportarCsv = document.getElementById('btn-exportar-csv');
    const reportBody = document.getElementById('report-body');
    const statTicketMedio = document.getElementById('stat-ticket-medio');
    const statFaturamento = document.getElementById('stat-faturamento');
    const statQtdPedidos = document.getElementById('stat-qtd-pedidos');
    const filterRanking = document.getElementById('filter-ranking');
    let viewSwitchingReady = false;
    let dataListenersStarted = false;
    let productFormReady = false;
    let menuListenerStarted = false;
    let entregadoresAtivos = [];
    let pedidosCache = {};

    setupViewSwitching();


    // --- VERIFICAÇÃO DE LOGIN E INICIALIZAÇÃO ---
    auth.onAuthStateChanged((user) => {
        if (user) {
            if (!dataListenersStarted) {
                dataListenersStarted = true;
                startOrderListener();
                startOrdersTodayDashboard();
                ouvirEntregadoresAtivos();
                // Cardápio (com as fotos de cada item) só carrega quando a
                // aba Cardápio é realmente aberta — antes rodava sempre,
                // mesmo só olhando Pedidos, baixando dezenas de imagens à
                // toa numa conexão mais lenta.
                if (viewFromHash() === 'cardapio') garantirMenuListener();
            }
            if (!productFormReady) {
                productFormReady = true;
                setupProductForm();
            }
        } else {
            window.location.href = '/login.html';
        }
    });

    function garantirMenuListener() {
        if (menuListenerStarted) return;
        menuListenerStarted = true;
        startMenuListener();
    }

    // Lista leve de entregadores ativos — só pro atalho "Despachar" no
    // card de pedido (mesma coleção que o módulo Entregas já usa).
    function ouvirEntregadoresAtivos() {
        db.collection(COLECAO_ENTREGADORES).orderBy("nome").onSnapshot(snap => {
            entregadoresAtivos = [];
            snap.forEach(d => {
                const data = d.data();
                if (data.ativo !== false) entregadoresAtivos.push({ id: d.id, nome: data.nome });
            });
            // Re-renderiza as ações dos cards já na tela pra refletir a
            // lista de entregadores mais recente (o pedido em si não mudou).
            if (ordersList) {
                ordersList.querySelectorAll('.order-card').forEach(card => {
                    const acoes = card.querySelector('.order-actions[data-status]');
                    if (acoes) acoes.innerHTML = createStatusButtons(acoes.dataset.status, card.id.replace('card-', ''), acoes.dataset.entrega === '1');
                });
                attachButtonListeners();
            }
        }, err => console.warn("Erro ao carregar entregadores:", err.message));
    }
    // Função para carregar e exibir o cardápio
    const selectedMenuIds = new Set();
    let currentMenuView = [];

    function startMenuListener() {
        const menuContainer = document.getElementById('menu-list-container');
        const searchInput = document.getElementById('search-menu');

        db.collection(COLECAO_CARDAPIO).orderBy("categoria").onSnapshot(snapshot => {
            menuItems = [];
            snapshot.forEach(doc => {
                menuItems.push({ id: doc.id, ...doc.data() });
            });
            // Remove da seleção itens que não existem mais
            const idsAtuais = new Set(menuItems.map(i => i.id));
            [...selectedMenuIds].forEach(id => { if (!idsAtuais.has(id)) selectedMenuIds.delete(id); });
            renderMenu(menuItems);
            renderCategoryToolbar(menuItems);
        });

        // Filtro de pesquisa
        searchInput.addEventListener('input', (e) => {
            const termo = e.target.value.toLowerCase();
            const filtrados = menuItems.filter(item =>
                String(item.nome_exibicao || '').toLowerCase().includes(termo) ||
                String(item.categoria || '').toLowerCase().includes(termo) ||
                String(item.ncm || '').includes(termo) ||
                String(item.cfop || '').includes(termo)
            );
            renderMenu(filtrados);
        });

        setupBulkToolbar();
    }

    function setupBulkToolbar() {
        const selectAll = document.getElementById('menu-select-all');
        const btnAtivar = document.getElementById('btn-bulk-ativar');
        const btnPausar = document.getElementById('btn-bulk-pausar');
        if (!selectAll || selectAll.dataset.bound) return;
        selectAll.dataset.bound = "1";

        selectAll.addEventListener('change', () => {
            currentMenuView.forEach(item => {
                if (selectAll.checked) selectedMenuIds.add(item.id);
                else selectedMenuIds.delete(item.id);
            });
            renderMenu(currentMenuView);
        });

        btnAtivar.addEventListener('click', () => aplicarDisponibilidadeEmMassa(true));
        btnPausar.addEventListener('click', () => aplicarDisponibilidadeEmMassa(false));
    }

    async function aplicarDisponibilidadeEmMassa(disponivel) {
        if (selectedMenuIds.size === 0) return;
        const btnAtivar = document.getElementById('btn-bulk-ativar');
        const btnPausar = document.getElementById('btn-bulk-pausar');
        btnAtivar.disabled = true;
        btnPausar.disabled = true;
        try {
            const batch = db.batch();
            selectedMenuIds.forEach(id => {
                batch.update(db.collection(COLECAO_CARDAPIO).doc(id), {
                    disponivel: disponivel,
                    ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
            await batch.commit();
            selectedMenuIds.clear();
            // O onSnapshot atualiza a lista automaticamente
        } catch (e) {
            console.error("Erro ao atualizar disponibilidade em massa:", e);
            alert("Erro ao atualizar os itens selecionados.");
        }
    }

    // Botões rápidos por categoria — só afetam disponivel_online (app/bot),
    // igual ao botão individual "Esgotar no App/Bot". Balcão/mesas/KDS não
    // são tocados, então a loja continua vendendo por lá normalmente.
    function renderCategoryToolbar(itens) {
        const wrap = document.getElementById('menu-category-buttons');
        if (!wrap) return;

        const categorias = [...new Set(itens.map(i => i.categoria).filter(Boolean))].sort();
        wrap.innerHTML = categorias.map(cat => {
            const itensCategoria = itens.filter(i => i.categoria === cat);
            const algumDisponivelOnline = itensCategoria.some(i => i.disponivel_online !== false);
            const label = cat.replace(/_/g, ' ');
            return `<button type="button" class="btn-status"
                onclick="window.toggleCategoriaOnline('${cat.replace(/'/g, "\\'")}', ${algumDisponivelOnline})"
                style="background: ${algumDisponivelOnline ? '#e67e22' : '#2ecc71'}; font-size:.8rem; padding:6px 10px;">
                ${algumDisponivelOnline ? 'Esgotar' : 'Repor'} ${label}
            </button>`;
        }).join('');
    }

    window.toggleCategoriaOnline = async (categoria, statusAtual) => {
        const disponivelOnline = !statusAtual;
        const itensCategoria = menuItems.filter(i => i.categoria === categoria);
        if (!itensCategoria.length) return;
        if (!confirm(`${disponivelOnline ? 'Repor' : 'Esgotar'} todos os itens de "${categoria}" no app/WhatsApp?`)) return;
        try {
            const batch = db.batch();
            itensCategoria.forEach(item => {
                batch.update(db.collection(COLECAO_CARDAPIO).doc(item.id), {
                    disponivel_online: disponivelOnline,
                    ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
            await batch.commit();
        } catch (e) {
            console.error("Erro ao atualizar categoria:", e);
            alert("Erro ao atualizar a categoria no app/WhatsApp.");
        }
    };

    function atualizarToolbarSelecao() {
        const selectAll = document.getElementById('menu-select-all');
        const countLabel = document.getElementById('menu-selected-count');
        const btnAtivar = document.getElementById('btn-bulk-ativar');
        const btnPausar = document.getElementById('btn-bulk-pausar');
        if (!selectAll) return;

        const count = selectedMenuIds.size;
        countLabel.textContent = `${count} selecionado(s)`;
        btnAtivar.disabled = count === 0;
        btnPausar.disabled = count === 0;

        const visibleIds = currentMenuView.map(i => i.id);
        const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedMenuIds.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = !allSelected && visibleIds.some(id => selectedMenuIds.has(id));
    }

    window.toggleSelecionadoMenu = function (id, checked) {
        if (checked) selectedMenuIds.add(id);
        else selectedMenuIds.delete(id);
        atualizarToolbarSelecao();
    };

    // 3. Função para desenhar os cards na tela
    function renderMenu(itens) {
        const container = document.getElementById('menu-list-container');
        container.innerHTML = "";
        currentMenuView = itens;

        itens.forEach(item => {
            const card = document.createElement('div');
            const onlineDisponivel = item.disponivel_online !== false;
            card.className = `menu-item-card ${item.disponivel ? 'is-available' : 'is-paused'}`;

            // Define a imagem ou um placeholder cinza caso não tenha foto
            const imgTag = item.imagem_url
                ? `<img class="menu-item-img" src="${item.imagem_url}" alt="${item.nome_exibicao || 'Produto'}">`
                : `<div class="menu-item-img menu-item-empty">Sem foto</div>`;

            const isChecked = selectedMenuIds.has(item.id);

            card.innerHTML = `
        <div class="menu-item-media">${imgTag}</div>
        <div class="menu-item-body">
            <div class="menu-item-head">
                <div style="display:flex; align-items:flex-start; gap:8px;">
                    <input type="checkbox" onchange="window.toggleSelecionadoMenu('${item.id}', this.checked)"
                        ${isChecked ? 'checked' : ''} style="margin-top:4px;">
                    <div>
                        <strong class="menu-item-name">${item.nome_exibicao}</strong>
                        <small class="menu-item-category">${item.categoria.replace('_', ' ')}</small>
                    </div>
                </div>
                <span class="menu-item-price">R$ ${item.preco.toFixed(2)}</span>
            </div>
            <p class="menu-item-desc">${item.ingredientes || 'Sem descricao cadastrada.'}</p>
            <div class="menu-item-tags">
                <small style="background:#eef2f7;border:1px solid #d9e1ea;border-radius:999px;padding:3px 8px;">NCM: ${item.ncm || 'padrão'}</small>
                <small style="background:#eef2f7;border:1px solid #d9e1ea;border-radius:999px;padding:3px 8px;">CFOP: ${item.cfop || 'padrão'}</small>
                <small style="background:#eef2f7;border:1px solid #d9e1ea;border-radius:999px;padding:3px 8px;">CSOSN/CST: ${item.csosn || item.cst || 'padrão'}</small>
                <small style="background:#eef2f7;border:1px solid #d9e1ea;border-radius:999px;padding:3px 8px;">Origem: ${item.origem || 'padrão'}</small>
            </div>
            <div class="menu-item-actions">
                <button onclick="prepararEdicao('${item.id}')" class="btn-status btn-edit">Editar</button>
                
                <button onclick="window.toggleDisponibilidade('${item.id}', ${item.disponivel})"
                    class="btn-status"
                    style="background: ${item.disponivel ? '#95a5a6' : '#2ecc71'};"
                    title="Afeta balcão, mesas, KDS, app e WhatsApp">
                    ${item.disponivel ? 'Pausar (geral)' : 'Ativar (geral)'}
                </button>

                <button onclick="window.toggleDisponibilidadeOnline('${item.id}', ${onlineDisponivel})"
                    class="btn-status"
                    style="background: ${onlineDisponivel ? '#e67e22' : '#2ecc71'};"
                    title="Só afeta app e WhatsApp — continua vendendo no balcão">
                    ${onlineDisponivel ? 'Esgotar no App/Bot' : 'Repor no App/Bot'}
                </button>

                <button onclick="deletarItem('${item.id}')" class="btn-status btn-delete">Excluir</button>
            </div>
        </div>
    `;
            container.appendChild(card);
        });

        atualizarToolbarSelecao();
    }

    // 4. Função para carregar dados no formulário para editar
    window.prepararEdicao = function (id) {
        // Busca o item no array local carregado pelo listener
        const item = menuItems.find(i => i.id === id);
        if (!item) return;

        // Preenche os campos do formulário
        document.getElementById('editing-id').value = id;
        document.getElementById('product-nome').value = item.nome_exibicao;
        document.getElementById('product-categoria').value = item.categoria;
        document.getElementById('product-preco').value = item.preco;
        document.getElementById('product-ingredientes').value = item.ingredientes;
        document.getElementById('product-disponivel').checked = item.disponivel;
        document.getElementById('product-pontos').value = item.pontos_fidelidade || 0;
        document.getElementById('product-ncm').value = item.ncm || '';
        document.getElementById('product-cfop').value = item.cfop || '';
        document.getElementById('product-csosn').value = item.csosn || item.cst || '';
        document.getElementById('product-origem').value = item.origem || '';

        // Atualiza o visual do formulário para modo edição
        document.getElementById('form-title').innerText = "Editar Item";
        const btnSubmit = document.getElementById('btn-submit-product');
        btnSubmit.innerText = "Atualizar Item";
        btnSubmit.style.background = "#3498db";
        document.getElementById('btn-cancel-edit').style.display = "inline-block";

        // Mostra o preview da imagem se ela existir
        const preview = document.getElementById('image-preview');
        if (item.imagem_url) {
            preview.src = item.imagem_url;
            preview.style.display = 'block';
        } else {
            preview.style.display = 'none';
        }

        // Rola a tela até o formulário
        document.getElementById('cardapio-manager').scrollIntoView({ behavior: 'smooth' });
    };

    // 5. Função para cancelar edição
    function cancelarEdicao() {
        // 1. Limpa o formulário
        document.getElementById('product-form').reset();

        // 2. Limpa o ID oculto (para o sistema saber que não está mais editando)
        const editingIdInput = document.getElementById('editing-id');
        if (editingIdInput) editingIdInput.value = "";

        // 3. Volta os textos originais dos botões e títulos
        document.getElementById('form-title').innerText = "Cadastrar Novo Item";
        const btnSubmit = document.getElementById('btn-submit-product');
        btnSubmit.innerText = "Salvar Item";
        btnSubmit.style.background = "#27ae60";

        // 4. Esconde o botão de cancelar
        document.getElementById('btn-cancel-edit').style.display = "none";
    }

    // 6. Atualizar o "Salvar" para suportar Edição 
    async function setupProductForm() {
        const productForm = document.getElementById('product-form');

        if (!productForm) return;

        productForm.onsubmit = async (e) => {
            e.preventDefault();
            const editingId = document.getElementById('editing-id').value;
            const productMessage = document.getElementById('product-message');

            const nome = document.getElementById('product-nome').value;
            const categoria = document.getElementById('product-categoria').value;
            const preco = parseFloat(document.getElementById('product-preco').value);
            const ingredientes = document.getElementById('product-ingredientes').value;
            const disponivel = document.getElementById('product-disponivel').checked;
            const pontosFidelidade = parseInt(document.getElementById('product-pontos').value) || 0;
            const ncm = document.getElementById('product-ncm').value.trim();
            const cfop = document.getElementById('product-cfop').value.trim();
            const csosn = document.getElementById('product-csosn').value.trim();
            const origem = document.getElementById('product-origem').value;
            // 1. Pega o arquivo de imagem do input que adicionamos
            const imageFile = document.getElementById('product-image').files[0];
            let imageUrl = null;

            if (!nome || isNaN(preco)) {
                productMessage.style.color = '#e74c3c';
                productMessage.textContent = 'Preencha os campos obrigatórios.';
                return;
            }

            productMessage.style.color = '#3498db';
            productMessage.textContent = 'Processando...';

            try {
                // 2. Lógica de Upload da Imagem (se houver arquivo novo)
                if (imageFile) {
                    productMessage.textContent = 'Comprimindo imagem...';
                    const imagemComprimida = await redimensionarImagem(imageFile);

                    productMessage.textContent = 'Fazendo upload da imagem...';
                    const storageRef = firebase.storage().ref();
                    const fileName = `cardapio/${Date.now()}_${imageFile.name.replace(/\.[^.]+$/, '')}.jpg`;
                    const fileRef = storageRef.child(fileName);

                    const snapshot = await fileRef.put(imagemComprimida, { contentType: 'image/jpeg' });
                    imageUrl = await snapshot.ref.getDownloadURL();
                }

                // 3. Monta o objeto com o campo imagem_url
                const productData = {
                    nome: nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ""),
                    nome_exibicao: nome,
                    categoria: categoria,
                    preco: preco,
                    ingredientes: ingredientes,
                    disponivel: disponivel,
                    pontos_fidelidade: pontosFidelidade,
                    ncm: ncm,
                    cfop: cfop,
                    csosn: csosn,
                    cst: csosn,
                    origem: origem,
                    ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
                };

                // Se uma nova imagem foi enviada, adicionamos ao objeto. 
                // Se não, o Firestore não alterará o campo imagem_url já existente na edição.
                if (imageUrl) {
                    productData.imagem_url = imageUrl;
                }

                if (editingId) {
                    await db.collection(COLECAO_CARDAPIO).doc(editingId).update(productData);
                    productMessage.style.color = '#2ecc71';
                    productMessage.textContent = `Item "${nome}" atualizado com sucesso!`;

                    // Limpa o preview da imagem
                    document.getElementById('image-preview').style.display = 'none';

                    if (typeof cancelarEdicao === "function") cancelarEdicao();
                } else {
                    await db.collection(COLECAO_CARDAPIO).add(productData);
                    productMessage.style.color = '#2ecc71';
                    productMessage.textContent = `Item "${nome}" cadastrado com sucesso!`;

                    // Limpa o formulário e o preview
                    productForm.reset();
                    document.getElementById('image-preview').style.display = 'none';
                }
            } catch (error) {
                console.error("Erro ao salvar:", error);
                productMessage.style.color = '#e74c3c';
                productMessage.textContent = 'Erro ao salvar o produto.';
            }
        };
    }
    // Função para limpar o formulário e resetar o modo de edição
    window.cancelarEdicao = () => {
        const productForm = document.getElementById('product-form');
        const preview = document.getElementById('image-preview');
        const editingIdInput = document.getElementById('editing-id');
        const formTitle = document.getElementById('form-title');
        const btnSubmit = document.getElementById('btn-submit-product');
        const btnCancel = document.getElementById('btn-cancel-edit');

        // 1. Limpa todos os campos de texto e o seletor de arquivo
        productForm.reset();

        // 2. Limpa o ID de edição (campo hidden)
        if (editingIdInput) editingIdInput.value = '';

        // 3. ESCONDE E LIMPA O PREVIEW DA IMAGEM (O que você pediu)
        if (preview) {
            preview.src = '';
            preview.style.display = 'none';
        }

        // 4. Volta o visual do formulário para o modo "Cadastrar"
        if (formTitle) formTitle.innerText = "Cadastrar Novo Item";
        if (btnSubmit) {
            btnSubmit.innerText = "Cadastrar Item";
            btnSubmit.style.background = "#e74c3c"; // Cor original (vermelha)
        }

        // 5. Esconde o próprio botão cancelar
        if (btnCancel) btnCancel.style.display = "none";
    };
    // Funções Auxiliares (Excluir e Pausar)
    window.toggleDisponibilidade = async (id, statusAtual) => {
        try {
            // Importante: statusAtual vem do HTML como true/false
            await db.collection("cardapio").doc(id).update({
                disponivel: !statusAtual,
                ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
            });
            // O onSnapshot cuida de atualizar a lista na tela automaticamente
        } catch (e) {
            console.error("Erro ao mudar status:", e);
            alert("Erro ao atualizar disponibilidade.");
        }
    };

    window.toggleDisponibilidadeOnline = async (id, statusAtual) => {
        try {
            // statusAtual vem do HTML como true/false. Esse campo não afeta
            // balcão/mesas/KDS — só o que o app e o bot do WhatsApp mostram
            // e aceitam pedir.
            await db.collection("cardapio").doc(id).update({
                disponivel_online: !statusAtual,
                ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error("Erro ao mudar status online:", e);
            alert("Erro ao atualizar disponibilidade no app/WhatsApp.");
        }
    };

    // Função para Deletar
    window.deletarItem = async (id) => {
        if (confirm("Deseja realmente excluir este produto do cardápio?")) {
            try {
                await db.collection("cardapio").doc(id).delete();
            } catch (e) {
                console.error("Erro ao excluir:", e);
                alert("Erro ao excluir item.");
            }
        }
    };
    // Função carrregar relatório
    async function carregarRelatorio() {
        const dataInicio = document.getElementById('filter-date-start').value;
        const dataFim = document.getElementById('filter-date-end').value;
        const ranking = document.getElementById('filter-ranking').value;

        if (!dataInicio || !dataFim) {
            alert("Selecione o período!");
            return;
        }

        const start = new Date(dataInicio + "T00:00:00");
        const end = new Date(dataFim + "T23:59:59");

        try {
            const snapshot = await db.collection(COLECAO_PEDIDOS)
                .where("hora_pedido", ">=", start)
                .where("hora_pedido", "<=", end)
                .get();

            let pedidos = [];
            snapshot.forEach(doc => pedidos.push({ id: doc.id, ...doc.data() }));

            // Filtra cancelados para não sujar a inteligência de vendas
            pedidos = pedidos.filter(p => p.status !== 'CANCELADO');

            processarERenderizarRelatorio(pedidos, ranking);

        } catch (e) {
            console.error("Erro no relatório:", e);
        }
    }
    function processarERenderizarRelatorio(pedidos, ranking) {
        const tableBody = document.getElementById('report-body');
        tableBody.innerHTML = '';

        let faturamento = 0;
        let contagemProdutos = {};
        let contagemHoras = {};

        pedidos.forEach(p => {
            faturamento += Number(p.valor_total || 0);

            // --- CORREÇÃO DA INTELIGÊNCIA DE PRODUTOS ---
            if (p.itens && Array.isArray(p.itens)) {
                // Novo formato: Array de objetos
                p.itens.forEach(item => {
                    const nome = (typeof item === 'object') ? item.nome : item;
                    // Remove o "2x " do início para contar corretamente no ranking
                    const nomeLimpo = nome.replace(/^\d+x\s/, '');
                    contagemProdutos[nomeLimpo] = (contagemProdutos[nomeLimpo] || 0) + 1;
                });
            } else if (p.item_pedido) {
                // Formato antigo: String separada por vírgula
                p.item_pedido.split(', ').forEach(str => {
                    const [qtdStr, nome] = str.split('x ');
                    const qtd = parseInt(qtdStr) || 1;
                    if (nome) contagemProdutos[nome] = (contagemProdutos[nome] || 0) + qtd;
                });
            }

            // Hora do pedido
            const hora = p.hora_pedido?.toDate ? p.hora_pedido.toDate().getHours() : 0;
            contagemHoras[hora] = (contagemHoras[hora] || 0) + 1;
        });

        // Atualiza estatísticas no topo
        const topProduto = Object.keys(contagemProdutos).reduce((a, b) => contagemProdutos[a] > contagemProdutos[b] ? a : b, "---");

        document.getElementById('stat-faturamento').innerText = `R$ ${faturamento.toFixed(2)}`;
        document.getElementById('stat-qtd-pedidos').innerText = pedidos.length;
        document.getElementById('stat-ticket-medio').innerText = `R$ ${(pedidos.length ? faturamento / pedidos.length : 0).toFixed(2)}`;
        if (document.getElementById('stat-produto-campeao')) document.getElementById('stat-produto-campeao').innerText = topProduto;

        // Ordenação
        if (ranking === 'maior_valor') pedidos.sort((a, b) => b.valor_total - a.valor_total);

        // Renderiza Tabela
        pedidos.forEach(p => {
            const tr = document.createElement('tr');

            // Formata itens para a tabela (Lista vertical)
            let itensLista = '';
            if (p.itens && Array.isArray(p.itens)) {
                itensLista = p.itens.map(i => `<div>• ${(typeof i === 'object' ? i.nome : i)}</div>`).join('');
            } else {
                itensLista = p.item_pedido || p.itens_pedido || '---';
            }

            tr.innerHTML = `
            <td><small>${p.hora_pedido?.toDate().toLocaleString('pt-BR') || '---'}</small></td>
            <td><strong>${p.nome_cliente || 'Cliente'}</strong></td>
            <td class="report-items">${itensLista}</td>
            <td class="report-total">R$ ${Number(p.valor_total || 0).toFixed(2)}</td>
            <td><span class="report-status badge-${p.status}">${p.status || '-'}</span></td>
        `;
            tableBody.appendChild(tr);
        });
    }

    // 2. O botão agora apenas chama a função principal
    btnAplicarFiltro.addEventListener('click', carregarRelatorio);

    // ---  LÓGICA DE NAVEGAÇÃO (Troca de Visualização) ---
    // Mostra a view escolhida (navegação agora vem da barra lateral)
    function mostrarView(view) {
        if (view === 'cardapio' && dataListenersStarted) garantirMenuListener();
        const views = { pedidos: ordersView, cardapio: menuView, relatorios: reportsView };
        Object.values(views).forEach(v => { if (v) v.style.display = 'none'; });
        (views[view] || ordersView).style.display = 'block';
        // mantém compatibilidade caso existam botões internos
        [btnPedidos, btnCardapio, btnRelatorios].forEach(b => b && b.classList.remove('active'));
        const map = { pedidos: btnPedidos, cardapio: btnCardapio, relatorios: btnRelatorios };
        if (map[view]) map[view].classList.add('active');
        // título dinâmico do cabeçalho
        const titulos = { pedidos: '🍕 Pedidos Ativos', cardapio: '🍕 Gerenciar Cardápio', relatorios: '🍕 Relatórios' };
        const elTitulo = document.getElementById('painel-titulo');
        if (elTitulo) elTitulo.textContent = titulos[view] || titulos.pedidos;
    }

    function viewFromHash() {
        const h = (location.hash || '').replace('#', '');
        return ['cardapio', 'relatorios', 'pedidos'].includes(h) ? h : 'pedidos';
    }

    function setupViewSwitching() {
        if (viewSwitchingReady) {
            mostrarView(viewFromHash());
            return;
        }
        viewSwitchingReady = true;
        // botões internos (se ainda existirem)
        if (btnPedidos) btnPedidos.addEventListener('click', () => mostrarView('pedidos'));
        if (btnCardapio) btnCardapio.addEventListener('click', () => mostrarView('cardapio'));
        if (btnRelatorios) btnRelatorios.addEventListener('click', () => mostrarView('relatorios'));
        // navegação pela sidebar (#cardapio / #relatorios / sem hash = pedidos)
        mostrarView(viewFromHash());
        window.addEventListener('hashchange', () => mostrarView(viewFromHash()));
    }

    btnExportarCsv.addEventListener('click', () => {
        // Selecionamos apenas as linhas que estão no corpo da tabela (dados filtrados)
        const rows = document.querySelectorAll("#report-body tr");

        if (rows.length === 0 || rows[0].innerText.includes("Nenhum pedido")) {
            alert("Não há dados filtrados para exportar!");
            return;
        }

        let csvContent = "\uFEFF"; // BOM para o Excel reconhecer acentos

        // 1. Cabeçalho do CSV
        csvContent += "Data/Hora;Cliente;Pedido;Total;Status\r\n";

        // 2. Percorre apenas as linhas que o filtro trouxe para a tela
        rows.forEach(row => {
            const cols = row.querySelectorAll("td");
            const rowData = Array.from(cols).map(col => {
                // Limpa o texto (remove quebras de linha e aspas extras)
                return `"${col.innerText.replace(/"/g, '""').trim()}"`;
            }).join(";");
            csvContent += rowData + "\r\n";
        });

        // 3. Download do arquivo
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);

        const dataArquivo = new Date().toISOString().split('T')[0];
        link.setAttribute("href", url);
        link.setAttribute("download", `relatorio_filtrado_${dataArquivo}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    function renderRelatorio(pedidos) {
        const tableBody = document.getElementById('report-body');
        const statFaturamento = document.getElementById('stat-faturamento');
        const statQtdPedidos = document.getElementById('stat-qtd-pedidos');
        const statTicketMedio = document.getElementById('stat-ticket-medio');

        // Novos campos de inteligência
        const statProdutoCampeao = document.getElementById('stat-produto-campeao');
        const statHorarioPico = document.getElementById('stat-horario-pico');

        tableBody.innerHTML = '';
        let totalFaturamento = 0;
        let contagemProdutos = {};
        let contagemHoras = {};

        pedidos.forEach(pedido => {
            const valor = Number(pedido.valor_total) || 0;
            totalFaturamento += valor;

            // --- LÓGICA DE INTELIGÊNCIA DE PRODUTOS ---
            // Transforma "1x Carne, 2x Queijo" em contagem individual
            if (pedido.item_pedido) {
                const itensArray = pedido.item_pedido.split(', ');
                itensArray.forEach(itemStr => {
                    const partes = itemStr.split('x ');
                    if (partes.length === 2) {
                        const qtd = parseInt(partes[0]);
                        const nome = partes[1];
                        contagemProdutos[nome] = (contagemProdutos[nome] || 0) + qtd;
                    }
                });
            }

            // --- LÓGICA DE HORÁRIO DE PICO ---
            if (pedido.hora_pedido) {
                const data = pedido.hora_pedido.toDate ? pedido.hora_pedido.toDate() : new Date(pedido.hora_pedido);
                const horaStr = data.getHours() + "h";
                contagemHoras[horaStr] = (contagemHoras[horaStr] || 0) + 1;
            }

            // --- RENDERIZAÇÃO DA TABELA (Mais limpa) ---
            const tr = document.createElement('tr');
            const dataFormatada = pedido.hora_pedido?.toDate ?
                pedido.hora_pedido.toDate().toLocaleString('pt-BR') : '---';

            tr.innerHTML = `
            <td><small>${dataFormatada}</small></td>
            <td><strong>${pedido.cliente_nome || 'Anónimo'}</strong></td>
            <td style="max-width: 250px; font-size: 0.85em; color: #555;">${pedido.item_pedido}</td>
            <td style="font-weight: bold; color: #27ae60;">R$ ${valor.toFixed(2)}</td>
            <td><span class="badge-status" style="background: ${getStatusColor(pedido.status)}">${pedido.status}</span></td>
        `;
            tableBody.appendChild(tr);
        });

        // --- CÁLCULOS FINAIS ---
        const totalPedidos = pedidos.length;
        const ticketMedio = totalPedidos > 0 ? (totalFaturamento / totalPedidos) : 0;

        // Descobrir o produto mais vendido (Campeão)
        const campeao = Object.keys(contagemProdutos).reduce((a, b) => contagemProdutos[a] > contagemProdutos[b] ? a : b, "---");

        // Descobrir a hora com mais pedidos
        const horaPico = Object.keys(contagemHoras).reduce((a, b) => contagemHoras[a] > contagemHoras[b] ? a : b, "---");

        // ATUALIZAR OS CARDS NA TELA
        statFaturamento.innerText = `R$ ${totalFaturamento.toFixed(2)}`;
        statQtdPedidos.innerText = totalPedidos;
        statTicketMedio.innerText = `R$ ${ticketMedio.toFixed(2)}`;

        if (statProdutoCampeao) statProdutoCampeao.innerText = campeao;
        if (statHorarioPico) statHorarioPico.innerText = horaPico;
    }

    // Função auxiliar para cores no relatório
    function getStatusColor(status) {
        switch (status) {
            case 'CONCLUIDO': return '#2ecc71';
            case 'CANCELADO': return '#e74c3c';
            case 'PENDENTE_PREPARO': return '#f1c40f';
            default: return '#3498db';
        }
    }

    // --- 3. LOGOUT ---
    if (logoutButton) {
        logoutButton.addEventListener('click', () => {
            auth.signOut().then(() => {
                window.location.href = '/login.html';
            });
        });
    }

    // --- 4. FUNÇÕES DO PAINEL DE PEDIDOS ---

    function canalPedido(pedido) {
        const origem = String(pedido.origem || pedido.canal || pedido.source || '').trim().toUpperCase();
        if (origem === 'APP') return 'app';
        if (['BOT', 'WHATSAPP', 'WPP'].includes(origem)) return 'bot';
        if (['BALCAO', 'MESA', 'SISTEMA', 'PDV'].includes(origem)) return 'sistema';
        if (pedido.wa_id || pedido.telefone_cliente || String(pedido.usuario_id || '').startsWith('wa_')) return 'bot';
        if (String(pedido.usuario_id || '').startsWith('cliente_')) return 'app';
        return 'sistema';
    }

    function pct(valor, total) {
        if (!total) return 0;
        return Math.max(0, Math.min(100, Math.round((valor / total) * 100)));
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function setBar(id, value) {
        const el = document.getElementById(id);
        if (el) el.style.width = `${value}%`;
    }

    function startOrdersTodayDashboard() {
        const dateEl = document.getElementById('orders-today-date');
        if (!dateEl) return;

        const inicio = new Date();
        inicio.setHours(0, 0, 0, 0);
        dateEl.textContent = inicio.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

        db.collection(COLECAO_PEDIDOS)
            .where("hora_pedido", ">=", inicio)
            .onSnapshot(snapshot => {
                const canais = {
                    app: { qtd: 0, total: 0 },
                    bot: { qtd: 0, total: 0 },
                    sistema: { qtd: 0, total: 0 }
                };
                let totalPedidos = 0;
                let faturamento = 0;
                let pedidosAtivos = 0;
                let vendasFaturadas = 0;

                snapshot.forEach(doc => {
                    const pedido = doc.data() || {};
                    if (pedido.status === 'CANCELADO') return;

                    totalPedidos++;
                    if (STATUS_ATIVOS_PEDIDOS.includes(pedido.status)) pedidosAtivos++;

                    const canal = canalPedido(pedido);
                    canais[canal].qtd++;

                    if (!STATUS_NAO_FATURA.has(pedido.status)) {
                        const valor = Number(pedido.valor_total) || 0;
                        faturamento += valor;
                        canais[canal].total += valor;
                        vendasFaturadas++;
                    }
                });

                const maiorQtd = Math.max(canais.app.qtd, canais.bot.qtd, canais.sistema.qtd, 1);
                setText('orders-today-total', String(totalPedidos));
                setText('orders-today-revenue', moneyBR(faturamento));
                setText('orders-today-active', String(pedidosAtivos));
                setText('orders-today-ticket', moneyBR(vendasFaturadas ? faturamento / vendasFaturadas : 0));

                [['app', 'channel-app'], ['bot', 'channel-bot'], ['sistema', 'channel-sistema']].forEach(([key, prefix]) => {
                    setText(`${prefix}-count`, String(canais[key].qtd));
                    setText(`${prefix}-value`, moneyBR(canais[key].total));
                    setBar(`${prefix}-bar`, pct(canais[key].qtd, maiorQtd));
                });
            }, error => console.warn("Pedidos de hoje:", error.message));
    }

    function startOrderListener() {//mostra os pedidos em tempo real
        if (!ordersList) return;

        db.collection(COLECAO_PEDIDOS)
            .where("status", "in", STATUS_ATIVOS_PEDIDOS)
            .orderBy("status", "asc")
            .orderBy("hora_pedido", "desc")
            .onSnapshot(snapshot => {

                // --- LÓGICA DO SOM ---
                // snapshot.docChanges() identifica o que mudou desde a última atualização
                snapshot.docChanges().forEach(change => {
                    // Se o tipo for "added", significa que um novo pedido caiu no sistema
                    if (change.type === "added") {
                        // O metadata.fromCache garante que não toque o som ao carregar a página (pedidos antigos)
                        if (!snapshot.metadata.fromCache) {
                            somNotificacao.play().catch(e => console.log("Aguardando interação do usuário para tocar som."));
                        }
                    }
                });
                // ---------------------

                ordersList.innerHTML = "";
                let pedidosHTML = '';
                let totalAtivos = 0;
                pedidosCache = {};

                if (snapshot.empty) {
                    ordersList.innerHTML = "<p style='padding:20px;'>Nenhum pedido ativo no momento.</p>";
                    if (totalPedidosSpan) totalPedidosSpan.textContent = 0;
                    return;
                }

                snapshot.forEach(doc => {
                    const pedido = doc.data();
                    const pedidoId = doc.id;
                    pedidosCache[pedidoId] = pedido;

                    let horaFormatada = "--:--";
                    if (pedido.hora_pedido && pedido.hora_pedido.toDate) {
                        horaFormatada = pedido.hora_pedido.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    }

                    pedidosHTML += createOrderCard(pedido, pedidoId, horaFormatada);
                    totalAtivos++;
                });

                ordersList.innerHTML = pedidosHTML;
                if (totalPedidosSpan) totalPedidosSpan.textContent = totalAtivos;

                attachButtonListeners();

            }, error => {
                console.error("Erro no Firestore:", error);
            });
    }
    //Mostra os cards de pedidos
    function createOrderCard(pedido, id, hora) {
        const formaPagamento = pedido.forma_pagamento ? pedido.forma_pagamento.replace(/_/g, ' ') : 'N/A';
        // Tipo de entrega: usa o campo novo; se não existir (pedidos antigos / bot), infere pelo endereço
        const ehRetirada = pedido.tipo_entrega
            ? pedido.tipo_entrega === 'RETIRADA'
            : (!pedido.endereco || /retirada/i.test(pedido.endereco));
        const tipoEntrega = ehRetirada ? 'RETIRADA' : 'ENTREGA';
        const badgeEntrega = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;color:#fff;background:${ehRetirada ? '#f39c12' : '#2980b9'};">${ehRetirada ? '🏪 RETIRADA' : '🛵 ENTREGA'}</span>`;
        const statusClean = pedido.status ? pedido.status.replace(/_/g, ' ') : 'N/A';
        const statusClass = `status-${pedido.status}`;
        const listaDeItens = pedido.itens || pedido.itens_pedido;
        // LÓGICA BLINDADA PARA ITENS
        let itensHTML = '';

        if (listaDeItens && Array.isArray(listaDeItens)) {
            itensHTML = listaDeItens.map(item => {
                // Tenta pegar .nome, .nome_exibicao ou o próprio item se for string
                const nomeExibicao = item.nome || item.nome_exibicao || item;

                // Se ainda for um objeto vazio ou erro, define um texto padrão
                const textoFinal = (typeof nomeExibicao === 'object') ? 'Item sem nome' : nomeExibicao;

                return `<div style="border-bottom: 1px dashed #eee; padding: 4px 0; font-weight: 500;">
                        • ${textoFinal}
                    </div>`;
            }).join('');
        }
        // Se for string antiga (Formato antigo separado por vírgula)
        else {
            const textoAntigo = pedido.item_pedido || pedido.itens_pedido || 'Sem detalhes';
            itensHTML = `<div>${textoAntigo}</div>`;
        }

        const enderecoLinha = ehRetirada
            ? ''
            : `<div class="order-endereco">📍 ${pedido.bairro ? `<strong>${pedido.bairro}</strong> — ` : ''}${pedido.endereco || '-'}</div>`;

        return `
        <div class="order-card" id="card-${id}">
            <div class="order-header">
                <span class="order-id">#${id.substring(0, 5)}</span>
                ${badgeEntrega}
                <span class="order-time">⏰ ${hora}</span>
            </div>
            <div class="order-details">
                <p class="order-cliente"><strong>${pedido.nome_cliente || 'N/I'}</strong></p>
                <div class="order-itens">${itensHTML}</div>
                ${enderecoLinha}
                <div class="order-footer-info">
                    <span>${formaPagamento.toUpperCase()}</span>
                    <div class="${statusClass} status-tag">${statusClean}</div>
                </div>
            </div>
            <div class="order-actions" data-status="${pedido.status}" data-entrega="${ehRetirada ? '0' : '1'}">
                <button type="button" class="btn-imprimir" data-imprimir="${id}" title="Imprimir pedido">🖨️</button>
                ${createStatusButtons(pedido.status, id, !ehRetirada)}
            </div>
        </div>
    `;
    }

    function imprimirPedido(id) {
        const pedido = pedidosCache && pedidosCache[id];
        if (!pedido) return;
        const ehRetirada = pedido.tipo_entrega
            ? pedido.tipo_entrega === 'RETIRADA'
            : (!pedido.endereco || /retirada/i.test(pedido.endereco));
        const listaDeItens = pedido.itens || pedido.itens_pedido;
        let linhasItens = '';
        if (listaDeItens && Array.isArray(listaDeItens)) {
            linhasItens = listaDeItens.map(item => {
                const nome = item.nome || item.nome_exibicao || item;
                const texto = (typeof nome === 'object') ? 'Item sem nome' : nome;
                const qtd = item.quantidade ? `${item.quantidade}x ` : '';
                return `<div class="linha">${qtd}${texto}</div>`;
            }).join('');
        } else {
            linhasItens = `<div class="linha">${pedido.item_pedido || pedido.itens_pedido || 'Sem detalhes'}</div>`;
        }
        const formaPagamento = pedido.forma_pagamento ? pedido.forma_pagamento.replace(/_/g, ' ') : 'N/A';
        const enderecoHtml = ehRetirada
            ? '<div class="linha"><strong>RETIRADA NO LOCAL</strong></div>'
            : `<div class="linha"><strong>Bairro:</strong> ${pedido.bairro || '-'}</div><div class="linha"><strong>Endereço:</strong> ${pedido.endereco || '-'}</div>`;
        const janela = window.open('', '_blank', 'width=400,height=600');
        janela.document.write(`
            <html><head><title>Pedido #${id.substring(0, 5)}</title>
            <style>
                body { font-family: 'Courier New', monospace; font-size: 14px; padding: 10px; color: #000; }
                h1 { font-size: 16px; text-align: center; margin: 0 0 6px; }
                .linha { padding: 3px 0; border-bottom: 1px dashed #999; }
                hr { border: none; border-top: 1px solid #000; margin: 8px 0; }
                .total { font-weight: bold; font-size: 15px; }
                .center { text-align: center; }
            </style>
            </head><body>
                <h1>Pedido #${id.substring(0, 5)} — ${ehRetirada ? 'RETIRADA' : 'ENTREGA'}</h1>
                <div class="linha"><strong>Cliente:</strong> ${pedido.nome_cliente || 'N/I'}</div>
                ${pedido.telefone_cliente ? `<div class="linha"><strong>Tel:</strong> ${pedido.telefone_cliente}</div>` : ''}
                <hr>
                ${linhasItens}
                <hr>
                ${enderecoHtml}
                <div class="linha"><strong>Pagamento:</strong> ${formaPagamento.toUpperCase()}</div>
                ${pedido.observacao ? `<div class="linha"><strong>Obs:</strong> ${pedido.observacao}</div>` : ''}
                <hr>
                <div class="linha total">TOTAL: R$ ${Number(pedido.valor_total || 0).toFixed(2).replace('.', ',')}</div>
                <hr>
                <div class="center">${new Date().toLocaleString('pt-BR')}</div>
            </body></html>
        `);
        janela.document.close();
        janela.focus();
        setTimeout(() => janela.print(), 300);
    }

    function createStatusButtons(currentStatus, id, ehEntrega) {
        let buttons = '';
        const flow = {
            // PIX confirma sozinho pelo webhook (AGUARDANDO_PIX -> PENDENTE_PREPARO).
            // Aqui só deixamos a opção de cancelar um pedido não pago.
            "AGUARDANDO_PIX": ["CANCELADO"],
            "PENDENTE_VALIDACAO": ["EM_PREPARO", "CANCELADO"],
            "PENDENTE_PREPARO": ["EM_PREPARO", "CANCELADO"],
            "EM_PREPARO": ["PRONTO_PARA_ENTREGA"],
            "PRONTO_PARA_ENTREGA": ["CONCLUIDO"]
        };

        // Rótulos amigáveis: o texto do botão é independente do nome técnico do status
        const LABELS = {
            "CANCELADO": "Cancelar",
            "EM_PREPARO": "👨‍🍳 Enviar para Preparo",
            "PRONTO_PARA_ENTREGA": "Pronto p/ Entrega",
            "CONCLUIDO": "Concluir"
        };

        const steps = flow[currentStatus] || [];
        steps.forEach(st => {
            const label = LABELS[st] || st.replace(/_/g, ' ');
            const btnClass = st === "CANCELADO" ? "btn-status btn-cancel" : "btn-status";
            buttons += `<button class="${btnClass}" data-id="${id}" data-status="${st}" data-label="${label}">${label}</button>`;
        });

        // Atalho: pedido de entrega que já saiu pronto do balcão (comum em
        // lanchonete) não precisa passar por "Enviar para Preparo" ->
        // "Pronto p/ Entrega" -> ir em Entregas pra só então despachar —
        // despacha direto daqui, pulando pra SAIU_PARA_ENTREGA de uma vez.
        if (ehEntrega && (currentStatus === "PENDENTE_PREPARO" || currentStatus === "EM_PREPARO" || currentStatus === "PENDENTE_VALIDACAO")) {
            const opcoes = entregadoresAtivos.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
            buttons += `
                <div class="despacho-rapido" style="display:flex;gap:6px;align-items:center;margin-top:6px;">
                    <select class="despacho-select" data-despacho-select="${id}" style="flex:1;padding:6px;border-radius:6px;border:1px solid #ddd;">
                        ${opcoes || '<option value="">(sem entregador ativo)</option>'}
                    </select>
                    <button class="btn-status" data-despachar-direto="${id}" style="background:#2980b9;white-space:nowrap;">🛵 Despachar</button>
                </div>`;
        }
        return buttons;
    }

    async function despacharDireto(id) {
        const sel = document.querySelector(`[data-despacho-select="${id}"]`);
        const entId = sel ? sel.value : '';
        if (!entId) { alert("Cadastre/ative um entregador em Entregas antes de despachar."); return; }
        const entregador = entregadoresAtivos.find(e => e.id === entId);
        if (!confirm(`Despachar pedido #${id.substring(0, 5)} já pronto com ${entregador ? entregador.nome : 'este entregador'}?`)) return;
        try {
            await db.collection(COLECAO_PEDIDOS).doc(id).update({
                status: "SAIU_PARA_ENTREGA",
                entregador_id: entId,
                entregador_nome: entregador ? entregador.nome : '',
                hora_saida: firebase.firestore.FieldValue.serverTimestamp()
            });
            const doc = await db.collection(COLECAO_PEDIDOS).doc(id).get();
            const pedido = doc.data() || {};
            fetch(`${ngrokUrl}/notificar_saiu`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    wa_id: pedido.telefone_cliente || pedido.wa_id || pedido.telefone,
                    nome: pedido.nome_cliente || pedido.nome,
                    evento: 'SAIU'
                })
            }).catch(() => { /* endpoint opcional no bot */ });
        } catch (err) {
            alert("Erro ao despachar: " + err.message);
        }
    }

    function attachButtonListeners() {
        // Isso impede que os botões de navegação no header sejam afetados.
        if (ordersList) {
            ordersList.querySelectorAll('.btn-status[data-status]').forEach(btn => {
                // Remove listeners antigos para evitar duplicação (boa prática)
                btn.removeEventListener('click', handleOrderStatusClick);
                btn.addEventListener('click', handleOrderStatusClick);
            });
            ordersList.querySelectorAll('[data-despachar-direto]').forEach(btn => {
                btn.onclick = () => despacharDireto(btn.dataset.despacharDireto);
            });
            ordersList.querySelectorAll('[data-imprimir]').forEach(btn => {
                btn.onclick = () => imprimirPedido(btn.dataset.imprimir);
            });
        }
    }

    async function handleOrderStatusClick(e) {
        const targetButton = e.currentTarget;
        const id = targetButton.dataset.id;
        const novoStatus = targetButton.dataset.status;
        const acaoLabel = targetButton.dataset.label || novoStatus.replace(/_/g, ' ');

        if (!id) return;

        if (confirm(`Pedido #${id.substring(0, 5)} — "${acaoLabel}"?`)) {
            try {
                // 1. Atualiza o Firestore
                await db.collection(COLECAO_PEDIDOS).doc(id).update({ status: novoStatus });

                // 1b. Baixa automática de estoque ao concluir o pedido
                if (novoStatus === "CONCLUIDO" && window.GestorChefEstoque) {
                    window.GestorChefEstoque.baixarDoPedido(db, id).then(avisarPratosDesativados).catch(() => {});
                }

                // 2. Verifica se o status aciona a notificação
                // DICA: Verifique se no seu HTML o status é exatamente este
                if (novoStatus === "PRONTO_PARA_ENTREGA" || novoStatus === "PRONTO_ENTREGA") {
                    const doc = await db.collection(COLECAO_PEDIDOS).doc(id).get();
                    const pedido = doc.data();

                    const endpoint = `${ngrokUrl}/notificar_pronto`;
                    console.log("Chamando bot em:", endpoint);

                    // 3. Envia para o Python
                    fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            wa_id: pedido.telefone_cliente || pedido.wa_id || pedido.telefone,
                            nome: pedido.nome_cliente || pedido.nome,
                            tipo_servico: pedido.tipo_entrega
                                ? pedido.tipo_entrega
                                : ((!pedido.endereco || /retirada/i.test(pedido.endereco)) ? "RETIRADA" : "ENTREGA")
                        })
                    })
                        .then(async response => {
                            const resData = await response.json();
                            if (response.ok) {
                                console.log("✅ Bot avisado!");
                            } else {
                                console.error("❌ Erro no Bot:", resData);
                            }
                        })
                        .catch(err => console.error("❌ Erro na requisição:", err));
                }
            } catch (err) {
                alert("Erro ao atualizar: " + err.message);
            }
        }
    }

    // --- 5. FUNÇÕES DE GERENCIAMENTO DE CARDÁPIO ---
    async function addProductToCardapio(event) {
        event.preventDefault();

        const nome = document.getElementById('product-nome').value;
        const categoria = document.getElementById('product-categoria').value;
        const preco = parseFloat(document.getElementById('product-preco').value);
        const disponivel = document.getElementById('product-disponivel').checked;
        // Recupera os ingredientes
        const ingredientes = document.getElementById('product-ingredientes').value;
        const pontosFidelidade = parseInt(document.getElementById('product-pontos').value) || 0;

        if (!nome || isNaN(preco) || !ingredientes) {
            productMessage.style.color = '#e74c3c';
            productMessage.textContent = 'Por favor, preencha o nome, o preço e os ingredientes/descrição corretamente.';
            return;
        }

        // Normalização
        const nomeNormalizado = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "");

        const productData = {
            nome: nomeNormalizado,
            nome_exibicao: nome,
            categoria: categoria,
            preco: preco,
            ingredientes: ingredientes,
            disponivel: disponivel,
            pontos_fidelidade: pontosFidelidade,
            ultima_atualizacao: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            await db.collection(COLECAO_CARDAPIO).add(productData);

            productMessage.style.color = '#2ecc71';
            productMessage.textContent = `Item "${nome}" cadastrado com sucesso!`;
            productForm.reset();

        } catch (error) {
            productMessage.style.color = '#e74c3c';
            productMessage.textContent = `Erro ao salvar item: ${error.message}`;
            console.error("Erro ao salvar produto:", error);
        }
    }

    // Avisa o operador quando a baixa de estoque desativou algum prato
    // automaticamente (insumo esgotou) — pra não passar batido.
    function avisarPratosDesativados(resultado) {
        const pratos = resultado && resultado.pratos_desativados;
        if (!pratos || !pratos.length) return;
        const d = document.createElement('div');
        d.textContent = `⚠️ Estoque esgotado: ${pratos.join(', ')} ${pratos.length > 1 ? 'foram desativados' : 'foi desativado'} do cardápio.`;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:.95rem;';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 4000);
    }
});
