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
      # @react-native-firebase/* (RNFBApp, RNFBMessaging, RNFBAuth...) nao
      # entram na lista de pods que a Expo ja modulariza sozinha com
      # use_frameworks:static — cada um importa RCTPromiseRejectBlock (do
      # React-Core) por fora de um modulo Clang proprio, e o compilador
      # reclama "must be imported from module X before it is required"
      # porque dois pods RNFB diferentes "disputam" a mesma declaracao.
      # Forcar DEFINES_MODULE/CLANG_ENABLE_MODULES neles resolve a
      # ambiguidade, igual a Expo ja faz pros pods dela.
      if target.name.start_with?('RNFB')
        target.build_configurations.each do |config|
          config.build_settings['DEFINES_MODULE'] = 'YES'
          config.build_settings['CLANG_ENABLE_MODULES'] = 'YES'
        end
      end
    end
`;

module.exports = function withPodfilePostInstall(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf-8');
      if (!contents.includes('CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES')) {
        contents = contents.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|\n${SNIPPET}`
        );
        fs.writeFileSync(podfilePath, contents);
      }
      return config;
    },
  ]);
};
