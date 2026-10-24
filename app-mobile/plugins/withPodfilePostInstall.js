// @react-native-firebase (SDKs em XCFrameworks estaticos) + useFrameworks:'static'
// do expo-build-properties gera um erro de build no iOS:
//   "include of non-modular header inside framework module 'RNFBApp...'"
// porque os headers do React-Core (RCTConvert.h, RCTBridgeModule.h etc.) nao
// sao expostos como modulo Clang "modular". A correcao oficial (doc do
// react-native-firebase) e permitir includes nao-modulares dentro de modulos
// de framework, via build setting no Podfile. Projeto e "managed" (sem pasta
// ios/ versionada, gerada de novo a cada build), entao isso precisa ser um
// config plugin em vez de editar o Podfile direto.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SNIPPET = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
      end
    end
`;

module.exports = function withPodfilePostInstall(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf-8');

      // O podspec do react-native-firebase tem sua PROPRIA chave pra decidir
      // se ele mesmo vira framework estatico (s.static_framework), lida de
      // uma variavel global do Ruby — independente do use_frameworks:static
      // do resto do projeto (expo-build-properties). Por padrao fica 'false',
      // ou seja: o resto do projeto compila estatico, mas o Firebase
      // continua dinamico — essa mistura embaixo do mesmo use_frameworks! e
      // a causa real dos erros de "modulo dono" (RCTPromiseRejectBlock,
      // RCT_EXTERN etc.) entre RNFBApp/RNFBMessaging e o React-Core.
      // Precisa ser setada ANTES do Podfile resolver os pods, por isso vai
      // no topo do arquivo, nao no post_install.
      if (!contents.includes('$RNFirebaseAsStaticFramework')) {
        contents = `$RNFirebaseAsStaticFramework = true\n${contents}`;
      }

      if (!contents.includes('CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES')) {
        contents = contents.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|\n${SNIPPET}`
        );
      }

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
};
