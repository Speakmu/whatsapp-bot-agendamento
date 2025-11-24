from flask import Flask, request
import requests
import os
import json
import gspread
import gspread.exceptions
import openai
import datetime
import re
import calendar
import unicodedata

COL_WA_ID = 0            # Coluna A
COL_TIPO_CLIENTE = 1     # Coluna B
COL_NOME_CLIENTE = 2     # Coluna C
COL_SERVICO = 3          # Coluna D 
COL_DATA_HORA = 4        # Coluna E
COL_TELEFONE = 5         # Coluna F
COL_ENDERECO = 6         # Coluna G
COL_MODELO_EQUIPAMENTO = 7 # Coluna H
COL_OBSERVACAO = 8       # Coluna I
COL_STATUS = 9           # Coluna J
COL_MOTIVO_CANCELAMENTO = 10 # Coluna K

# --- 1. CONFIGURAÇÃO DA CHAVE OpenAI ---
OPENAI_API_KEY = os.environ.get ("OPENAI_API_KEY") 
openai.api_key = OPENAI_API_KEY

# --- CONFIGURAÇÃO GOOGLE SHEETS ---
ARQUIVO_CREDENCIAL = 'whatsapp-bot-agendamentos.json' # Nome do arquivo 
NOME_DA_PLANILHA = 'Agendamentos_SeuSuporte_Tec' # Nome da planilha
ABA_PRESENCIAL = 'PRESENCIAL'
ABA_REMOTO = 'REMOTO'

HORARIOS_DISPONIVEIS = [
    (datetime.time(9, 0), datetime.time(12, 0)),  # 09:00 às 12:00
    (datetime.time(14, 0), datetime.time(18, 0))   # 14:00 às 18:00
]
DURACAO_ATENDIMENTO = 60  # Duração em minutos
# Exemplo de um agendamento existente (vamos supor que é um objeto datetime)
horario_inicio_existente = datetime.datetime(2025, 11, 17, 10, 0) # 17/11/2025 às 10:00

# Cálculo do Horário de Término
duracao = datetime.timedelta(minutes=DURACAO_ATENDIMENTO)
horario_termino_existente = horario_inicio_existente + duracao 
# Resultado: datetime.datetime(2025, 11, 17, 11, 0) -> 11:00

print(f"Início: {horario_inicio_existente.time()}")
print(f"Término: {horario_termino_existente.time()}")
# --- ARQUIVO DE HISTÓRICO ---
ARQUIVO_HISTORICO = 'chat_history.json' 

# Define o formato de data/hora usado na planilha
FORMATO_PLANILHA = "%d/%m/%Y %H:%M"



