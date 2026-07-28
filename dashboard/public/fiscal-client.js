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
        if (Array.isArray(lista) && lista.length) {
            return lista.map(i => ({
                xProd: i.nome_exibicao || i.nome || 'Item',
                ncm: i.ncm || cfg.ncm,
                cfop: i.cfop || cfg.cfop,
                csosn: i.csosn || cfg.cst,
                origem: i.origem || cfg.origem || '0',
                uCom: 'UN',
                qCom: Number(i.quantidade) || 1,
                vUnCom: Number(i.preco) || 0
            }));
        }
        // fallback: item único com o total
        return [{
            xProd: pedido.item_pedido || 'Consumo', ncm: cfg.ncm, cfop: cfg.cfop,
            csosn: cfg.cst, origem: cfg.origem || '0', uCom: 'UN', qCom: 1,
            vUnCom: Number(pedido.valor_total) || 0
        }];
    }

    function validarConfig(cfg) {
        const faltando = [];
        if (!cfg.ativo) throw new Error('Emissão fiscal está desativada em Configurações.');
        ['url', 'cnpj', 'csc', 'cscId', 'uf', 'cMun', 'xLgr', 'nro', 'xBairro', 'xMun', 'cep', 'qrBaseUrl']
            .forEach(k => { if (!cfg[k]) faltando.push(k); });
        if (faltando.length) throw new Error('Configuração fiscal incompleta: ' + faltando.join(', '));
    }

    async function emitir(pedidoId, pedido) {
        const cfg = await getConfig();
        validarConfig(cfg);

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
            qrBaseUrl: cfg.qrBaseUrl, urlChave: cfg.urlChave,
            aliquotaAproxTributos: Number(cfg.aliquotaAproxTributos) || 0,
            ibptToken: cfg.ibptToken || undefined,
            payment: { tPag: mapTPag(pedido.forma_pagamento), vPag: Number(pedido.valor_total) || 0 },
            items: itensDoPedido(pedido, cfg),
            recipient: pedido.cpf_cliente ? { cpf: pedido.cpf_cliente, xNome: pedido.nome_cliente } : undefined
        };

        let resp, data;
        try {
            resp = await fetch(`${cfg.url}/fiscal/nfce/avulsa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}) },
                body: JSON.stringify(payload)
            });
            data = await resp.json();
        } catch (err) {
            throw new Error('Falha ao contatar o serviço fiscal: ' + err.message);
        }

        // grava registro da nota (sempre, mesmo se rejeitada, para auditoria)
        const emContingencia = data.status === 'CONTINGENCIA';
        const registro = {
            pedido_id: pedidoId,
            nNF, serie: payload.serie,
            status: data.status || (resp.ok ? 'AUTORIZADA' : 'ERRO'),
            chave: data.chave || null,
            protocolo: data.protocolo || null,
            cStat: data.cStat || null,
            motivo: data.motivo || data.error || null,
            valor: payload.payment.vPag,
            danfeBase64: data.danfeBase64 || null,
            ambiente: payload.ambiente,
            contingencia: !!data.contingencia,
            // guarda o XML assinado apenas na contingência (para transmitir depois)
            xmlAssinado: emContingencia ? (data.xml || null) : null,
            criado_em: firebase.firestore.FieldValue.serverTimestamp()
        };
        const ref = await db().collection('notas_fiscais').add(registro);

        // AUTORIZADA e CONTINGÊNCIA são desfechos válidos da venda; só rejeição/erro dão exceção
        if (registro.status !== 'AUTORIZADA' && registro.status !== 'CONTINGENCIA') {
            throw new Error(`NFC-e não autorizada (${registro.cStat || '-'}): ${registro.motivo || 'erro desconhecido'}`);
        }
        return { id: ref.id, ...registro };
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
            qrBaseUrl: cfg.qrBaseUrl, urlChave: cfg.urlChave,
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
        await notaRef.update({ cStat: data.cStat || null, motivo: data.motivo || data.error || null });
        throw new Error(`Transmissão não autorizada (${data.cStat || '-'}): ${data.motivo || data.error || 'erro'}`);
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
        (data.documentos || []).forEach(doc => {
            const id = doc.chave || doc.nsu;
            if (!id) return;
            const ref = db().collection('dfe_documentos').doc(String(id));
            batch.set(ref, { ...doc, atualizado_em: now, criado_em: now }, { merge: true });
        });
        batch.set(db().collection('configuracoes').doc('fiscal'), {
            dfeUltNSU: data.ultNSU || cfg.dfeUltNSU || '0',
            dfeMaxNSU: data.maxNSU || cfg.dfeMaxNSU || '0',
            dfeSincronizadoEm: now
        }, { merge: true });
        await batch.commit();
        return data;
    }

    window.FiscalClient = { getConfig, emitir, cancelar, inutilizar, transmitirContingencia, sincronizarDfe, visualizarCupom, prewarmTributosIbpt };
})();
