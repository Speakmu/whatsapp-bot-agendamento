// Service Worker do PDV — cacheia os arquivos estáticos (HTML/JS/CSS) para o
// caixa conseguir ABRIR/RECARREGAR mesmo sem internet. Os DADOS (cardápio,
// sessão de caixa, vendas) continuam por conta do Firestore com persistência
// offline (enablePersistence, ligado em caixa.js) — este arquivo só resolve
// o "esqueleto" da página.
//
// Estratégia: network-first (tenta a rede, atualiza o cache com a resposta
// mais nova) e só cai pro cache quando a rede falha de verdade (offline).
// Isso evita servir uma versão desatualizada da página para quem está online.
const CACHE = 'pdv-static-v2';

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
        caches.open(CACHE)
            .then(cache => Promise.all(PRECACHE_URLS.map(url =>
                cache.add(new Request(url, { cache: 'reload' })).catch(err => console.warn('Pré-cache falhou:', url, err))
            )))
            .then(() => self.skipWaiting())
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

    event.respondWith(
        fetch(event.request)
            .then(resp => {
                if (resp && resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
                }
                return resp;
            })
            .catch(async () => (await caches.match(event.request)) || Response.error())
    );
});