def verificar_disponibilidade(data_hora_solicitada: datetime.datetime, nome_da_aba: str) -> bool:
    """
    Verifica se o horário solicitado está disponível na agenda.
    Retorna True se estiver livre, False se estiver ocupado.
    """
    if nome_da_aba == ABA_REMOTO:
        return True  # Assume que todos os horários são livres para atendimentos remotos
    
    DATA_HORA_COL_INDEX = COL_DATA_HORA # <-- Use o valor 4
    STATUS_COL_INDEX = COL_STATUS       # <-- Use o valor 9
    DURACAO = datetime.timedelta(minutes=DURACAO_ATENDIMENTO)
    
    # 1. Checa a JANELA DE HORÁRIO DE TRABALHO
    horario_solicitado = data_hora_solicitada.time()
    esta_em_horario_trabalho = False
    
    for inicio_trabalho, fim_trabalho in HORARIOS_DISPONIVEIS:
        # Verifica se o horário solicitado está dentro de uma janela de trabalho
        if inicio_trabalho <= horario_solicitado and horario_solicitado < fim_trabalho:
            esta_em_horario_trabalho = True
            break

    if not esta_em_horario_trabalho:
        # Se o horário cair fora do 09h-12h ou 14h-18h
        # Você pode retornar uma string aqui se quiser informar a IA, ou apenas False
        return False # O horário está indisponível

    # 2. Checa CONFLITO com agendamentos existentes na planilha
    
    # Índices das colunas (Lembre-se: gspread retorna uma lista, onde o índice 0 é a Coluna A)
    
    DURACAO = datetime.timedelta(minutes=DURACAO_ATENDIMENTO)

    try:
        gc = gspread.service_account(filename=ARQUIVO_CREDENCIAL)
        sh = gc.open(NOME_DA_PLANILHA)
        worksheet = sh.worksheet(nome_da_aba)
        
        # Obtém todos os dados da planilha (lista de listas)
        todos_agendamentos = worksheet.get_all_values()
        
        # Ignora o cabeçalho
        for i, row in enumerate(todos_agendamentos[1:]): 
            
            if not isinstance(row, list):
                continue
            # Garante que a linha tem dados suficientes
            if len(row) > STATUS_COL_INDEX and row[STATUS_COL_INDEX].strip().upper() == 'PENDENTE':
                
                # Converte a string da data/hora (coluna 5) para um objeto datetime
                data_hora_inicio_str = row[DATA_HORA_COL_INDEX]
                
                try:
                    horario_inicio_existente = datetime.datetime.strptime(data_hora_inicio_str, FORMATO_PLANILHA)
                    
                    # Calcula o horário de término do agendamento existente
                    horario_termino_existente = horario_inicio_existente + DURACAO
                    
                    # Checa o CONFLITO de horários:
                    # Um conflito ocorre se o novo agendamento começa ANTES do término do existente
                    # E o novo agendamento termina DEPOIS do início do existente.
                    
                    # Novo agendamento TERMINA antes do início do existente? Não há conflito.
                    if data_hora_solicitada + DURACAO <= horario_inicio_existente:
                        continue 
                    
                    # Novo agendamento COMEÇA depois do término do existente? Não há conflito.
                    if data_hora_solicitada >= horario_termino_existente:
                        continue 
                        
                    # Se não caiu em nenhum dos continues, há um CONFLITO!
                    return False # Horário Ocupado
                    
                except ValueError:
                    # Ignora linhas com datas inválidas (útil para dados sujos)
                    continue 

        # Se o loop terminar sem encontrar conflitos, o horário está livre!
        return True 

    except Exception as e:
        print(f"Erro ao consultar planilha na verificação de disponibilidade: {e}")
        # Em caso de erro técnico, por segurança, consideramos indisponível
        return False
    
def gerar_horarios_disponiveis(data: datetime.date, nome_da_aba: str) -> str:
    """
    Gera uma string listando os horários disponíveis (slots de 1h) para a data fornecida.
    """
    horarios_livres = []
    
    # Itera sobre cada janela de trabalho (9h-12h e 14h-18h)
    for inicio_janela, fim_janela in HORARIOS_DISPONIVEIS:
        
        # Cria o primeiro slot para a data base (ex: 2025-11-17 09:00:00)
        slot_atual = datetime.datetime.combine(data, inicio_janela)
        
        # Itera enquanto o slot atual for menor que o fim da janela
        while slot_atual + datetime.timedelta(minutes=DURACAO_ATENDIMENTO) <= datetime.datetime.combine(data, fim_janela):
            
            # Verifica se o slot atual de 1 hora está livre
            if verificar_disponibilidade(slot_atual, nome_da_aba):
                horarios_livres.append(slot_atual.strftime("%H:%M"))
            
            # Avança para o próximo slot
            slot_atual += datetime.timedelta(minutes=DURACAO_ATENDIMENTO)

    if not horarios_livres:
        return "Nenhum horário disponível para esta data."
    else:
        # Formata a data (ex: Segunda-feira, 17/11)
        data_formatada = data.strftime("%A, %d/%m").replace('Monday', 'Segunda-feira').replace('Tuesday', 'Terça-feira') # ... e assim por diante
        
        return f"Os horários disponíveis para {data_formatada} são: {', '.join(horarios_livres)}."

