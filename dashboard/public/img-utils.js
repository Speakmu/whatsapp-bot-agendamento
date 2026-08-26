// ============================================================
//  Utilitário compartilhado de compressão de imagem (client-side) —
//  usado por toda tela do dashboard que faz upload de imagem pro
//  Storage (cardápio, marca/logo, banners, totem, promoções).
//
//  Sem isso, cada upload sobe o arquivo original da câmera do usuário
//  (facilmente 3-8MB) direto pro Storage. Com vários clientes rodando
//  o mesmo sistema, isso vira custo real de armazenamento/banda —
//  redimensionar + recomprimir pra JPEG antes do upload corta o
//  tamanho em ~10-20x sem perda visível no app.
// ============================================================
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
