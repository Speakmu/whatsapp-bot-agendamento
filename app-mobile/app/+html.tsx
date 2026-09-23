import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// Documento raiz da versão web (só afeta o export web, nunca o app nativo).
// Sem isso, abrir o link do WhatsApp sempre cai numa aba normal do
// navegador — pra abrir em tela cheia (sem barra de endereço) é preciso um
// manifest.json ligado aqui, e o cliente precisa "Adicionar à tela
// inicial". Esses três metas cobrem Android (via manifest) e iOS (que
// ignora o manifest e usa suas próprias tags).
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="pt-br">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="theme-color" content="#ff5200" />
        <link rel="manifest" href="/manifest.json" />
        {/* iOS Safari não lê manifest.json pra "Adicionar à Tela de Início" — precisa dessas tags específicas */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Lileamar" />
        <link rel="apple-touch-icon" href="/icons/icon-512.png" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