def converter_texto_para_data(data_hora_texto: str) -> datetime.datetime:
    """Converte texto como 'amanhã às 14:00' ou 'terça às 10:00' em um objeto datetime."""
    data_hora_texto = data_hora_texto.lower().strip()
    hoje = datetime.date.today()
    dias_a_avancar = 0
    
    # Mapeamento de dias da semana (Segunda = 0, Domingo = 6)
    dias_semana = {
        'segunda': 0, 'terça': 1, 'quarta': 2, 'quinta': 3,
        'sexta': 4, 'sábado': 5, 'domingo': 6
    }
    
    # --- NOVOS SINÔNIMOS DE "PRÓXIMA SEMANA" ---
    frases_proxima_semana = ['semana que vem', 'próxima semana', 'outra semana']
    solicitou_proxima_semana = any(frase in data_hora_texto for frase in frases_proxima_semana)
    # -------------------------------------------
    
    # 1. Lógica para datas relativas e dias da semana
    if 'amanhã' in data_hora_texto:
        dias_a_avancar = 1
    elif 'hoje' in data_hora_texto:
        dias_a_avancar = 0
    else:
        # Lógica para dias da semana
        for nome_dia, num_dia in dias_semana.items():
            if nome_dia in data_hora_texto:
                dias_a_avancar = (num_dia - hoje.weekday() + 7) % 7
                
                if dias_a_avancar == 0: 
                    dias_a_avancar = 7 # Se for hoje, avança 7 dias para a próxima ocorrência
                
                # APLICA O AVANÇO SE FOR SOLICITADA A PRÓXIMA SEMANA
                if solicitou_proxima_semana:
                    dias_a_avancar += 7 
                
                break

    data_base = hoje + datetime.timedelta(days=dias_a_avancar)
    
    # 2. VERIFICAÇÃO E AVANÇO DE SÁBADO/DOMINGO (Garante que só agende em dias úteis)
    if data_base.weekday() == 5: # Sábado
        data_base += datetime.timedelta(days=2) # Avança 2 dias para Segunda
    elif data_base.weekday() == 6: # Domingo
        data_base += datetime.timedelta(days=1) # Avança 1 dia para Segunda
    
    # 3. Extrai a hora
    match_hora = re.search(r'(\d{1,2})[:h](\d{2})?', data_hora_texto)
    
    if match_hora:
        hora = int(match_hora.group(1))
        minuto = int(match_hora.group(2) or 0)
    else:
        raise ValueError("Hora não encontrada no texto.")
        
    # 4. Combina data e hora
    data_hora_final = datetime.datetime.combine(data_base, datetime.time(hora, minuto))
    
    return data_hora_final

def gerenciar_historico(wa_id: str, nova_mensagem: dict = None):
    """
    Carrega o histórico de um cliente (wa_id) e adiciona a nova mensagem,
    mantendo apenas as últimas 5 interações para contexto.
    """
    if os.path.exists(ARQUIVO_HISTORICO):
        with open(ARQUIVO_HISTORICO, 'r') as f:
            historico_completo = json.load(f)
    else:
        historico_completo = {}

    historico_cliente = historico_completo.get(wa_id, [])

    if nova_mensagem:
        # Adiciona nova mensagem e mantém apenas as últimas 5 (10 entradas: 5 usuário, 5 assistente)
        historico_cliente.append(nova_mensagem)
        historico_cliente = historico_cliente[-10:] # Mantém as últimas 10 entradas

    historico_completo[wa_id] = historico_cliente

    with open(ARQUIVO_HISTORICO, 'w') as f:
        json.dump(historico_completo, f, indent=4)

    return historico_cliente

def buscar_nome_cliente(wa_id):
    """
    Busca o nome do cliente nas abas PRESENCIAL e REMOTO (por esta ordem),
    retornando o nome encontrado por último.
    """
    try:
        gc = gspread.service_account(filename=ARQUIVO_CREDENCIAL)
        sh = gc.open(NOME_DA_PLANILHA)
        
        # Lista de abas a serem checadas
        abas_para_checar = [ABA_PRESENCIAL, ABA_REMOTO]
        nome_encontrado = None

        # Itera sobre as duas abas
        for nome_aba in abas_para_checar:
            try:
                worksheet = sh.worksheet(nome_aba)
                records = worksheet.get_all_values()
                
                # Procura de baixo para cima (mais recente)
                for row in reversed(records):
                    # O WA_ID está em COL_WA_ID (0)
                    if len(row) > COL_WA_ID and row[COL_WA_ID].strip() == wa_id:
                        
                        # Assumindo que COL_NOME_CLIENTE = 2 (Coluna C)
                        # NOTA: Garanta que COL_NOME_CLIENTE esteja definido como 2 no topo do arquivo.
                        if len(row) > 2: # Checa se a coluna 2 existe
                            nome_encontrado = row[2] 
                            return nome_encontrado # Retorna o nome assim que o encontrar
                
            except gspread.exceptions.WorksheetNotFound:
                print(f"Aba {nome_aba} não encontrada. Ignorando...")
                continue 

        return nome_encontrado # Retorna None se não encontrar em nenhuma das abas

    except Exception as e:
        print(f"Erro ao buscar nome no Google Sheets: {e}")
        return None

