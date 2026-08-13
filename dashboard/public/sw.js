// Service Worker do PDV — cacheia os arquivos estáticos (HTML/JS/CSS) para o
// caixa conseguir ABRIR/RECARREGAR mesmo sem internet. Os DADOS (cardápio,
// sessão de caixa, vendas) continuam por conta do Firestore com persistência
// offline (enablePersistence, ligado em caixa.js) — este arquivo só resolve
// o "esqueleto" da página.
//
// Duas estratégias diferentes por tipo de arquivo:
// - Código próprio (HTML/JS/CSS deste domínio): stale-while-revalidate —
//   responde NA HORA com o que já está salvo (sem esperar rede nenhuma) e
//   atualiza o cache por trás pra próxima vez; só espera a rede de verdade
//   se ainda não tem nada salvo. Era "network-first" antes, mas o Network
//   do DevTools mostrou esse plano saindo bem caro: as conexões do
//   Firestore em tempo real (o "channel" de long-polling) ficam abertas
//   por muito tempo e disputam com os arquivos estáticos o número limitado
//   de conexões simultâneas que o navegador permite por site — um
//   styles.css de poucos KB ficava preso na fila por quase 1 minuto atrás
//   delas. Pequeno preço: depois de um deploy, a 1ª abertura ainda pode
//   servir a versão anterior por uma fração de segundo até o cache
//   atualizar — bem melhor que travar a tela por um minuto.
// - SDK do Firebase no gstatic.com: cache-first. A URL já tem a versão presa
//   (8.6.8) — o conteúdo dela NUNCA muda, então baixar de novo a cada reload
//   só adiciona demora sem nenhum ganho de atualização. Cada página do
//   painel carrega esse SDK de novo (o shell e o iframe de dentro, cada um
//   com seu próprio <script>), então essa troca sozinha já evita várias
//   rodadas de rede desnecessárias por navegação.
const CACHE = 'pdv-static-v4';
const GSTATIC_FIREBASE_PREFIX = 'https://www.gstatic.com/firebasejs/8.6.8/';

// Pré-cache: sem isso, o Service Worker só guarda um arquivo depois que ele é
// visitado online pelo menos uma vez (cache "sob demanda") — se o operador for
// direto pro PDV offline sem nunca ter aberto essa página antes com internet,
// não tem nada salvo ainda. Baixando essa lista já na instalação garante que o
// PDV abre offline mesmo na primeira vez.
const PRECACHE_URLS = [
    '/admin.html',
    '/admin-shell.js',
    '/caixa.html',
    '/caixa.js',
    '/fiscal-client.js',
    '/baixa-estoque.js',
    '/shell.css',
    '/shell.js',
    '/firebase-config.js',
    '/emu.js',
    'https://www.gstatic.com/firebasejs/8.6.8/firebase-app.js',
    'https://www.gstatic.com/firebasejs/8.6.8/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/8.6.8/firebase-auth.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // Um de cada vez, não Promise.all: baixar os ~12 arquivos em
            // paralelo saturava a conexão e travava a navegação real que
            // estivesse rolando ao mesmo tempo (visto direto no Network do
            // DevTools — a página pedida ficava "pending" minutos enquanto
            // o pré-cache competia pela mesma banda). Sequencial demora um
            // pouco mais pra terminar, mas não briga com o que o usuário
            // está tentando abrir na hora.
            // Sem 'cache: reload' também: deixa o navegador validar com o
            // servidor (HTTP 304) em vez de forçar rebaixar tudo inteiro
            // sempre que o SW reinstala.
            for (const url of PRECACHE_URLS) {
                try {
                    await cache.add(url);
                } catch (err) {
                    console.warn('Pré-cache falhou:', url, err);
                }
            }
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    // Chrome/Edge às vezes disparam uma requisição de navegação com
    // cache:'only-if-cached' + mode diferente de 'same-origin' (prefetch
    // interno do navegador). Repassar isso pra fetch() lança um erro
    // síncrono e derruba a navegação inteira (ERR_FAILED) — tem que ignorar.
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

    const url = event.request.url;
    // Nunca interceptar chamadas de dados (Firestore/Auth/Functions/serviço
    // fiscal) — só o "esqueleto" estático da página deve vir do cache.
    if (url.includes('firestore.googleapis.com')
        || url.includes('identitytoolkit.googleapis.com')
        || url.includes('cloudfunctions.net')
        || url.includes('/__/')) return;

    // SDK do Firebase (URL com versão presa): serve do cache na hora se já
    // tiver, sem nem tentar a rede primeiro — não tem "versão mais nova"
    // possível pra essa URL específica.
    if (url.startsWith(GSTATIC_FIREBASE_PREFIX)) {
        event.respondWith(
            caches.match(event.request).then(cached => cached || fetch(event.request).then(resp => {
                if (resp && resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
                }
                return resp;
            }))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            const atualizarEmSegundoPlano = fetch(event.request)
                .then(resp => {
                    if (resp && resp.ok) {
                        const copy = resp.clone();
                        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
                    }
                    return resp;
                })
                .catch(() => cached || Response.error());
            // Já tem versão salva? Responde com ela na hora, sem esperar a
            // rede — a atualização acontece em segundo plano, pra próxima
            // vez. Só espera a rede de verdade na primeiríssima visita.
            return cached || atualizarEmSegundoPlano;
        })
    );
});
