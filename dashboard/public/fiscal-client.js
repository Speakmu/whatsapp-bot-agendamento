// ============================================================
//  Cliente fiscal (compartilhado) — window.FiscalClient
//  Lê configuracoes/fiscal, monta o payload da NFC-e a partir
//  de um pedido, chama o microserviço e grava em notas_fiscais.
//  Requer Firebase (firestore) já inicializado na página.
// ============================================================
(function () {
    const TPAG = { 'dinheiro': '01', 'pix': '17', 'cartão': '03', 'cartao': '03', 'crédito': '03', 'credito': '03', 'débito': '04', 'debito': '04', 'entrega': '99' };

    function db() { return firebase.firestore(); }

    async function getConfig() {
        const doc = await db().collection('configuracoes').doc('fiscal').get();
        if (!doc.exists) throw new Error('Configuração fiscal não encontrada. Configure em Configurações → Fiscal.');
        return doc.data();
    }

    function mapTPag(forma) {
        const f = String(forma || '').toLowerCase();
        for (const k in TPAG) if (f.includes(k)) return TPAG[k];
        return '01';
    }

    // Próximo número da NFC-e (sequencial por transação no doc da config)
    async function proximoNumero() {
        const ref = db().collection('configuracoes').doc('fiscal');
        return db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const atual = (snap.data() && snap.data().seqNNF) || 0;
            const proximo = atual + 1;
            tx.update(ref, { seqNNF: proximo });
            return proximo;
        });
    }

    function itensDoPedido(pedido, cfg) {
        const lista = pedido.itens || [];
        const items = (Array.isArray(lista) && lista.length)
            ? lista.map(i => ({
                xProd: i.nome_exibicao || i.nome || 'Item',
                ncm: i.ncm || cfg.ncm,
                cfop: i.cfop || cfg.cfop,
                csosn: i.csosn || cfg.cst,
                origem: i.origem || cfg.origem || '0',
                uCom: 'UN',
                qCom: Number(i.quantidade) || 1,
                vUnCom: Number(i.preco) || 0
            }))
            // fallback: item único com o total
            : [{
                xProd: pedido.item_pedido || 'Consumo', ncm: cfg.ncm, cfop: cfg.cfop,
                csosn: cfg.cst, origem: cfg.origem || '0', uCom: 'UN', qCom: 1,
                vUnCom: Number(pedido.valor_total) || 0
            }];
        reconciliarComValorPago(items, pedido.valor_total);
        return items;
    }

    // Cupom de desconto, resgate de pontos e taxa de entrega alteram o
    // valor_total do pedido sem mudar o preço unitário guardado em cada item
    // — a soma dos itens ficava diferente do valor realmente pago, e a SEFAZ
    // rejeita a nota ("Total dos pagamentos menor/maior que o total da nota").
    function reconciliarComValorPago(items, valorTotal) {
        const alvo = Number(valorTotal) || 0;
        const soma = items.reduce((s, i) => s + i.qCom * i.vUnCom, 0);
        const diff = Math.round((soma - alvo) * 100) / 100;
        if (Math.abs(diff) < 0.01) return;

        if (diff < 0) {
            // valor pago é maior que a soma dos itens (ex: taxa de entrega) -> soma no valor do último item
            const ultimo = items[items.length - 1];
            ultimo.vUnCom = Math.round((ultimo.vUnCom + (-diff) / ultimo.qCom) * 100) / 100;
            return;
        }

        // Itens somam mais que o valor pago (cupom/pontos de desconto): distribui
        // o desconto proporcionalmente entre os itens, sem deixar o desconto de
        // nenhum item passar do valor dele (a SEFAZ rejeita isso também). Se
        // sobrar valor por causa de itens já "saturados" (desconto = valor
        // inteiro), reparte de novo só entre os que ainda têm folga.
        let restante = diff;
        items.forEach((it, idx) => {
            const vItem = Math.round(it.qCom * it.vUnCom * 100) / 100;
            const proporcional = idx === items.length - 1
                ? restante
                : Math.round((diff * (vItem / soma)) * 100) / 100;
            const parte = Math.min(proporcional, vItem, restante);
            if (parte > 0) {
                it.vDesc = Math.round(((it.vDesc || 0) + parte) * 100) / 100;
                restante = Math.round((restante - parte) * 100) / 100;
            }
        });
        while (restante > 0.004) {
            const comFolga = items.find(it => {
                const vItem = Math.round(it.qCom * it.vUnCom * 100) / 100;
                return vItem - (it.vDesc || 0) > 0.004;
            });
            if (!comFolga) break; // desconto >= soma de todos os itens (caso extremo, não dá pra reconciliar)
            const vItem = Math.round(comFolga.qCom * comFolga.vUnCom * 100) / 100;
            const folga = Math.round((vItem - (comFolga.vDesc || 0)) * 100) / 100;
            const parte = Math.min(folga, restante);
            comFolga.vDesc = Math.round(((comFolga.vDesc || 0) + parte) * 100) / 100;
            restante = Math.round((restante - parte) * 100) / 100;
        }
    }

    // Escolhe o par de URLs (QR Code / consulta por chave) certo pro ambiente
    // selecionado, para nao precisar trocar manualmente ao migrar homologacao <-> producao.
    function urlsPorAmbiente(cfg) {
        const prod = cfg.ambiente === 'producao';
        return {
            qrBaseUrl: prod ? cfg.qrBaseUrlProd : cfg.qrBaseUrlHom,
            urlChave: prod ? cfg.urlChaveProd : cfg.urlChaveHom,
        };
    }

    function validarConfig(cfg) {
        const faltando = [];
        if (!cfg.ativo) throw new Error('Emissão fiscal está desativada em Configurações.');
        const { qrBaseUrl } = urlsPorAmbiente(cfg);
        ['url', 'cnpj', 'csc', 'cscId', 'uf', 'cMun', 'xLgr', 'nro', 'xBairro', 'xMun', 'cep']
            .forEach(k => { if (!cfg[k]) faltando.push(k); });
        if (!qrBaseUrl) faltando.push(cfg.ambiente === 'producao' ? 'qrBaseUrlProd' : 'qrBaseUrlHom');
        if (faltando.length) throw new Error('Configuração fiscal incompleta: ' + faltando.join(', '));
    }

    // Status que indicam uma nota já "ativa" para o pedido (em andamento ou
    // concluída) — não é para pedir um número novo nem chamar o serviço de
    // novo enquanto uma dessas existir, senão duplica a nota fiscal da venda.
    const STATUS_NOTA_ATIVA = ['PROCESSANDO', 'ERRO_REDE', 'CONTINGENCIA', 'AUTORIZADA'];

    // Trava transacional no PRÓPRIO PEDIDO para o trecho "checar se já existe
    // nota ativa + pedir número + criar o registro PROCESSANDO". Sem isso, dois
    // gatilhos concorrentes para o mesmo pedido (ex.: clique manual em "Retry"
    // + o cron fiscalRetryScheduler rodando ~20min depois, ou duplo-clique no
    // botão) podem cada um checar "nenhuma nota ativa" antes de qualquer um
    // deles ter criado a sua — e os dois seguem em frente, emitindo (e a SEFAZ
    // autorizando) DUAS NFC-e válidas e distintas pra mesma venda. Já aconteceu
    // em produção (pedido com 2 notas AUTORIZADA, teve que cancelar as duas).
    // A trava expira sozinha depois de 5min (processo que travou/caiu no meio
    // não prende o pedido pra sempre).
    const TRAVA_EMISSAO_TIMEOUT_MS = 5 * 60 * 1000;
    async function adquirirTravaEmissao(pedidoId) {
        const pedidoRef = db().collection('pedidos').doc(pedidoId);
        await db().runTransaction(async (tx) => {
            const snap = await tx.get(pedidoRef);
            const d = snap.exists ? (snap.data() || {}) : {};
            const travaEm = d.nfce_emitindo_em && d.nfce_emitindo_em.toMillis ? d.nfce_emitindo_em.toMillis() : 0;
            if (travaEm && (Date.now() - travaEm) < TRAVA_EMISSAO_TIMEOUT_MS) {
                throw new Error('NFCE_JA_EM_ANDAMENTO');
            }
            tx.update(pedidoRef, { nfce_emitindo_em: firebase.firestore.FieldValue.serverTimestamp() });
        });
    }
    function liberarTravaEmissao(pedidoId) {
        db().collection('pedidos').doc(pedidoId)
            .set({ nfce_emitindo_em: firebase.firestore.FieldValue.delete() }, { merge: true }).catch(() => {});
    }

    // Emite em segundo plano: grava um registro "PROCESSANDO" na hora (só Firestore,
    // rápido) e devolve o controle ao caixa imediatamente. A comunicação com a SEFAZ
    // (que pode levar até ~30s) continua rodando por trás e atualiza o MESMO
    // documento quando terminar — a tela reage sozinha via listener do Firestore,
    // sem o operador ficar esperando parado.
    async function emitir(pedidoId, pedido) {
        const cfg = await getConfig();
        validarConfig(cfg);

        await adquirirTravaEmissao(pedidoId);
        try {
            return await emitirComTravaAdquirida(pedidoId, pedido, cfg);
        } finally {
            liberarTravaEmissao(pedidoId);
        }
    }

    async function emitirComTravaAdquirida(pedidoId, pedido, cfg) {
        // Já existe uma nota em andamento/concluída para este pedido (ex.: uma
        // tentativa anterior ficou em ERRO_REDE por falta de internet) — não
        // pede outro número nem cria outro documento, só devolve o que já existe.
        // Filtra o status no cliente (não no "where") para não depender de um
        // índice composto — a query em si é só por pedido_id.
        const existentes = await db().collection('notas_fiscais')
            .where('pedido_id', '==', pedidoId).get();
        const ativa = existentes.docs.find(doc => STATUS_NOTA_ATIVA.includes(doc.data().status));
        if (ativa) {
            const d = ativa.data();
            return { id: ativa.id, status: d.status, nNF: d.nNF, serie: d.serie };
        }

        const nNF = await proximoNumero();
        const payload = {
            ambiente: cfg.ambiente || 'homologacao',
            serie: cfg.serie || 1,
            nNF,
            seed: `pedido-${pedidoId}`,
            emitter: {
                cnpj: cfg.cnpj, ie: cfg.ie || 'ISENTO', xNome: cfg.razao || cfg.fantasia || 'Emitente',
                xFant: cfg.fantasia, xLgr: cfg.xLgr, nro: cfg.nro, xCpl: cfg.xCpl,
                xBairro: cfg.xBairro, cMun: cfg.cMun, xMun: cfg.xMun, uf: cfg.uf,
                cep: cfg.cep, fone: cfg.fone, crt: cfg.regime === 'normal' ? '3' : '1'
            },
            csc: cfg.csc, cscId: cfg.cscId,
            ...urlsPorAmbiente(cfg),
            aliquotaAproxTributos: Number(cfg.aliquotaAproxTributos) || 0,
            ibptToken: cfg.ibptToken || undefined,
            // Venda pelo app/delivery: indPres=4 (NT 2020.006), com indIntermed=0
            // (canal proprio, sem marketplace de terceiro). Balcao/mesa: presencial normal.
            indPres: pedido.origem === 'APP' ? '4' : '1',
            indIntermed: pedido.origem === 'APP' ? '0' : undefined,
            payment: { tPag: mapTPag(pedido.forma_pagamento), vPag: Number(pedido.valor_total) || 0 },
            items: itensDoPedido(pedido, cfg),
            recipient: pedido.cpf_cliente ? {
                cpf: pedido.cpf_cliente, xNome: pedido.nome_cliente,
                // Endereço de entrega — exigido pela SEFAZ em NFC-e "entrega a
                // domicílio" (indPres=4). Cidade/UF/CEP usam os dados do emitente
                // (delivery local, mesma cidade da loja) já que o pedido só guarda
                // a rua/número em texto livre.
                ...(pedido.tipo_entrega === 'ENTREGA' && pedido.endereco ? {
                    xLgr: pedido.endereco,
                    xBairro: pedido.bairro || cfg.xBairro,
                    cMun: cfg.cMun, xMun: cfg.xMun, uf: cfg.uf, cep: cfg.cep,
                } : {}),
            } : undefined
        };

        const ref = await db().collection('notas_fiscais').add({
            pedido_id: pedidoId,
            nNF, serie: payload.serie,
            status: 'PROCESSANDO',
            valor: payload.payment.vPag,
            cliente: pedido.nome_cliente || null,
            ambiente: payload.ambiente,
            criado_em: firebase.firestore.FieldValue.serverTimestamp(),
            // Guardado desde a criação (não só quando dá erro): se a aba fechar
            // ou recarregar antes da resposta chegar, resgatarNotasTravadas()
            // usa isso pra reenviar exatamente esta tentativa depois.
            // JSON.parse(JSON.stringify()) remove campos "undefined" (ex.:
            // indIntermed/recipient/ibptToken quando não se aplicam) — o
            // Firestore recusa gravar "undefined" e quebraria o addDoc().
            payload_pendente: JSON.parse(JSON.stringify(payload))
        });

        // Uma emissão foi iniciada de verdade pra este pedido — limpa
        // nfce_pendente aqui (não só em emitirAutomatico) pra qualquer chamador
        // (retry manual na tela Fiscal incluído). Sem isso, um retry manual
        // bem-sucedido deixava a flag true pra sempre, e o cron do backend
        // tentava emitir de novo no ciclo seguinte — uma das causas da
        // duplicidade de NFC-e mencionada acima.
        db().collection('pedidos').doc(pedidoId)
            .set({ nfce_pendente: firebase.firestore.FieldValue.delete() }, { merge: true }).catch(() => {});

        // Não faz "await" abaixo — roda em segundo plano e atualiza o registro
        // quando a SEFAZ (ou a contingência) responder.
        continuarEmissaoEmSegundoPlano(ref, cfg, payload);

        return { id: ref.id, status: 'PROCESSANDO', nNF, serie: payload.serie };
    }

    // Tempo máximo esperando o serviço fiscal responder antes de desistir e
    // cair no caminho de retry (ERRO_REDE). Sem isso, uma requisição que trava
    // (rede "engasgada", sem erro explícito) nunca solta a nota do PROCESSANDO.
    const TIMEOUT_EMISSAO_MS = 45000;

    async function continuarEmissaoEmSegundoPlano(ref, cfg, payload) {
        let resp, data;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_EMISSAO_MS);
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/avulsa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            data = await resp.json();
        } catch (err) {
            // Falha de REDE (nem chegou a falar com o serviço fiscal, ou a
            // requisição travou e foi abortada pelo timeout acima) — diferente
            // de uma rejeição da SEFAZ. Guarda o payload para o retry automático
            // reenviar exatamente a mesma tentativa (mesmo nNF/seed) quando a
            // conexão voltar, em vez de pedir um número novo e duplicar a nota.
            const motivo = err.name === 'AbortError'
                ? `Serviço fiscal não respondeu em ${TIMEOUT_EMISSAO_MS / 1000}s.`
                : 'Falha ao contatar o serviço fiscal: ' + err.message;
            await ref.update({ status: 'ERRO_REDE', motivo, payload_pendente: JSON.parse(JSON.stringify(payload)) });
            return;
        } finally {
            clearTimeout(timeoutId);
        }

        const emContingencia = data.status === 'CONTINGENCIA';
        await ref.update({
            status: data.status || (resp.ok ? 'AUTORIZADA' : 'ERRO'),
            chave: data.chave || null,
            protocolo: data.protocolo || null,
            cStat: data.cStat || null,
            motivo: data.motivo || data.error || null,
            danfeBase64: data.danfeBase64 || null,
            // XML assinado enviado (ou tentado) — sempre grava, mesmo em rejeicao,
            // para dar pra baixar e depurar o motivo da rejeicao.
            xml: data.xml || null,
            // Histórico permanente de como a nota nasceu — nunca é sobrescrito depois
            // (diferente de "contingencia", que indica só se ainda esta pendente de transmissao).
            formaEmissao: emContingencia ? 'CONTINGENCIA' : 'NORMAL',
            contingencia: !!data.contingencia,
            // guarda o XML assinado apenas na contingência (para transmitir depois)
            xmlAssinado: emContingencia ? (data.xml || null) : null,
            payload_pendente: firebase.firestore.FieldValue.delete()
        });
    }

    // ---------- Emissão automática (chamada pelo PDV/mesas ao concluir uma venda) ----------
    // Centraliza a checagem de configuração + o que fazer quando falha, para não
    // duplicar essa lógica em cada tela. IMPORTANTE: emitir() pede um número
    // sequencial via transação do Firestore (proximoNumero) — transações NÃO
    // funcionam offline (o Firestore não garante um número único sem confirmar
    // com o servidor). Ou seja, uma venda feita sem internet nunca chega a criar
    // o registro da nota. Por isso, se a emissão falhar aqui, marcamos o PEDIDO
    // (escrita simples, funciona offline) como pendente, para o retry automático
    // tentar de novo quando a conexão voltar.
    async function emitirAutomatico(pedidoId, pedido) {
        // Venda em dinheiro nunca emite sozinha (só PIX/Cartão). Quem quiser
        // uma NFC-e de uma venda em dinheiro emite manualmente na tela Fiscal.
        // Usa includes() (não igualdade exata) pra cobrir variações que vêm do
        // bot/app, ex.: "DINHEIRO NA ENTREGA", "Entrega/Dinheiro".
        if (String(pedido.forma_pagamento || '').toLowerCase().includes('dinheiro')) return null;
        let cfg;
        try { cfg = await getConfig(); } catch { return null; }
        if (!cfg || !cfg.ativo) return null;
        if (!['automatico', 'ambos'].includes(cfg.modo)) return null;
        try {
            const nota = await emitir(pedidoId, pedido);
            db().collection('pedidos').doc(pedidoId)
                .set({ nfce_pendente: firebase.firestore.FieldValue.delete() }, { merge: true }).catch(() => {});
            return nota;
        } catch (err) {
            db().collection('pedidos').doc(pedidoId).set({ nfce_pendente: true }, { merge: true }).catch(() => {});
            throw err;
        }
    }

    // Reemite automaticamente as vendas que ficaram marcadas como pendentes
    // (emissão automática falhou, provavelmente por falta de conexão no momento
    // da venda). Só mexe em pedidos que ainda não têm nota ativa — emitir() já
    // faz essa checagem internamente.
    async function retentarEmissoesAutomaticasPendentes() {
        const cfg = await getConfig().catch(() => null);
        if (!cfg || !cfg.ativo || !['automatico', 'ambos'].includes(cfg.modo)) return;
        const pendentes = await db().collection('pedidos').where('nfce_pendente', '==', true).get();
        for (const doc of pendentes.docs) {
            const pedido = doc.data();
            if (String(pedido.forma_pagamento || '').trim().toLowerCase() === 'dinheiro') {
                await doc.ref.update({ nfce_pendente: firebase.firestore.FieldValue.delete() }).catch(() => {});
                continue;
            }
            try {
                await emitir(doc.id, pedido);
                await doc.ref.update({ nfce_pendente: firebase.firestore.FieldValue.delete() });
            } catch { /* continua marcado, tenta de novo na próxima */ }
        }
    }

    // ---------- Retry automático de notas que falharam por falta de rede ----------
    // Só mexe em notas ERRO_REDE (nunca chegaram a falar com o serviço fiscal).
    // Reenvia o MESMO payload (mesmo nNF/seed) já salvo — nunca pede número novo,
    // para não duplicar a nota fiscal da venda. A transação abaixo garante que,
    // mesmo com duas abas abertas ou um retry automático concorrente com um clique
    // manual, só uma tentativa de reenvio rode por vez para cada nota.
    async function retentarNotasComErroDeRede() {
        const cfg = await getConfig().catch(() => null);
        if (!cfg || !cfg.ativo) return;

        const pendentes = await db().collection('notas_fiscais').where('status', '==', 'ERRO_REDE').get();
        for (const doc of pendentes.docs) {
            const ref = doc.ref;
            let payload;
            try {
                payload = await db().runTransaction(async (tx) => {
                    const snap = await tx.get(ref);
                    const d = snap.data();
                    if (!d || d.status !== 'ERRO_REDE' || !d.payload_pendente) return null;
                    tx.update(ref, { status: 'PROCESSANDO' });
                    return d.payload_pendente;
                });
            } catch { continue; }
            if (payload) continuarEmissaoEmSegundoPlano(ref, cfg, payload);
        }
    }

    // Tempo depois do qual uma nota ainda em PROCESSANDO é considerada órfã
    // (a aba que estava emitindo fechou/recarregou antes da resposta chegar,
    // ou o fetch travou numa aba que já não existe mais pra rodar o timeout
    // acima). Maior que TIMEOUT_EMISSAO_MS com folga, pra não competir com
    // uma emissão que ainda está genuinamente em andamento nesta mesma aba.
    const LIMITE_PROCESSANDO_ORFA_MS = 2 * 60 * 1000;

    // Acha notas presas em PROCESSANDO por tempo demais e as move pra
    // ERRO_REDE (usando o payload guardado desde a criação) — dali,
    // retentarNotasComErroDeRede() reenvia sozinho com o mesmo nNF, sem
    // duplicar a nota.
    async function resgatarNotasTravadas() {
        const limite = Date.now() - LIMITE_PROCESSANDO_ORFA_MS;
        const presas = await db().collection('notas_fiscais').where('status', '==', 'PROCESSANDO').get();
        for (const doc of presas.docs) {
            const n = doc.data();
            const criadoMs = n.criado_em && n.criado_em.toMillis ? n.criado_em.toMillis() : 0;
            if (!n.payload_pendente || criadoMs > limite) continue;
            await doc.ref.update({
                status: 'ERRO_REDE',
                motivo: 'Emissão interrompida (aba fechada ou conexão perdida durante o envio) — reenviando automaticamente.'
            }).catch(() => {});
        }
    }

    function retentarPendenciasFiscais() {
        resgatarNotasTravadas()
            .then(() => retentarNotasComErroDeRede())
            .catch(() => {});
        retentarEmissoesAutomaticasPendentes().catch(() => {});
    }

    // Reenvia sozinho assim que a internet volta, e também de tempos em
    // tempos como reforço (ex.: se o evento 'online' não disparar de forma
    // confiável no navegador/dispositivo usado no caixa).
    if (typeof window !== 'undefined') {
        window.addEventListener('online', retentarPendenciasFiscais);
        setInterval(retentarPendenciasFiscais, 5 * 60 * 1000);
    }

    // ---------- Prévia de layout do cupom (sem emitir/transmitir) ----------
    // Recebe a aba já aberta (window.open síncrono no clique) para não ser
    // bloqueada pelo navegador — abrir depois de vários await perde o
    // "gesto do usuário" e o Chrome/Firefox bloqueiam a aba sem avisar.
    async function visualizarCupom(janela) {
        const cfg = await getConfig();
        validarConfig({ ...cfg, ativo: true });

        const payload = {
            ambiente: cfg.ambiente || 'homologacao',
            serie: cfg.serie || 1,
            nNF: (cfg.seqNNF || 0) + 1,
            seed: `previa-${Date.now()}`,
            emitter: {
                cnpj: cfg.cnpj, ie: cfg.ie || 'ISENTO', xNome: cfg.razao || cfg.fantasia || 'Emitente',
                xFant: cfg.fantasia, xLgr: cfg.xLgr, nro: cfg.nro, xCpl: cfg.xCpl,
                xBairro: cfg.xBairro, cMun: cfg.cMun, xMun: cfg.xMun, uf: cfg.uf,
                cep: cfg.cep, fone: cfg.fone, crt: cfg.regime === 'normal' ? '3' : '1'
            },
            csc: cfg.csc, cscId: cfg.cscId,
            ...urlsPorAmbiente(cfg),
            aliquotaAproxTributos: Number(cfg.aliquotaAproxTributos) || 0,
            ibptToken: cfg.ibptToken || undefined,
            payment: { tPag: '01', vPag: 25 },
            items: [{
                xProd: 'Produto de exemplo', ncm: cfg.ncm || '21069090', cfop: cfg.cfop || '5102',
                csosn: cfg.cst || '102', origem: cfg.origem || '0', uCom: 'UN', qCom: 1, vUnCom: 25
            }]
        };

        let resp;
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify(payload)
            });
        } catch (err) { throw new Error('Falha ao contatar o serviço fiscal: ' + err.message); }

        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `Falha ao gerar prévia (${resp.status}).`);
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        if (janela && !janela.closed) janela.location.href = url;
        else window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    // ---------- Pré-aquecimento do cache de tributos IBPT (em segundo plano) ----------
    async function prewarmTributosIbpt(ncms) {
        const cfg = await getConfig();
        if (!cfg.url) throw new Error('Informe a URL do serviço fiscal em Configurações.');
        if (!cfg.ibptToken) throw new Error('Configure o Token IBPT em Config fiscal primeiro.');

        const resp = await fetch(`${cfg.url}/fiscal/ibpt/prewarm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
            body: JSON.stringify({
                uf: cfg.uf, cnpj: cfg.cnpj, token: cfg.ibptToken,
                itens: ncms.map(ncm => ({ ncm }))
            })
        }).catch(err => { throw new Error('Falha ao contatar o serviço fiscal: ' + err.message); });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `Falha ao iniciar atualização (${resp.status}).`);
        return data;
    }

    // ---------- Transmissão de NFC-e emitida em contingência ----------
    async function transmitirContingencia(notaId) {
        const cfg = await getConfig();
        const notaRef = db().collection('notas_fiscais').doc(notaId);
        const snap = await notaRef.get();
        if (!snap.exists) throw new Error('Nota não encontrada.');
        const nota = snap.data();
        if (nota.status !== 'CONTINGENCIA') throw new Error('Esta nota não está em contingência.');
        if (!nota.xmlAssinado) throw new Error('XML da contingência ausente — não é possível transmitir.');

        let resp, data;
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/transmitir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify({ ambiente: nota.ambiente || cfg.ambiente || 'homologacao', uf: cfg.uf, xmlAssinado: nota.xmlAssinado })
            });
            data = await resp.json();
        } catch (err) { throw new Error('Falha ao contatar o serviço fiscal: ' + err.message); }

        if (data.status === 'AUTORIZADA') {
            await notaRef.update({
                status: 'AUTORIZADA', protocolo: data.protocolo || null, cStat: data.cStat || null,
                motivo: null, contingencia: false, xmlAssinado: null,
                danfeBase64: data.danfeBase64 || nota.danfeBase64 || null,
                transmitida_em: firebase.firestore.FieldValue.serverTimestamp()
            });
            return data;
        }
        // Se a SEFAZ respondeu com um cStat, ela processou e rejeitou de vez — não
        // adianta ficar reenviando o MESMO XML já assinado (o problema está no
        // conteúdo/assinatura dele, reenviar sempre dá o mesmo erro). Libera o
        // pedido pra uma emissão nova do zero (número novo, XML novo, assinado
        // com o código atual) em vez de deixar a nota presa em CONTINGENCIA pra
        // sempre. Sem cStat (falha de rede/comunicação) mantém em CONTINGENCIA —
        // aí sim vale tentar "Transmitir" de novo depois.
        if (data.cStat) {
            await notaRef.update({
                status: 'ERRO', cStat: data.cStat, motivo: data.motivo || data.error || null, contingencia: false,
            });
            if (nota.pedido_id) {
                db().collection('pedidos').doc(nota.pedido_id).set({ nfce_pendente: true }, { merge: true }).catch(() => {});
            }
            throw new Error(`Transmissão rejeitada pela SEFAZ (${data.cStat}): ${data.motivo || 'erro'}. Uma nova emissão (número novo) foi liberada para este pedido.`);
        }
        await notaRef.update({ motivo: data.motivo || data.error || null });
        throw new Error(`Falha ao transmitir: ${data.motivo || data.error || 'erro'}`);
    }

    // ---------- Cancelamento (evento 110111) ----------
    async function cancelar(notaId, justificativa) {
        const cfg = await getConfig();
        const just = String(justificativa || '').trim();
        if (just.length < 15 || just.length > 255) throw new Error('A justificativa deve ter entre 15 e 255 caracteres.');

        const notaRef = db().collection('notas_fiscais').doc(notaId);
        const snap = await notaRef.get();
        if (!snap.exists) throw new Error('Nota fiscal não encontrada.');
        const nota = snap.data();
        if (nota.status !== 'AUTORIZADA') throw new Error('Só é possível cancelar uma nota AUTORIZADA.');
        if (!nota.chave || !nota.protocolo) throw new Error('Nota sem chave/protocolo — não é possível cancelar.');

        const payload = {
            ambiente: nota.ambiente || cfg.ambiente || 'homologacao',
            uf: cfg.uf, cnpjEmitente: cfg.cnpj,
            chave: nota.chave, protocolo: nota.protocolo, justificativa: just
        };
        let resp, data;
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/cancelar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify(payload)
            });
            data = await resp.json();
        } catch (err) { throw new Error('Falha ao contatar o serviço fiscal: ' + err.message); }

        const cancelamento = {
            status: data.status || 'ERRO', cStat: data.cStat || null,
            motivo: data.motivo || data.error || null, protocolo: data.protocolo || null,
            justificativa: just, em: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (data.status === 'CANCELADA') {
            await notaRef.update({ status: 'CANCELADA', cancelamento });
        } else {
            await notaRef.update({ cancelamento });
            throw new Error(`Cancelamento não homologado (${data.cStat || '-'}): ${data.motivo || data.error || 'erro'}`);
        }
        return data;
    }

    // ---------- Inutilização de numeração (NFeInutilizacao4) ----------
    async function inutilizar({ serie, nNFIni, nNFFin, justificativa }) {
        const cfg = await getConfig();
        const just = String(justificativa || '').trim();
        if (just.length < 15 || just.length > 255) throw new Error('A justificativa deve ter entre 15 e 255 caracteres.');
        if (!(Number(nNFFin) >= Number(nNFIni))) throw new Error('Faixa inválida: número final deve ser >= inicial.');

        const payload = {
            ambiente: cfg.ambiente || 'homologacao', uf: cfg.uf, cnpjEmitente: cfg.cnpj,
            serie: Number(serie || cfg.serie || 1), nNFIni: Number(nNFIni), nNFFin: Number(nNFFin),
            modelo: 'NFCE', justificativa: just
        };
        let resp, data;
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/inutilizar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify(payload)
            });
            data = await resp.json();
        } catch (err) { throw new Error('Falha ao contatar o serviço fiscal: ' + err.message); }

        await db().collection('notas_fiscais').add({
            tipo: 'INUTILIZACAO', serie: payload.serie, nNFIni: payload.nNFIni, nNFFin: payload.nNFFin,
            status: data.status || 'ERRO', cStat: data.cStat || null,
            motivo: data.motivo || data.error || null, protocolo: data.protocolo || null,
            justificativa: just, ambiente: payload.ambiente,
            criado_em: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (data.status !== 'INUTILIZADA') {
            throw new Error(`Inutilização não homologada (${data.cStat || '-'}): ${data.motivo || data.error || 'erro'}`);
        }
        return data;
    }

    // Grava um documento DFe (dfe_documentos) + auto-cadastra o fornecedor a partir
    // do emitente. Compartilhado entre a sincronizacao automatica e a importacao manual.
    function salvarDocumentoDfe(batch, doc, now, fornecedoresVistos) {
        const id = doc.chave || doc.nsu;
        if (!id) return;
        const ref = db().collection('dfe_documentos').doc(String(id));
        batch.set(ref, { ...doc, atualizado_em: now, criado_em: now }, { merge: true });

        const cnpjForn = String(doc.cnpjEmitente || '').replace(/\D/g, '');
        if (cnpjForn && !fornecedoresVistos.has(cnpjForn)) {
            fornecedoresVistos.add(cnpjForn);
            const fornRef = db().collection('fornecedores').doc(cnpjForn);
            batch.set(fornRef, {
                nome: doc.emitente || cnpjForn,
                cnpj: cnpjForn,
                fone: doc.foneEmitente || null,
                atualizado_em: now,
            }, { merge: true });
        }
    }

    async function sincronizarDfe() {
        const cfg = await getConfig();
        validarConfig({ ...cfg, ativo: true });
        if (!cfg.cnpj) throw new Error('CNPJ da empresa ausente em Configuracoes > Fiscal.');
        if (!cfg.uf) throw new Error('UF da empresa ausente em Configuracoes > Fiscal.');

        const resp = await fetch(`${cfg.url}/fiscal/dfe/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
            body: JSON.stringify({
                ambiente: cfg.ambiente,
                uf: cfg.uf,
                cnpj: cfg.cnpj,
                ultNSU: cfg.dfeUltNSU || '0'
            })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || data.motivo || `Falha ao sincronizar DFe (${resp.status}).`);

        const batch = db().batch();
        const now = firebase.firestore.FieldValue.serverTimestamp();
        const fornecedoresVistos = new Set();
        (data.documentos || []).forEach(doc => salvarDocumentoDfe(batch, doc, now, fornecedoresVistos));
        batch.set(db().collection('configuracoes').doc('fiscal'), {
            dfeUltNSU: data.ultNSU || cfg.dfeUltNSU || '0',
            dfeMaxNSU: data.maxNSU || cfg.dfeMaxNSU || '0',
            dfeSincronizadoEm: now
        }, { merge: true });
        await batch.commit();
        return data;
    }

    // Importa uma NF-e avulsa (upload de .xml), fora da sincronizacao automatica —
    // mesmo fluxo de gravacao (dfe_documentos + fornecedor), cai na mesma tela de
    // "dar entrada no estoque".
    async function importarXmlAvulso(xmlTexto) {
        const cfg = await getConfig();
        if (!cfg.url) throw new Error('Informe a URL do servico fiscal em Configuracoes > Fiscal.');

        const resp = await fetch(`${cfg.url}/fiscal/dfe/importar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
            body: JSON.stringify({ xml: xmlTexto })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `Falha ao importar XML (${resp.status}).`);

        const batch = db().batch();
        const now = firebase.firestore.FieldValue.serverTimestamp();
        salvarDocumentoDfe(batch, data.documento, now, new Set());
        await batch.commit();
        return data.documento;
    }

    window.FiscalClient = { getConfig, emitir, emitirAutomatico, cancelar, inutilizar, transmitirContingencia, sincronizarDfe, importarXmlAvulso, visualizarCupom, prewarmTributosIbpt, retentarNotasComErroDeRede, retentarEmissoesAutomaticasPendentes, resgatarNotasTravadas };
})();