def normalizar_texto(texto):
    """Remove acentos e coloca em minúsculas para comparação."""
    if not texto: return ""
    return unicodedata.normalize('NFKD', texto).encode('ASCII', 'ignore').decode('ASCII').lower()

def agendar_atendimento(wa_id: str, tipo_cliente: str, nome_cliente: str, servico: str, data_hora: str, telefone: str, endereco: str, cidade_atendimento: str = None, modelo_equipamento: str = 'Não Informado', observacao: str = 'Nenhuma'):
    """
    Função REAL de agendamento que se conecta ao Google Sheets.
    Blindada contra falha na captura da cidade e acentos.
    """
    wa_id = wa_id.strip()

    # --- 1. PROTEÇÃO ANTI-TRAVAMENTO ---
    if not cidade_atendimento:
        print("AVISO: Cidade não recebida. Tentando deduzir...")
        # Se tiver data/hora válida (não for 'Fila'), assumimos Presencial
        if data_hora and ":" in data_hora and "fila" not in data_hora.lower():
            cidade_atendimento = "São Sebastião do Paraíso"
        else:
            cidade_atendimento = "Remoto"

    # --- 2. LÓGICA DE ROTEAMENTO INTELIGENTE (IGNORA ACENTOS) ---
    cidade_normalizada = normalizar_texto(cidade_atendimento)
    
    # Verifica palavras-chave de forma segura (ex: 'sao sebastiao', 'paraiso', 'presencial')
    if 'sebastiao' in cidade_normalizada or 'paraiso' in cidade_normalizada or 'presencial' in cidade_normalizada:
        nome_da_aba = ABA_PRESENCIAL
        tipo_servico = 'Presencial'
        eh_remoto = False
    else:
        nome_da_aba = ABA_REMOTO
        tipo_servico = 'Remoto'
        eh_remoto = True
        # Se for remoto, salva a cidade no campo endereço
        endereco = cidade_atendimento 

    # --- 3. TRATAMENTO DA DATA/HORA ---
    try:
        if eh_remoto:
            data_hora_formatada = "Fila"
        
        else:
            # PRESENCIAL
            try:
                data_hora_obj = converter_texto_para_data(data_hora)
            except ValueError:
                 return f"ERRO_DATA_HORA: Para atendimento presencial em {cidade_atendimento}, preciso de data e hora exatas. Não entendi: '{data_hora}'"

            # Verificação de Disponibilidade
            if not verificar_disponibilidade(data_hora_obj, nome_da_aba):
                data_solicitada = data_hora_obj.date()
                mensagem_disponibilidade = gerar_horarios_disponiveis(data_solicitada, nome_da_aba)
                return f"HORARIO_OCUPADO. {mensagem_disponibilidade}"
            
            data_hora_formatada = data_hora_obj.strftime(FORMATO_PLANILHA)

        # --- 4. SALVAR NO GOOGLE SHEETS ---
        gc = gspread.service_account(filename=ARQUIVO_CREDENCIAL)
        sh = gc.open(NOME_DA_PLANILHA)
        worksheet = sh.worksheet(nome_da_aba)

        # Validação final de campos vazios para evitar "None" na planilha
        dados_agendamento = [
            wa_id, 
            tipo_cliente or "N/I", 
            nome_cliente or "N/I", 
            servico or "Não Informado", # Garante que não fique vazio
            data_hora_formatada,
            telefone or "N/I", 
            endereco or "N/I", 
            modelo_equipamento or "Não Informado", 
            observacao or "Nenhuma", 
            'PENDENTE'
        ]
        
        worksheet.append_row(dados_agendamento)
        print(f"SUCESSO: Dados inseridos na aba {nome_da_aba}: {dados_agendamento}") 
        
        # 5. Retorno de Sucesso
        if eh_remoto:
             return f"AGENDAMENTO_SUCESSO_ABA_REMOTO. Atendimento remoto registrado na fila (Aba {nome_da_aba})."
        else:
             return f"AGENDAMENTO_SUCESSO_ABA_PRESENCIAL. Agendamento presencial confirmado para {data_hora_formatada}."

    except Exception as e:
        print(f"ERRO CRÍTICO NO GOOGLE SHEETS: {e}")
        return f"ERRO_TECNICO: Falha ao salvar na planilha. Detalhe: {str(e)}"
    
