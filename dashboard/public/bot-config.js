// Configuracoes do bot de atendimento (WhatsApp).
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const DOC_BOT = db.collection('configuracoes').doc('bot');
    const BOT_DEFAULTS = {
        ativo: true,
        nome_atendente: 'Sofia',
        nome_empresa: 'Lileamar Salgados',
        chave_pix: '', // sem chave de exemplo: campo vazio força o cliente a configurar a chave real
        modelo: 'gpt-4o',
        mensagem_inicial: 'Ola! Como posso ajudar?',
        mensagem_inativo: 'No momento o atendimento automatico esta pausado. Em breve nossa equipe responde por aqui.',
        mensagem_pronto: 'Oi {nome_cliente}! Seu pedido esta pronto!',
        mensagem_retirada: 'Boa noticia, {nome_cliente}! Seu pedido ja pode ser retirado!',
        mensagem_erro: 'Desculpe, tive um probleminha aqui. Pode repetir?',
        instrucoes_extras: '',
        divulgar_app: false,
        ferias_ativo: false,
        ferias_inicio: '',
        ferias_fim: '',
        ferias_mensagem: 'Estamos de férias no momento e voltamos no dia {data_volta}. Até lá!'
    };

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregarBot();
        $('salvar-bot').addEventListener('click', salvarBot);
        $('salvar-bairros').addEventListener('click', salvarBairros);
        $('bot-bairros-entrega').addEventListener('input', atualizarContagemBairros);
    });

    function bairrosDoTexto() {
        // Aceita um por linha OU separados por vírgula (ou os dois misturados).
        return $('bot-bairros-entrega').value
            .split(/[\n,]+/)
            .map(b => b.trim())
            .filter(Boolean);
    }

    function atualizarContagemBairros() {
        const n = bairrosDoTexto().length;
        $('bairros-count').textContent = n === 1 ? '1 bairro cadastrado' : `${n} bairros cadastrados`;
    }

    async function carregarBot() {
        try {
            const snap = await DOC_BOT.get();
            const d = { ...BOT_DEFAULTS, ...(snap.exists ? (snap.data() || {}) : {}) };
            $('bot-ativo').checked = d.ativo !== false;
            $('bot-divulgar-app').checked = d.divulgar_app === true;
            $('bot-ferias-ativo').checked = d.ferias_ativo === true;
            $('bot-ferias-inicio').value = d.ferias_inicio || '';
            $('bot-ferias-fim').value = d.ferias_fim || '';
            $('bot-ferias-mensagem').value = d.ferias_mensagem || '';
            $('bot-nome-atendente').value = d.nome_atendente || '';
            $('bot-nome-empresa').value = d.nome_empresa || '';
            $('bot-chave-pix').value = d.chave_pix || '';
            $('bot-modelo').value = d.modelo || BOT_DEFAULTS.modelo;
            $('bot-mensagem-inicial').value = d.mensagem_inicial || '';
            $('bot-mensagem-inativo').value = d.mensagem_inativo || '';
            $('bot-mensagem-pronto').value = d.mensagem_pronto || '';
            $('bot-mensagem-retirada').value = d.mensagem_retirada || '';
            $('bot-mensagem-erro').value = d.mensagem_erro || '';
            $('bot-instrucoes-extras').value = d.instrucoes_extras || '';
            $('bot-bairros-entrega').value = Array.isArray(d.bairros_entrega) ? d.bairros_entrega.join('\n') : '';
            $('bot-taxa-entrega').value = d.taxa_entrega != null ? d.taxa_entrega : 0;
            $('bot-cidade-atendida').value = d.cidade_atendida || '';
            atualizarContagemBairros();
        } catch (err) {
            console.warn('bot:', err.message);
        }
    }

    async function salvarBairros() {
        try {
            await DOC_BOT.set({
                bairros_entrega: bairrosDoTexto(),
                taxa_entrega: parseFloat($('bot-taxa-entrega').value) || 0,
                cidade_atendida: $('bot-cidade-atendida').value.trim(),
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            atualizarContagemBairros();
            flash('Bairros e taxa de entrega salvos.');
        } catch (err) {
            alert('Erro ao salvar bairros: ' + err.message);
        }
    }

    async function salvarBot() {
        const payload = {
            ativo: $('bot-ativo').checked,
            divulgar_app: $('bot-divulgar-app').checked,
            ferias_ativo: $('bot-ferias-ativo').checked,
            ferias_inicio: $('bot-ferias-inicio').value || '',
            ferias_fim: $('bot-ferias-fim').value || '',
            ferias_mensagem: $('bot-ferias-mensagem').value.trim() || BOT_DEFAULTS.ferias_mensagem,
            nome_atendente: $('bot-nome-atendente').value.trim() || BOT_DEFAULTS.nome_atendente,
            nome_empresa: $('bot-nome-empresa').value.trim() || BOT_DEFAULTS.nome_empresa,
            chave_pix: $('bot-chave-pix').value.trim(),
            modelo: $('bot-modelo').value || BOT_DEFAULTS.modelo,
            mensagem_inicial: $('bot-mensagem-inicial').value.trim() || BOT_DEFAULTS.mensagem_inicial,
            mensagem_inativo: $('bot-mensagem-inativo').value.trim() || BOT_DEFAULTS.mensagem_inativo,
            mensagem_pronto: $('bot-mensagem-pronto').value.trim() || BOT_DEFAULTS.mensagem_pronto,
            mensagem_retirada: $('bot-mensagem-retirada').value.trim() || BOT_DEFAULTS.mensagem_retirada,
            mensagem_erro: $('bot-mensagem-erro').value.trim() || BOT_DEFAULTS.mensagem_erro,
            instrucoes_extras: $('bot-instrucoes-extras').value.trim(),
            atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
        };
        try {
            await DOC_BOT.set(payload, { merge: true });
            flash('Configuracoes do bot salvas.');
        } catch (err) {
            alert('Erro ao salvar bot: ' + err.message);
        }
    }

    function flash(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }
});
