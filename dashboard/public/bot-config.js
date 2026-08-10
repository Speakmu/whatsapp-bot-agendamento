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
        chave_pix: 'abc1231234567',
        modelo: 'gpt-4o',
        mensagem_inicial: 'Ola! Como posso ajudar?',
        mensagem_inativo: 'No momento o atendimento automatico esta pausado. Em breve nossa equipe responde por aqui.',
        mensagem_pronto: 'Oi {nome_cliente}! Seu pedido esta pronto!',
        mensagem_retirada: 'Boa noticia, {nome_cliente}! Seu pedido ja pode ser retirado!',
        mensagem_erro: 'Desculpe, tive um probleminha aqui. Pode repetir?',
        instrucoes_extras: ''
    };

    const DIAS_SEMANA = [
        { chave: 'seg', nome: 'Segunda' },
        { chave: 'ter', nome: 'Terça' },
        { chave: 'qua', nome: 'Quarta' },
        { chave: 'qui', nome: 'Quinta' },
        { chave: 'sex', nome: 'Sexta' },
        { chave: 'sab', nome: 'Sábado' },
        { chave: 'dom', nome: 'Domingo' }
    ];
    const HORARIO_MENSAGEM_PADRAO = 'No momento estamos fechados. Nosso horário de funcionamento: {horario}';

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        montarTabelaHorario();
        carregarBot();
        $('salvar-bot').addEventListener('click', salvarBot);
        $('salvar-bairros').addEventListener('click', salvarBairros);
        $('salvar-horario').addEventListener('click', salvarHorario);
        $('bot-bairros-entrega').addEventListener('input', atualizarContagemBairros);
    });

    function montarTabelaHorario() {
        const body = $('horario-dias-body');
        body.innerHTML = DIAS_SEMANA.map(d => `
            <tr>
                <td style="padding:6px 4px;">${d.nome}</td>
                <td style="padding:6px 4px;"><input type="checkbox" id="horario-${d.chave}-aberto" style="width:18px;height:18px;"></td>
                <td style="padding:6px 4px;"><input type="time" id="horario-${d.chave}-abre" style="padding:6px;"></td>
                <td style="padding:6px 4px;"><input type="time" id="horario-${d.chave}-fecha" style="padding:6px;"></td>
            </tr>
        `).join('');
    }

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
            atualizarContagemBairros();

            const horario = d.horario_funcionamento || {};
            const dias = horario.dias || {};
            $('horario-ativo').checked = horario.ativo === true;
            $('horario-mensagem-fechado').value = horario.mensagem_fechado || '';
            DIAS_SEMANA.forEach(dd => {
                const cfgDia = dias[dd.chave] || {};
                $(`horario-${dd.chave}-aberto`).checked = cfgDia.aberto === true;
                $(`horario-${dd.chave}-abre`).value = cfgDia.abre || '';
                $(`horario-${dd.chave}-fecha`).value = cfgDia.fecha || '';
            });
        } catch (err) {
            console.warn('bot:', err.message);
        }
    }

    async function salvarHorario() {
        const dias = {};
        DIAS_SEMANA.forEach(d => {
            dias[d.chave] = {
                aberto: $(`horario-${d.chave}-aberto`).checked,
                abre: $(`horario-${d.chave}-abre`).value || '',
                fecha: $(`horario-${d.chave}-fecha`).value || ''
            };
        });
        try {
            await DOC_BOT.set({
                horario_funcionamento: {
                    ativo: $('horario-ativo').checked,
                    mensagem_fechado: $('horario-mensagem-fechado').value.trim() || HORARIO_MENSAGEM_PADRAO,
                    dias
                },
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            flash('Horário de funcionamento salvo.');
        } catch (err) {
            alert('Erro ao salvar horário: ' + err.message);
        }
    }

    async function salvarBairros() {
        try {
            await DOC_BOT.set({
                bairros_entrega: bairrosDoTexto(),
                taxa_entrega: parseFloat($('bot-taxa-entrega').value) || 0,
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