def reagendar_atendimento(wa_id: str, acao: str, nova_data_hora: str = None, motivo_cancelamento: str = None):
    """
    Função para reagendar ou cancelar um atendimento.
    RESTRIÇÃO: Funciona APENAS para atendimentos PRESENCIAIS (com horário marcado).
    """
    wa_id = wa_id.strip()
    
    # Define explicitamente que só vamos mexer na aba Presencial
    nome_aba_alvo = ABA_PRESENCIAL 
    
    worksheet = None
    linha_para_atualizar = -1

    try:
        gc = gspread.service_account(filename=ARQUIVO_CREDENCIAL)
        sh = gc.open(NOME_DA_PLANILHA)

        # 1. BUSCA APENAS NA ABA PRESENCIAL
        try:
            worksheet = sh.worksheet(nome_aba_alvo)
            records = worksheet.get_all_values()
            
            # Procura de baixo para cima (mais recente)
            for i, row in reversed(list(enumerate(records))):
                if i > 0 and len(row) > COL_STATUS:
                    # Verifica WA_ID e Status PENDENTE
                    if row[COL_WA_ID].strip() == wa_id and row[COL_STATUS].strip().upper() == 'PENDENTE':
                        linha_para_atualizar = i + 1
                        break
            
        except gspread.exceptions.WorksheetNotFound:
            return f"Erro Técnico: A aba {nome_aba_alvo} não foi encontrada."

        if linha_para_atualizar == -1:
            # Se não achou na Presencial, verifica se o cliente é Remoto para dar uma mensagem clara
            # (Opcional: apenas para não deixar o cliente confuso)
            return "Não encontrei nenhum agendamento PRESENCIAL pendente para reagendar. Se você está na fila de espera do atendimento Remoto e deseja cancelar, por favor entre em contato com o suporte humano."

        # --- 2. EXECUTA A AÇÃO ---
        
        if acao == 'cancelar':
            worksheet.update_cell(linha_para_atualizar, COL_STATUS + 1, 'CANCELADO')
            
            motivo_final = motivo_cancelamento if motivo_cancelamento else "Não Informado"
            try:
                worksheet.update_cell(linha_para_atualizar, COL_MOTIVO_CANCELAMENTO + 1, motivo_final)
            except:
                pass 

            return f"Seu agendamento presencial foi cancelado com sucesso."

        elif acao == 'reagendar' and nova_data_hora:
            
            # Validação de Data e Disponibilidade (Obrigatório para Presencial)
            try:
                data_hora_obj = converter_texto_para_data(nova_data_hora)
            except ValueError as ve:
                return f"ERRO_DATA_HORA: Data inválida. Detalhe: {ve}"

            if not verificar_disponibilidade(data_hora_obj, nome_aba_alvo):
                data_solicitada = data_hora_obj.date()
                msg_disp = gerar_horarios_disponiveis(data_solicitada, nome_aba_alvo)
                return f"HORARIO_OCUPADO. {msg_disp}"
            
            data_hora_formatada = data_hora_obj.strftime(FORMATO_PLANILHA)

            # Atualiza Data e Status
            worksheet.update_cell(linha_para_atualizar, COL_DATA_HORA + 1, data_hora_formatada)
            worksheet.update_cell(linha_para_atualizar, COL_STATUS + 1, 'PENDENTE')
            
            return f"Seu agendamento presencial foi reagendado com sucesso para: {data_hora_formatada}."

        else:
            return "Ação inválida ou dados incompletos."

    except Exception as e:
        print(f"Erro ao reagendar: {e}")
        return "ERRO_TECNICO: Falha ao processar reagendamento."

      
def get_openai_response(prompt: str, wa_id: str): # <--- AGORA PRECISA DO WA_ID
    """Gera a resposta usando o modelo da OpenAI, incluindo lógica de Function Calling."""
    function_args = {}
    # 1. CARREGA O HISTÓRICO ANTERIOR E ADICIONA A MENSAGEM DO USUÁRIO
    # O histórico retornado já está no formato [ {"role": "user", "content": "..."} ]
    historico = gerenciar_historico(wa_id, {"role": "user", "content": prompt})
    
    # 1. BUSCAR NOME DO CLIENTE
    nome_existente = buscar_nome_cliente(wa_id)
    
    # 2. CRIAR SAUDAÇÃO PERSONALIZADA
    saudacao_personalizada = ""
    
    if nome_existente:
        # Se encontrou o nome, instrua a IA a usá-lo para uma saudação.
        saudacao_personalizada = f"IMPORTANTE: Você identificou o cliente como '{nome_existente}' em um contato anterior. Na primeira interação, comece com uma saudação personalizada, como 'Bem-vindo de volta, {nome_existente}!', e só então siga com o FLUXO OBRIGATÓRIO."
    

    # 1. Definição da Ferramenta (Descrição para a IA)
    tools = [
        {
            "type": "function",
            "function": {
                "name": "agendar_atendimento",
                "description": "Agenda um novo atendimento de suporte técnico, após coletar todas as informações OBRIGATÓRIAS do cliente.",
                
            "parameters": {
                "type": "object",
                    "properties": {
                    "tipo_cliente": {"type": "string", "description": "Se o atendimento é para 'casa' ou para a 'empresa'."},
                    "nome_cliente": {"type": "string", "description": "Nome completo do cliente."},
                    "servico": {"type": "string", "description": "Breve descrição do serviço solicitado (ex: 'Conserto de notebook', 'Instalação de rede')."},
                    "data_hora": {"type": "string", "description": "Data e horário exatos solicitados."},
                    "telefone": {"type": "string", "description": "Telefone de contato do cliente. Pode ser o número atual ou outro que ele forneça."},
                    "endereco": {"type": "string", "description": "Endereço completo para o atendimento."},
                    "cidade_atendimento": {"type": "string", "description": "A cidade para qual o atendimento está sendo solicitado (ex: 'São Sebastião do Paraíso')."}, # <-- ADICIONE ISSO
                    "modelo_equipamento": {"type": "string", "description": "Modelo do equipamento a ser atendido (ex: 'Dell Inspiron 5000'). Use 'Não Informado' se o cliente não souber."},
                    "observacao": {"type": "string", "description": "Qualquer observação adicional do cliente (ex: 'Deixar a chave com o vizinho'). Use 'Nenhuma' se não houver."},
                },
                "required": ["tipo_cliente", "nome_cliente", "servico", "data_hora", "telefone", "endereco", "cidade_atendimento"], # <-- ADICIONE ISSO
            },

                
            },
            
        },
        # --- FERRAMENTA 2: REAGENDAR/CANCELAR ATENDIMENTO (NOVO!) ---
        {
            "type": "function",
            "function": {
                "name": "reagendar_atendimento",
                "description": "Usar SOMENTE quando o cliente solicitar modificar ou cancelar um agendamento existente.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "acao": {"type": "string", "enum": ["reagendar", "cancelar"], "description": "Ação desejada: 'reagendar' ou 'cancelar'."},
                        "nova_data_hora": {"type": "string", "description": "A nova data e horário. OBRIGATÓRIO se 'acao' for 'reagendar'."},
                        "motivo_cancelamento": {"type": "string", "description": "O motivo do cancelamento, se 'acao' for 'cancelar'. Use 'Não Informado' se o cliente não fornecer."},
                    },
                    "required": ["acao"], 
                },
            },
        } 
    ]
        
    

    # Seu System Prompt - Lógica de Ramificação de Persona
    # Seu System Prompt - Lógica de Ramificação de Persona
    messages = [
       {"role": "system", "content": f"""
        Você é o AGENTE DE ATENDIMENTO (Persona: Sofia para Casa, Júlio para Empresa) da Seu Suporte Tech.
        {saudacao_personalizada}
        
        **MISSÃO CRÍTICA:** Coletar dados para a função `agendar_atendimento`.
        **REGRA DE OURO:** Use o histórico para preencher argumentos. NUNCA repita perguntas.
        
        # --- 1. FLUXO INICIAL (ROTEAMENTO) ---
        1. **PERGUNTA 1:** "Para qual cidade você gostaria do atendimento?"
        2. **ANÁLISE:**
           - Se for **São Sebastião do Paraíso ou Paraíso ou SSParaíso (ignore letras maiusculas, acentos e erros de português) se ficar com dúvidas confime: a cidade é São Sebastião do Paraíso? **: O fluxo é **PRESENCIAL**.
           - Se for **Outra Cidade**: O fluxo é **REMOTO**.
        3. **RESPOSTA DO BOT:** Informe o tipo de atendimento ("o Atendimento pode ser presencial com hora marcada" ou "O Aterndimento será feito de forma remota") SEM repetir o nome da cidade.
        4. **PERGUNTA 2:** "O atendimento é para sua casa ou empresa?" Se for empresa, use a persona Júlio. Se for casa, use Sofia.

        # --- 2. REGRAS DE COLETA (O QUE PERGUNTAR) ---
        
        **FLUXO PRESENCIAL (São Sebastião do Paraíso):**
        - Pergunte: Serviço, Nome, Telefone, Endereço, **Data e Horário**, Modelo do equipamento.
        - Regra de Data: Apenas dias úteis (Segunda a Sexta).
         *** SEMPRE OLHAR O HISTÓRICO CIDADE DE ATENDIMENTO ANTES DE PERGUNTAR, POIS ELA É RESPONDIDA NO ÍNICIO DA CONVERSA. SE O CLIENTE JA TIVER RESPONDIDO, NÃO PERGUNTE NOVAMENTE. **_
        
        **FLUXO REMOTO (Outras Cidades):**
        - Pergunte: Serviço, Nome, Telefone.
        - **PROIBIDO PERGUNTAR DATA E HORÁRIO:** Você DEVE preencher o argumento `data_hora` AUTOMATICAMENTE com a palavra **"Fila"**. O cliente NÃO deve ser consultado sobre isso.
        - **PROIBIDO PERGUNTAR ENDEREÇO:** Você DEVE preencher o argumento `endereco` AUTOMATICAMENTE com a palavra **"Remoto"** (ou o nome da cidade informada).
        _ *** SEMPRE OLHAR O HISTÓRICO CIDADE DE ATENDIMENTO ANTES DE PERGUNTAR, POIS ELA É RESPONDIDA NO ÍNICIO DA CONVERSA. SE O CLIENTE JA TIVER RESPONDIDO, NÃO PERGUNTE NOVAMENTE. **_
        
        # --- 3. ARGUMENTOS DA FUNÇÃO (Preencha TODOS antes de chamar) ---
        - `tipo_cliente`: Casa/Empresa (definido no início)
        - `nome_cliente`: Nome completo (use o histórico se disponível)
        - `servico`: Descrição do problema (Obrigatório). Não coloque como resolvido, apenas registre.
        - `telefone`: Número de contato (use owa_id se o cliente não fornecer outro)
        - `modelo do equipamento`: Modelo do equipamento
        - `cidade_atendimento`: Cidade informada no início, *não pergunte novamente*.
        - `data_hora`: 
            - Se Presencial: Data/Hora solicitada pelo cliente.
            - Se Remoto: Preencha com **"Fila"**.
        - `endereco`: 
            - Se Presencial: Endereço físico.
            - Se Remoto: Preencha com **"Remoto"**.
            
        # --- 4. REAGENDAMENTO ---
        - Se o cliente quiser reagendar/cancelar: Chame `reagendar_atendimento` IMEDIATAMENTE. Peça apenas a nova data ou motivo. Ignora o fluxo acima.

        # --- 5. FINALIZAÇÃO ---
        - Chame `agendar_atendimento` APENAS quando tiver os 7 argumentos (lembrando de usar os valores automáticos para Remoto).
        - Após sucesso ('AGENDAMENTO_SUCESSO...'), despeça-se e ENCERRE. Não faça mais perguntas.
        """}
     ]
    {"role": "user", "content": prompt}
    # Adiciona o histórico carregado
    messages.extend(historico)

    try:
        # Primeira chamada à API (Decisão da IA: Responder ou Chamar Função)
        response = openai.chat.completions.create(
            model="gpt-4.1-mini", # <-- MODELO RECOMENDADO
            messages=messages,
            tools=tools,
            tool_choice="auto" 
        )
        
        response_message = response.choices[0].message
        final_response_text = response_message.content
        
        # Lógica de Function Calling
        if response_message.tool_calls:
            
            tool_call = response_message.tool_calls[0]
            function_name = tool_call.function.name
            
            if function_name == "agendar_atendimento":
                function_args = json.loads(tool_call.function.arguments)
                # --- NOVO: Lógica para Selecionar a Aba ---
                cidade = function_args.get("cidade_atendimento", "").strip().lower()
    
                 # Verifica se a cidade é São Sebastião do Paraíso (PRESENCIAL)
                if 'são sebastião do paraíso' in cidade or 'paraíso' in cidade:
                    nome_da_aba_final = ABA_PRESENCIAL
                else:
                    nome_da_aba_final = ABA_REMOTO
                
                function_to_call = agendar_atendimento
                
                # Chama a função Python real com todos os argumentos
                function_response = function_to_call(
                    wa_id=wa_id,
                    tipo_cliente=function_args.get("tipo_cliente"),
                    nome_cliente=function_args.get("nome_cliente"),
                    servico=function_args.get("servico"),
                    data_hora=function_args.get("data_hora"),
                    telefone=function_args.get("telefone"),
                    endereco=function_args.get("endereco"),
                    cidade_atendimento=function_args.get("cidade_atendimento"), 
                    # Campos Opcionais
                    modelo_equipamento=function_args.get("modelo_equipamento"),
                    observacao=function_args.get("observacao"),
                )
                # 2. NOVO: Adiciona a resposta da função ao histórico para a IA gerar a resposta final
                messages.append(response_message.model_dump())
                messages.append(
                    {
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": function_response,
                    }
                )
                
                # 3. NOVO: Segunda chamada à API. A IA agora recebe o resultado da função
                # e gera o texto de confirmação que será enviado ao cliente.
                second_response = openai.chat.completions.create(
                    model="gpt-4.1-mini",
                    messages=messages,
                )
                final_response_text = second_response.choices[0].message.content
                # --- 2. Lógica para REAGENDAR/CANCELAR (Nova Função) ---
            elif function_name == "reagendar_atendimento":
                function_args = json.loads(tool_call.function.arguments)
                function_to_call = reagendar_atendimento
                
                # Chama a função Python real
                function_response = function_to_call(
                    wa_id=wa_id, # INJETA O WA_ID para procurar o agendamento
                    acao=function_args.get("acao"),
                    nova_data_hora=function_args.get("nova_data_hora"),
                    motivo_cancelamento=function_args.get("motivo_cancelamento"),
                )
                
                # Adiciona a resposta da função ao histórico para a IA gerar a resposta final (que deve ser a pergunta: "Posso ajudar em algo mais?")
                messages.append(response_message.model_dump())
                messages.append(
                    {
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": function_response,
                    }
                )
                
                # Segunda chamada à API: Agora a IA recebe o resultado do agendamento e faz a pergunta final
                second_response = openai.chat.completions.create(
                model="gpt-4.1-mini",
                messages=messages,
              )
                final_response_text = second_response.choices[0].message.content
                
        # SALVA A RESPOSTA DA IA NO HISTÓRICO
        gerenciar_historico(wa_id, {"role": "assistant", "content": final_response_text})
        
        #Retorna a resposta final para o webhook enviar
        return final_response_text
    
    except Exception as e:
        print(f"Erro na API da OpenAI ou JSON: {e}")
        # É crucial salvar a resposta de erro no histórico para evitar novos loops
        error_msg = "Desculpe, houve um problema técnico. Tente novamente."
        gerenciar_historico(wa_id, {"role": "assistant", "content": error_msg})
        return error_msg

app = Flask(__name__)


VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN")
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID")

@app.route('/', methods=['GET'])
def home():
    return "API online - WhatsApp Bot Agendamento", 200


@app.route('/webhook', methods=['GET', 'POST'])
def webhook():
    if request.method == 'GET':
        token = request.args.get('hub.verify_token')
        challenge = request.args.get('hub.challenge')
        if token == VERIFY_TOKEN:
            return challenge
        return 'Token inválido', 403

    elif request.method == 'POST':
        data = request.json

        if data and 'entry' in data:
            for entry in data['entry']:
                if 'changes' in entry:
                    for change in entry['changes']:
                        if 'value' in change and 'messages' in change['value']:
                            for message in change['value']['messages']:
                                phone_number = change['value']['metadata']['phone_number_id']
                                from_number = message['from']

                                if 'text' in message:
                                    text = message['text']['body']
                                    ai_response = get_openai_response(text, from_number)
                                    send_message(from_number, ai_response)

        return 'EVENT_RECEIVED', 200

def send_message(to, message):
    """Função para enviar mensagens via API do WhatsApp Cloud."""
    url = f"https://graph.facebook.com/v17.0/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": message}
    }
    response = requests.post(url, headers=headers, json=payload)
    print(response.status_code, response.text)


app = Flask(__name__)



